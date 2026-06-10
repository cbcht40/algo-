// Master/follower roster. Every configured account forms a pool; ONE is the
// master, the rest are followers. The chosen master can be changed from the
// dashboard at runtime (persisted to .copier-master.json) and is applied on the
// next (re)start — switching is done while flat, so a clean restart is simplest.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AccountConfig, Config, FollowerConfig } from "./config";

const MASTER_FILE = resolve(process.env.COPIER_MASTER_STATE || ".copier-master.json");

const specOf = (a: AccountConfig): string => a.accountSpec || a.label;

/** Every configured account (master + followers) as a flat pool. */
export function accountPool(cfg: Config): AccountConfig[] {
  return [cfg.master, ...cfg.followers];
}

/** The accountSpec currently chosen as master: env > saved file > config default. */
export function currentMasterSpec(cfg: Config): string {
  const fromEnv = process.env.COPIER_MASTER?.trim();
  if (fromEnv) return fromEnv;
  try {
    const saved = JSON.parse(readFileSync(MASTER_FILE, "utf8"))?.masterSpec;
    if (saved) return String(saved);
  } catch {
    /* no saved selection yet */
  }
  return specOf(cfg.master);
}

/** Persist a new master choice (applied on next (re)start). */
export function setMasterSpec(spec: string): void {
  writeFileSync(MASTER_FILE, JSON.stringify({ masterSpec: spec }, null, 2));
}

/** Is `spec` one of the configured accounts? (guards the dashboard endpoint) */
export function isKnownSpec(cfg: Config, spec: string): boolean {
  return accountPool(cfg).some((a) => specOf(a) === spec);
}

/** Build the effective master + followers from the pool and the chosen master. */
export function resolveRoster(cfg: Config): {
  master: AccountConfig;
  followers: FollowerConfig[];
  masterSpec: string;
} {
  const all = accountPool(cfg);
  const wanted = currentMasterSpec(cfg);
  const master = all.find((a) => specOf(a) === wanted) ?? cfg.master;
  // The ex-master keeps no multiplier (defaults to 1); existing followers keep theirs.
  const followers: FollowerConfig[] = all
    .filter((a) => a !== master)
    .map((a) => ({ multiplier: 1, symbolMap: {}, ...a }));
  return { master, followers, masterSpec: specOf(master) };
}
