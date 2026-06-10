// Tiny on-disk token cache so restarts don't need a fresh paste/login.
//
// While the copier runs it renews tokens every ~75 min; persisting the latest
// one means a restart (reboot, crash, update) can resume the same session as
// long as the saved token is still valid — and in credentials mode the client
// can mint a brand-new one anyway.
//
// File: .tradovate-tokens.json (gitignored, chmod 600).
import { readFileSync, writeFileSync, chmodSync } from "node:fs";

export interface StoredToken {
  accessToken: string;
  expirationTime: string; // ISO
  userId: number;
}

const FILE = ".tradovate-tokens.json";

function loadAll(): Record<string, StoredToken> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Latest valid token for this login key, or undefined if absent/expiring. */
export function getStoredToken(key: string): StoredToken | undefined {
  const t = loadAll()[key];
  if (!t?.accessToken || !t.expirationTime) return undefined;
  // Worthless if it expires in the next 2 minutes.
  if (new Date(t.expirationTime).getTime() < Date.now() + 2 * 60_000) return undefined;
  return t;
}

export function storeToken(key: string, token: StoredToken): void {
  const all = loadAll();
  all[key] = {
    accessToken: token.accessToken,
    expirationTime: token.expirationTime,
    userId: token.userId,
  };
  writeFileSync(FILE, JSON.stringify(all, null, 2));
  try {
    chmodSync(FILE, 0o600);
  } catch {
    // best effort — not fatal on exotic filesystems
  }
}

/** Decode a JWT's claims without verifying (we only need sub/exp locally). */
export function jwtClaims(token: string): { sub?: string; exp?: number } {
  try {
    const payload = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}
