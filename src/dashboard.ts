// Local web dashboard for the copier — served on its own port (127.0.0.1:7879),
// kept separate from the extension bridge (7878). Read-only for now:
//   GET  /            -> the dashboard page (static HTML)
//   GET  /api/state   -> per-account snapshot (connected/disconnected, multiplier)
//   GET  /api/events  -> live order-copy log (Server-Sent Events stream)
import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { logger } from "./logger";
import type { CopierEngine, CopyEvent } from "./copier/engine";
import { importRange, listAccounts } from "./journalSync";

const log = logger("dashboard");

// Read the page once at startup (zero build step — it's a single static file).
const PAGE = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

const MAX_RECENT = 200;

export function startDashboard(engine: CopierEngine, port = 7879, license = ""): void {
  // Ring buffer of recent copy events so a freshly-opened page isn't empty,
  // plus the set of live SSE clients to fan each new event out to.
  const recent: CopyEvent[] = [];
  const clients = new Set<ServerResponse>();

  engine.onCopyEvent((e) => {
    recent.push(e);
    if (recent.length > MAX_RECENT) recent.shift();
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(frame);
  });

  const server = createServer((req, res) => {
    // CORS so the website (let-tradejournal.com) can reach the journal endpoints,
    // including the Private-Network-Access preflight (HTTPS page → 127.0.0.1).
    const origin = req.headers.origin || "";
    if (origin === "https://let-tradejournal.com" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/state")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(engine.dashboardState()));
      return;
    }

    // Arm/disarm the copier (the dashboard ON/OFF switch).
    if (req.method === "POST" && req.url?.startsWith("/api/active")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let on = false;
        try {
          on = !!JSON.parse(body || "{}").active;
        } catch {
          /* malformed body → stay disarmed */
        }
        engine.setActive(on);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ active: on }));
      });
      return;
    }

    // Choose the master account (persisted; applied on the next copier restart).
    if (req.method === "POST" && req.url?.startsWith("/api/master")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let spec = "";
        try {
          spec = String(JSON.parse(body || "{}").masterSpec || "");
        } catch {
          /* malformed body */
        }
        const result = engine.requestMaster(spec);
        res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      });
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      // Replay the recent log (oldest first) so the page shows history on open.
      for (const e of recent) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write(": connected\n\n");
      clients.add(res);
      // Keep the connection alive through idle periods / proxies.
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    // ── Website on-demand import (the "Importer automatiquement" button) ──
    if (req.method === "GET" && req.url?.startsWith("/api/journal/accounts")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hasLicense: !!license, accounts: listAccounts(engine) }));
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/api/journal/import")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let accountId: number | undefined;
        let sinceMs = 0;
        let untilMs = Date.now();
        try {
          const b = JSON.parse(body || "{}");
          if (b.accountId != null && b.accountId !== "") accountId = Number(b.accountId);
          if (b.start) sinceMs = Date.parse(`${b.start}T00:00:00Z`);
          if (b.end) untilMs = Date.parse(`${b.end}T23:59:59Z`);
        } catch {
          /* malformed body → import the full window for all accounts */
        }
        if (!license) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Pas de licence configurée dans le Copieur." }));
          return;
        }
        try {
          const result = await importRange(engine, license, { accountId, sinceMs, untilMs });
          res.writeHead(result.error ? 502 : 200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // A busy port shouldn't take the whole copier down.
  server.on("error", (err) => log.warn(`Dashboard disabled: ${String(err)}`));
  server.listen(port, "127.0.0.1", () =>
    log.info(`Dashboard on http://127.0.0.1:${port}`),
  );
}
