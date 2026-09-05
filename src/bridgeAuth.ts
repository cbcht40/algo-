// Sécurité du pont local (127.0.0.1:7878).
//
// Menace : n'importe quelle page web ouverte dans le navigateur peut tenter un POST vers
// 127.0.0.1 (requête « simple », pas de préflight). Sans contrôle, une page malveillante
// pourrait pousser un faux ordre relayé. Deux verrous :
//   1. Origine : seules trader.tradovate.com (content script) et les extensions
//      (chrome-extension:// / moz-extension://) sont acceptées ; une requête SANS Origin
//      (curl, autre process) n'est acceptée qu'avec la clé.
//   2. Clé d'appairage : générée une fois, persistée (.copier-bridge.json, chmod 600),
//      remise à l'extension via GET /pair (réservé aux origines extension) et exigée dans
//      le corps JSON (`key`) de tout POST.
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage } from "node:http";

const FILE = resolve(process.env.COPIER_BRIDGE_STATE || ".copier-bridge.json");
let cached: string | undefined;

/** Clé d'appairage stable (créée au premier appel). */
export function bridgeKey(): string {
  if (cached) return cached;
  try {
    const k = JSON.parse(readFileSync(FILE, "utf8"))?.key;
    if (typeof k === "string" && k.length >= 24) { cached = k; return k; }
  } catch { /* pas encore de clé */ }
  const k = randomBytes(24).toString("base64url");
  try {
    writeFileSync(FILE, JSON.stringify({ key: k, createdAt: new Date().toISOString() }, null, 2));
    try { chmodSync(FILE, 0o600); } catch { /* fs exotique */ }
  } catch { /* lecture seule : clé volatile pour cette session */ }
  cached = k;
  return k;
}

export type OriginClass = "extension" | "tradovate" | "none" | "other";

export function classifyOrigin(req: IncomingMessage): OriginClass {
  const o = String(req.headers.origin || "").toLowerCase();
  if (!o || o === "null") return "none";
  if (o.startsWith("chrome-extension://") || o.startsWith("moz-extension://") || o.startsWith("safari-web-extension://")) return "extension";
  if (/^https:\/\/([a-z0-9-]+\.)*tradovate\.com$/.test(o)) return "tradovate";
  return "other";
}

/** Un POST est autorisé si l'origine est de confiance ET (origine extension OU clé valide) ;
 *  sans Origin (client non-navigateur) la clé est obligatoire. */
export function postAllowed(req: IncomingMessage, bodyKey: unknown): { ok: boolean; why?: string } {
  const cls = classifyOrigin(req);
  const key = typeof bodyKey === "string" ? bodyKey : "";
  const keyOk = key.length > 0 && key === bridgeKey();
  if (cls === "other") return { ok: false, why: "origine non autorisée" };
  if (cls === "extension") return { ok: true };
  if (keyOk) return { ok: true };
  return { ok: false, why: cls === "tradovate" ? "clé d'appairage absente ou invalide" : "clé requise" };
}

/** GET /pair : uniquement depuis une extension (ou avec la clé déjà connue). */
export function pairAllowed(req: IncomingMessage): boolean {
  return classifyOrigin(req) === "extension";
}

/** En-têtes CORS/PNA communs (l'origine renvoyée = celle de la requête si de confiance). */
export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const cls = classifyOrigin(req);
  const origin = cls === "extension" || cls === "tradovate" ? String(req.headers.origin) : "null";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
