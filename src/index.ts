import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { startSetup } from "./setup";
import { CopierEngine } from "./copier/engine";
import { GroupEngine } from "./copier/group";
import { startBridge } from "./bridge";
import { startDashboard } from "./dashboard";
import { startDashboardMirror } from "./dashboardMirror";
import { LicenseGate } from "./license";
import { logger, setLogLevel } from "./logger";

const log = logger("main");

async function main() {
  const configPath = resolve(process.argv[2] ?? process.env.COPIER_CONFIG ?? "config.json");
  if (process.env.LOG_LEVEL) setLogLevel(process.env.LOG_LEVEL as any);

  // Fresh install (no config) → run the onboarding/setup server instead of the
  // copier. It writes config.json once the user finishes, then exits so the
  // Electron app (watching config.json) restarts into the copier.
  if (process.env.COPIER_SETUP === "1" || !existsSync(configPath)) {
    log.info("Aucune configuration — démarrage de l'assistant de configuration.");
    startSetup({ configPath });
    return;
  }

  const cfg = loadConfig(configPath);
  log.info(`Loaded config from ${configPath} (mode ${cfg.mode})`);

  if (cfg.environment === "live" && !cfg.dryRun) {
    log.warn("⚠️  LIVE environment with dryRun=false — real orders will be sent.");
  }

  // Deux moteurs :
  //   sync   → GroupEngine : panneau d'ordre unique, tous les comptes en parallèle (défaut)
  //   mirror → CopierEngine : maître recopié sur des followers (historique)
  const engine = cfg.mode === "mirror" ? new CopierEngine(cfg) : new GroupEngine(cfg);
  engine.setPersistPath(configPath);
  const gate = new LicenseGate();
  engine.setLicenseGate(gate);

  const shutdown = async (signal: string) => {
    log.warn(`Received ${signal}, shutting down…`);
    gate.stop();
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Bring the bridge up first so the Let Trade Copieur extension can feed fresh tokens
  // even while logins connect — or revive ones whose config token had expired.
  if (process.env.BRIDGE !== "off") {
    try {
      startBridge(engine, Number(process.env.BRIDGE_PORT) || 7878);
    } catch (err) {
      log.warn(`Could not start extension bridge: ${String(err)}`);
    }
  }

  // Local web dashboard (own port, separate from the extension bridge).
  if (process.env.DASHBOARD !== "off") {
    try {
      const port = Number(process.env.DASHBOARD_PORT) || 7879;
      if (engine instanceof GroupEngine) startDashboard(engine, port);
      else startDashboardMirror(engine, port);
    } catch (err) {
      log.warn(`Could not start dashboard: ${String(err)}`);
    }
  }

  // Verify the Edge entitlement before going live (and re-check periodically).
  // Trading stays locked until a valid Edge license is confirmed; the dashboard
  // and account/position views still work.
  await gate.start(cfg.license || process.env.COPIER_LICENSE);

  await engine.start();
}

main().catch((err) => {
  log.error(`Fatal: ${err?.stack ?? String(err)}`);
  process.exit(1);
});
