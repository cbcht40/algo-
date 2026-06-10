// Onboarding / setup server. Runs when there's no config yet (fresh install):
// the user pastes their Edge license, the Let Trade Copieur extension pushes session
// tokens over the same 127.0.0.1:7878 bridge, we DISCOVER each login's accounts,
// the user picks the master, and we write config.json — then the process exits so
// the Electron app (watching config.json) restarts into the copier. No terminal.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";
import { verifyLicense } from "./license";
import { TradovateClient } from "./tradovate/client";
import { jwtClaims } from "./tradovate/tokenStore";
import type { Environment } from "./tradovate/types";

const log = logger("setup");
const PAGE = readFileSync(new URL("./onboarding.html", import.meta.url), "utf8");

// The Let Trade Copieur extension folder ships next to the bundle (one level up from src/
// in dev, from build/ when packaged). Revealed in the file manager so the user
// can "Load unpacked" it into Chrome.
const EXT_DIR = (() => {
  try {
    return fileURLToPath(new URL("../extension", import.meta.url));
  } catch {
    return "";
  }
})();

function revealExtension(): void {
  if (!EXT_DIR) return;
  const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    spawn(cmd, [EXT_DIR], { detached: true, stdio: "ignore" }).unref();
  } catch (err) {
    log.warn(`Impossible d'ouvrir le dossier de l'extension : ${String(err)}`);
  }
}

interface DiscoveredLogin {
  sub: string;
  token: string;
  env: Environment;
  accounts: string[];
}

interface SetupOptions {
  configPath: string;
  dashboardPort?: number;
  bridgePort?: number;
}

export function startSetup(opts: SetupOptions): void {
  const dashboardPort = opts.dashboardPort ?? (Number(process.env.DASHBOARD_PORT) || 7879);
  const bridgePort = opts.bridgePort ?? (Number(process.env.BRIDGE_PORT) || 7878);
  const configPath = resolve(opts.configPath);

  const logins = new Map<string, DiscoveredLogin>();
  const discovering = new Set<string>();
  let license = { key: "", unlocked: false, plan: "", email: "", error: "" };

  // Validate a session token by connecting and reading its accounts (demo then live).
  async function discover(token: string): Promise<void> {
    const sub = jwtClaims(token).sub;
    if (!sub || logins.has(sub) || discovering.has(sub)) return;
    discovering.add(sub);
    try {
      for (const env of ["demo", "live"] as Environment[]) {
        const c = new TradovateClient({
          label: "setup",
          environment: env,
          appId: "MacCopier",
          appVersion: "0.1",
          accessToken: token,
        });
        try {
          await c.start();
          const accts = c.accounts.map((a) => a.name);
          await c.stop();
          if (accts.length) {
            logins.set(sub, { sub, token, env, accounts: accts });
            log.info(`Découvert ${accts.length} compte(s) [${env}] : ${accts.join(", ")}`);
            return;
          }
        } catch {
          await c.stop();
        }
      }
      log.warn(`Token reçu mais aucun compte (sub ${sub}).`);
    } finally {
      discovering.delete(sub);
    }
  }

  // --- bridge (7878): the Let Trade Copieur extension pushes session tokens here ---
  const bridge = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    if (req.method === "GET" && req.url?.startsWith("/status")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ running: true, setup: true, logins: logins.size }));
    }
    if (req.method === "POST" && req.url?.startsWith("/token")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const token = String(JSON.parse(body || "{}").token ?? "");
          if (token) void discover(token);
        } catch {
          /* ignore */
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  bridge.on("error", (err) => log.warn(`Bridge setup indisponible : ${String(err)}`));
  bridge.listen(bridgePort, "127.0.0.1", () => log.info(`Bridge setup sur 127.0.0.1:${bridgePort}`));

  const state = () => ({
    mode: "setup",
    license: { unlocked: license.unlocked, plan: license.plan, email: license.email, error: license.error, hasKey: !!license.key },
    accounts: [...logins.values()].flatMap((l) => l.accounts.map((name) => ({ name, env: l.env }))),
  });

  function buildConfig(masterSpec: string, dryRun: boolean) {
    const all = [...logins.values()].flatMap((l) => l.accounts.map((name) => ({ name, login: l })));
    const master = all.find((a) => a.name === masterSpec) ?? all[0];
    if (!master) throw new Error("aucun compte à configurer");
    const followers = all
      .filter((a) => a !== master)
      .map((a) => ({
        label: a.name,
        accountSpec: a.name,
        multiplier: 1,
        accessToken: a.login.token,
        ...(a.login.env !== master.login.env ? { environment: a.login.env } : {}),
      }));
    return {
      environment: master.login.env,
      appId: "MacCopier",
      appVersion: "0.1",
      dryRun,
      license: license.key,
      auth: { mode: "credentials" },
      master: { label: master.name, accountSpec: master.name, accessToken: master.login.token },
      followers,
    };
  }

  // --- setup UI + API (dashboard port) ---
  const server = createServer((req, res) => {
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(PAGE);
    }
    // Let the Electron "wait for dashboard" probe succeed in setup mode too.
    if (req.method === "GET" && req.url?.startsWith("/api/state")) return void json(200, { setup: true });
    if (req.method === "GET" && req.url?.startsWith("/api/setup")) return void json(200, state());

    if (req.method === "POST" && req.url?.startsWith("/api/extension")) {
      revealExtension();
      return void json(200, { ok: true, path: EXT_DIR });
    }

    if (req.method === "POST" && req.url?.startsWith("/api/license")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        let key = "";
        try {
          key = String(JSON.parse(body || "{}").key || "").trim();
        } catch {
          /* */
        }
        const r = await verifyLicense(key);
        license = {
          key,
          unlocked: !!r.unlocked,
          plan: r.plan ?? "",
          email: r.email ?? "",
          error: r.unlocked ? "" : r.error || "clé invalide",
        };
        json(200, state().license);
      });
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/api/save")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const { masterSpec, dryRun } = JSON.parse(body || "{}");
          if (!license.unlocked) return void json(403, { ok: false, error: "licence Edge requise" });
          if (!logins.size) return void json(400, { ok: false, error: "aucun compte connecté" });
          const config = buildConfig(String(masterSpec || ""), !!dryRun);
          writeFileSync(configPath, JSON.stringify(config, null, 2));
          log.info(`Config écrite → ${configPath} (maître ${config.master.label}, ${config.followers.length} follower(s)). Redémarrage…`);
          json(200, { ok: true });
          // Exit so the Electron app (watching config.json) restarts into copier mode.
          setTimeout(() => process.exit(0), 400);
        } catch (err) {
          json(500, { ok: false, error: String(err) });
        }
      });
      return;
    }

    res.writeHead(404).end();
  });
  server.on("error", (err) => log.warn(`Serveur setup indisponible : ${String(err)}`));
  server.listen(dashboardPort, "127.0.0.1", () =>
    log.info(`Assistant de configuration sur http://127.0.0.1:${dashboardPort}`),
  );
}
