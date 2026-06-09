type Level = "debug" | "info" | "warn" | "error";

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
