// Pont HTTP local pour l'extension navigateur — 127.0.0.1 uniquement, verrouillé par
// origine + clé d'appairage (voir bridgeAuth.ts).
//
//   GET  /pair                        -> { key }   (origine extension seulement)
//   POST /token  { token, key }       -> route le token de session vers son login
//   POST /ping   { key }              -> battement de cœur de l'extension (indicateur)
//   POST /relay  RelayMessage + key   -> ordre intercepté dans le navigateur (mode sync)
//   GET  /status                      -> { running, logins: [...] }  (origine extension)
import { createServer } from "node:http";
import { logger } from "./logger";
import { bridgeKey, corsHeaders, pairAllowed, postAllowed } from "./bridgeAuth";
import type { RelayMessage } from "./copier/group";

const log = logger("bridge");

/** Ce que le pont attend d'un moteur (mirror ou sync). */
export interface TokenSink {
  ingestToken(token: string): Promise<{ ok: boolean; login?: string; acted?: boolean; error?: string }>;
  status(): Array<{ label: string; userId: number; ready: boolean; sub?: string }>;
  /** Mode sync seulement : relais d'un ordre intercepté dans le navigateur. */
  relay?(msg: RelayMessage): Promise<{ ok: boolean; note?: string }>;
  noteExtension?(): void;
}

export function startBridge(engine: TokenSink, port = 7878): void {
  bridgeKey(); // crée la clé au démarrage (fichier .copier-bridge.json)
  let deniedLogged = 0;

  const server = createServer((req, res) => {
    for (const [k, v] of Object.entries(corsHeaders(req))) res.setHeader(k, v);
    const json = (code: number, obj: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (req.method === "GET" && req.url?.startsWith("/pair")) {
      if (!pairAllowed(req)) return void json(403, { ok: false, error: "pairing reserved to the extension" });
      return void json(200, { ok: true, key: bridgeKey() });
    }

    if (req.method === "GET" && req.url?.startsWith("/status")) {
      if (!pairAllowed(req)) return void json(403, { ok: false, error: "forbidden" });
      return void json(200, { running: true, relay: typeof engine.relay === "function", logins: engine.status() });
    }

    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let p: Record<string, any> = {};
      try { p = JSON.parse(body || "{}") ?? {}; } catch { return void json(400, { ok: false, error: "invalid json" }); }
      const auth = postAllowed(req, p.key);
      if (!auth.ok) {
        if (deniedLogged++ < 5) log.warn(`Requête refusée sur ${req.url} (${auth.why}, origine ${String(req.headers.origin || "aucune")})`);
        return void json(403, { ok: false, error: "unauthorized", why: auth.why });
      }

      if (req.url?.startsWith("/token")) {
        const token = String(p.token ?? "");
        if (!token) return void json(400, { ok: false, error: "missing token" });
        engine.noteExtension?.();
        try {
          const result = await engine.ingestToken(token);
          if (result.ok && result.acted) log.info(`Login activated from extension → ${result.login}.`);
          else if (!result.ok) log.debug(`Token rejected: ${result.error}`);
          return void json(result.ok ? 200 : 409, result);
        } catch (err) {
          return void json(400, { ok: false, error: String(err) });
        }
      }

      // Battement de cœur de l'extension (toutes les minutes, même sans rien à dire) : il
      // alimente l'indicateur « extension vue il y a … » et distingue une extension muette
      // d'une session Tradovate expirée.
      if (req.url?.startsWith("/ping")) {
        engine.noteExtension?.();
        const logins = engine.status();
        return void json(200, { ok: true, ready: logins.filter((l) => l.ready).length, logins: logins.length });
      }

      if (req.url?.startsWith("/relay")) {
        if (typeof engine.relay !== "function") return void json(501, { ok: false, error: "relay unsupported in this mode" });
        // On répond TOUT DE SUITE : le navigateur n'attend pas la fin du relais.
        json(202, { ok: true });
        try {
          const r = await engine.relay(p as RelayMessage);
          if (!r.ok && r.note && !/ignoré|inconnu|hors|doublon/.test(r.note)) log.warn(`Relais : ${r.note}`);
        } catch (err) {
          log.warn(`Relais : message invalide (${String(err)})`);
        }
        return;
      }

      res.writeHead(404); res.end();
    });
  });

  server.on("error", (err) => log.warn(`Extension bridge disabled: ${String(err)}`));
  server.listen(port, "127.0.0.1", () =>
    log.info(`Extension bridge listening on http://127.0.0.1:${port} (Let Trade Copieur, verrouillé par clé d'appairage)`),
  );
}
