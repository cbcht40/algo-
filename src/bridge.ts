// Pont HTTP local pour l'extension navigateur — 127.0.0.1 uniquement.
//
//   POST /token   { "token": "<jwt>" }        -> route le token de session vers son login
//   POST /relay   RelayMessage (JSON)          -> ordre intercepté dans le navigateur (mode sync)
//   GET  /status                               -> { running, logins: [...] }
import { createServer } from "node:http";
import { logger } from "./logger";
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
  const server = createServer((req, res) => {
    // L'extension vit sur une origine chrome-extension:// ; le content script peut aussi
    // appeler en direct depuis trader.tradovate.com (loopback = contexte sûr). Les en-têtes
    // « Private Network Access » évitent le blocage Chrome des requêtes vers le réseau local.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/status")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: true, relay: typeof engine.relay === "function", logins: engine.status() }));
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/token")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const token = String(JSON.parse(body || "{}").token ?? "");
          if (!token) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "missing token" }));
            return;
          }
          engine.noteExtension?.();
          const result = await engine.ingestToken(token);
          if (result.ok && result.acted) log.info(`Login activated from extension → ${result.login}.`);
          else if (!result.ok) log.debug(`Token rejected: ${result.error}`);
          res.writeHead(result.ok ? 200 : 409, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/relay")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        if (typeof engine.relay !== "function") {
          res.writeHead(501, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "relay unsupported in this mode" }));
          return;
        }
        // On répond TOUT DE SUITE : le navigateur n'attend pas la fin du relais.
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        try {
          const msg = JSON.parse(body || "{}") as RelayMessage;
          const r = await engine.relay(msg);
          if (!r.ok && r.note && !/ignoré|inconnu|hors|doublon/.test(r.note)) log.warn(`Relais : ${r.note}`);
        } catch (err) {
          log.warn(`Relais : message invalide (${String(err)})`);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.on("error", (err) => log.warn(`Extension bridge disabled: ${String(err)}`));
  server.listen(port, "127.0.0.1", () =>
    log.info(`Extension bridge listening on http://127.0.0.1:${port} (Let Trade Copieur)`),
  );
}
