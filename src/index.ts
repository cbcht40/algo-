import { resolve } from "node:path";
import { loadConfig } from "./config";
import { CopierEngine } from "./copier/engine";
import { startBridge } from "./bridge";
import { logger, setLogLevel } from "./logger";

const log = logger("main");

async function main() {
  const configPath = resolve(process.argv[2] ?? process.env.COPIER_CONFIG ?? "config.json");
  if (process.env.LOG_LEVEL) setLogLevel(process.env.LOG_LEVEL as any);

  const cfg = loadConfig(configPath);
  log.info(`Loaded config from ${configPath}`);

  if (cfg.environment === "live" && !cfg.dryRun) {
    log.warn("⚠️  LIVE environment with dryRun=false — real orders will be sent.");
  }

  const engine = new CopierEngine(cfg);

  const shutdown = async (signal: string) => {
    log.warn(`Received ${signal}, shutting down…`);
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Bring the bridge up first so the Copilink extension can feed fresh tokens
  // even while logins connect — or revive ones whose config token had expired.
  if (process.env.BRIDGE !== "off") {
    try {
      startBridge(engine, Number(process.env.BRIDGE_PORT) || 7878);
    } catch (err) {
      log.warn(`Could not start extension bridge: ${String(err)}`);
    }
  }

  await engine.start();
}

main().catch((err) => {
  log.error(`Fatal: ${err?.stack ?? String(err)}`);
  process.exit(1);
});
