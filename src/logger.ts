import { appendFileSync, renameSync, statSync } from "node:fs";

type Level = "debug" | "info" | "warn" | "error";

// --- observability: in-memory ring + best-effort log file --------------------
// Every emitted line is kept (plain, no ANSI) in a bounded ring for the dashboard
// « Journal technique » panel, and appended to COPIER_LOG_FILE if set (survives a
// Finder-launched app, where stdout is lost). Logging must NEVER crash the engine.
const RING_MAX = 600;
const ring: string[] = [];
const LOG_FILE = process.env.COPIER_LOG_FILE || "";
const FILE_MAX_BYTES = 2_000_000; // ~2 MB then roll once to .1

function record(line: string): void {
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();
  if (!LOG_FILE) return;
  try {
    try {
      if (statSync(LOG_FILE).size > FILE_MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch { /* file may not exist yet */ }
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* disk full / no perms — swallow */ }
}

/** Recent log lines (oldest→newest) for the dashboard « Journal technique » panel. */
export function recentLogs(limit = RING_MAX): string[] {
  return limit >= ring.length ? ring.slice() : ring.slice(ring.length - limit);
}

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

let minLevel: Level = (process.env.LOG_LEVEL as Level) || "info";
const order: Level[] = ["debug", "info", "warn", "error"];

function should(level: Level): boolean {
  return order.indexOf(level) >= order.indexOf(minLevel);
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
  if (!should(level)) return;
  const tail = extra === undefined ? "" : " " + (typeof extra === "string" ? extra : JSON.stringify(extra));
  // Plain (no ANSI) copy for the ring buffer + log file.
  record(`${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`);
  const head = `${COLORS[level]}${ts()} ${level.toUpperCase().padEnd(5)}${RESET} [${scope}]`;
  if (extra !== undefined) {
    console.log(head, msg, typeof extra === "string" ? extra : JSON.stringify(extra));
  } else {
    console.log(head, msg);
  }
}

export function setLogLevel(level: Level) {
  minLevel = level;
}

/** A scoped logger so every line is tagged with the account/component it came from. */
export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => emit("debug", scope, msg, extra),
    info: (msg: string, extra?: unknown) => emit("info", scope, msg, extra),
    warn: (msg: string, extra?: unknown) => emit("warn", scope, msg, extra),
    error: (msg: string, extra?: unknown) => emit("error", scope, msg, extra),
  };
}

export type Logger = ReturnType<typeof logger>;
