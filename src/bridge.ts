// Tiny localhost HTTP bridge so the browser extension can push fresh session
// tokens into the running copier — zero copy-paste. Bound to 127.0.0.1 only.
//
//   POST /token   { "token": "<jwt>" }   -> routes it to the matching login
//   GET  /status                         -> { running, logins: [...] }
import { createServer } from "node:http";
import { logger } from "./logger";
import type { CopierEngine } from "./copier/engine";

const log = logger("bridge");

export function startBridge(engine: CopierEngine, port = 7878): void {
  const server = createServer((req, res) => {
    // The extension lives on a chrome-extension:// origin; allow it.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/status")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: true, logins: engine.status() }));
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

    res.writeHead(404);
    res.end();
  });

  // A busy port (e.g. a second copier) shouldn't take the whole app down.
  server.on("error", (err) => log.warn(`Extension bridge disabled: ${String(err)}`));
  server.listen(port, "127.0.0.1", () =>
    log.info(`Extension bridge listening on http://127.0.0.1:${port} (Copilink)`),
  );
}
