// Tableau de bord local du mode SYNC — servi sur 127.0.0.1:7879 (l'extension parle au
// pont 7878). Une page statique + une petite API JSON + un flux SSE pour le journal.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { logger, recentLogs } from "./logger";
import type { GroupEngine, GroupEvent } from "./copier/group";

const log = logger("dashboard");

// Read the page once at startup (zero build step — it's a single static file).
const PAGE = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");
// Mini-fenêtre flottante « avis IA » (Electron) — même origine que le dashboard (pas de CORS).
let PILL = "";
try { PILL = readFileSync(new URL("./pill.html", import.meta.url), "utf8"); } catch { /* absente en mode mirror */ }

// Librairie de graphique servie en local (fonctionne hors ligne) : copiée dans build/ par
// scripts/bundle.mjs pour l'app empaquetée, sinon lue depuis node_modules en dev.
function loadVendorChart(): string {
  const candidates = [
    new URL("./lightweight-charts.js", import.meta.url),
    new URL("../node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js", import.meta.url),
  ];
  for (const u of candidates) {
    try { return readFileSync(u, "utf8"); } catch { /* suivant */ }
  }
  log.warn("Librairie de graphique introuvable (lightweight-charts) — le graphique sera désactivé.");
  return "";
}
const VENDOR_CHART = loadVendorChart();

const MAX_RECENT = 200;

function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}") ?? {}); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

export function startDashboard(engine: GroupEngine, port = 7879): void {
  const recent: GroupEvent[] = [];
  const clients = new Set<ServerResponse>();

  engine.onEvent((e) => {
    recent.push(e);
    if (recent.length > MAX_RECENT) recent.shift();
    const frame = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of clients) res.write(frame);
  });

  const server = createServer((req, res) => {
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && path === "/pill") {
      res.writeHead(PILL ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PILL);
      return;
    }
    if (req.method === "GET" && path === "/api/state") {
      const w = url.searchParams.get("watch");
      if (w) engine.watch(w);
      return void json(200, engine.dashboardState());
    }
    if (req.method === "GET" && path === "/api/logs") return void json(200, { lines: recentLogs(300) });
    if (req.method === "GET" && path === "/vendor/lightweight-charts.js") {
      if (!VENDOR_CHART) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      res.end(VENDOR_CHART);
      return;
    }
    if (req.method === "GET" && path === "/api/chart") {
      const symbol = url.searchParams.get("symbol") || "";
      const tf = Number(url.searchParams.get("tf")) || 1;
      const r = engine.chartBars(symbol, tf);
      return void json(200, { ok: true, symbol: symbol.toUpperCase(), tf, ...r, quote: engine.quotes()[symbol.toUpperCase()] ?? null });
    }

    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      for (const e of recent) res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.write(": connected\n\n");
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    // Suggestions d'instruments (préfixe tapé) et résolution (tick, valeur du point).
    if (req.method === "GET" && path === "/api/contracts") {
      engine.suggest(url.searchParams.get("q") || "").then(
        (items) => json(200, { items }),
        (err) => json(500, { items: [], error: String(err) }),
      );
      return;
    }
    if (req.method === "GET" && path === "/api/instrument") {
      engine.resolveInstrument(url.searchParams.get("symbol") || "").then(
        (inst) => json(200, { ok: true, ...inst }),
        (err) => json(200, { ok: false, error: String((err as Error)?.message || err) }),
      );
      return;
    }

    if (req.method !== "POST") { res.writeHead(404); res.end(); return; }

    void readJson(req).then(async (p) => {
      try {
        switch (path) {
          case "/api/order": {
            const bracket = p.bracket && typeof p.bracket === "object"
              ? { stopTicks: num(p.bracket.stopTicks), targetTicks: num(p.bracket.targetTicks) }
              : undefined;
            const ev = await engine.placeGroupOrder({
              symbol: String(p.symbol || ""),
              action: p.action === "Sell" ? "Sell" : "Buy",
              qty: Number(p.qty),
              orderType: p.orderType === "Limit" ? "Limit" : p.orderType === "Stop" ? "Stop" : "Market",
              price: num(p.price),
              stopPrice: num(p.stopPrice),
              tif: p.tif === "GTC" ? "GTC" : "Day",
              bracket,
            });
            return json(200, ev);
          }
          case "/api/lock":
            engine.setLocked(!!p.locked);
            return json(200, { locked: engine.isLocked });
          case "/api/relay":
            engine.setRelay(!!p.enabled);
            return json(200, { enabled: engine.isRelayEnabled });
          case "/api/account": {
            if (p.multiplier !== undefined && typeof p.multiplier !== "number") return json(400, { ok: false, error: "Multiplicateur invalide (0 à 100)." });
            const r = engine.setAccountSettings(String(p.spec || ""), {
              ...(p.enabled !== undefined ? { enabled: !!p.enabled } : {}),
              ...(p.multiplier !== undefined ? { multiplier: p.multiplier } : {}),
            });
            return json(r.ok ? 200 : 400, r);
          }
          case "/api/remove": { const r = engine.removeAccount(String(p.spec || "")); return json(r.ok ? 200 : 400, r); }
          case "/api/restore": { const r = engine.restoreAccount(String(p.spec || "")); return json(r.ok ? 200 : 400, r); }
          case "/api/reorder": { const r = engine.reorderAccounts(Array.isArray(p.order) ? p.order.map(String) : []); return json(r.ok ? 200 : 400, r); }
          case "/api/refresh": { const r = await engine.refreshAccount(String(p.spec || "")); return json(r.ok || r.connected ? 200 : 400, r); }
          case "/api/rescan": return json(200, await engine.rescanAccounts());
          case "/api/flatten": return json(200, await engine.flatten(p.spec ? String(p.spec) : undefined));
          case "/api/cancel-all": return json(200, await engine.cancelOrders(p.spec ? String(p.spec) : undefined));
          case "/api/exits/modify": return json(200, await engine.modifyExits(String(p.key || ""), Number(p.price)));
          case "/api/exits/cancel": return json(200, await engine.cancelExits(String(p.key || "")));
          case "/api/exits/breakeven": return json(200, await engine.breakevenExits(String(p.key || ""), Math.max(0, Math.floor(Number(p.offsetTicks) || 0))));
          case "/api/exits/shift": return json(200, await engine.shiftExits(String(p.key || ""), Math.round(Number(p.ticks) || 0)));
          case "/api/journal/sync": return json(200, (await engine.journalSyncNow(true)) ?? { error: "journal non relié (clé de licence absente)" });
          case "/api/incidents/retry": return json(200, await engine.retryIncident(String(p.id || "")));
          case "/api/incidents/ignore": return json(200, engine.ignoreIncident(String(p.id || "")));
          default:
            res.writeHead(404); res.end();
        }
      } catch (err) {
        json(500, { ok: false, error: String((err as Error)?.message || err) });
      }
    });
  });

  server.on("error", (err) => log.warn(`Dashboard disabled: ${String(err)}`));
  server.listen(port, "127.0.0.1", () => log.info(`Dashboard on http://127.0.0.1:${port}`));
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
