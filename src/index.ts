import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config";
import { startSetup } from "./setup";
import { CopierEngine } from "./copier/engine";
import { startBridge } from "./bridge";
import { startDashboard } from "./dashboard";
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
  log.info(`Loaded config from ${configPath}`);

  if (cfg.environment === "live" && !cfg.dryRun) {
    log.warn("⚠️  LIVE environment with dryRun=false — real orders will be sent.");
  }

  const engine = new CopierEngine(cfg);
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
      startDashboard(engine, Number(process.env.DASHBOARD_PORT) || 7879);
    } catch (err) {
      log.warn(`Could not start dashboard: ${String(err)}`);
    }
  }

  // Verify the Edge entitlement before going live (and re-check periodically).
  // Copying stays locked until a valid Edge license is confirmed; the dashboard
  // and account/position views still work.
  await gate.start(cfg.license || process.env.COPIER_LICENSE);

  await engine.start();
}

main().catch((err) => {
  log.error(`Fatal: ${err?.stack ?? String(err)}`);
  process.exit(1);
});
