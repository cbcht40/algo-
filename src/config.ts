import { readFileSync } from "node:fs";
import type { Environment } from "./tradovate/types";

export interface AuthConfig {
  /** "credentials" = username+password per login; tokens are minted & renewed
   *  automatically (set-and-forget — no API key, no token pasting). */
  /** "token" = reuse a web-session token (works on prop-firm Eval accounts). */
  /** "apikey" = mint a token from credentials + an API key (needs API Access). */
  mode: "token" | "apikey" | "credentials";
  /** Token mode: default access token shared by all accounts under one login. */
  accessToken?: string;
  /** Credentials mode: optional API-key override (defaults to Tradovate's
   *  public sample pair, which works for username+password logins). */
  cid?: number;
  sec?: string;
  /** Optional host overrides if your web session talks to a non-default host. */
  restBase?: string;
  wsUrl?: string;
}

export interface AccountConfig {
  label: string;
  /** Account name as shown in Tradovate (the order "accountSpec"). */
  accountSpec?: string;
  /** Numeric account id. */
  accountId?: number;
  /** Per-account network override (e.g. a funded login on "live" while the
   *  master is on "demo"). Defaults to the global `environment`. */
  environment?: Environment;
  /** Token mode: per-account token override (for accounts on a different login). */
  accessToken?: string;
  /** API-key mode credentials. */
  name?: string;
  password?: string;
  cid?: number;
  sec?: string;
}

export interface FollowerConfig extends AccountConfig {
  /** Quantity multiplier vs the master order (e.g. 2 => double size). Default 1. */
  multiplier?: number;
  /** Optional per-follower symbol remap, e.g. { "MESU6": "ESU6" }. */
  symbolMap?: Record<string, string>;
  /** Copy onto this account? Unchecked in the dashboard => false. Default true.
   *  Disabled followers still receive cancels/modifies of already-copied orders. */
  enabled?: boolean;
}

export interface Config {
  environment: Environment;
  appId: string;
  appVersion: string;
  /** When true, log intended follower orders but never actually send them. */
  dryRun: boolean;
  /** Edge license key (copy-pasted from Let-Trade Journal). Unlocks copying. */
  license?: string;
  auth: AuthConfig;
  master: AccountConfig;
  followers: FollowerConfig[];
}

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `Could not read config at "${path}". Copy config.example.json to config.json and fill it in.`,
    );
  }

  const c = JSON.parse(raw) as Partial<Config>;
  const env = (c.environment ?? "demo") as Environment;
  if (env !== "demo" && env !== "live") {
    throw new Error(`environment must be "demo" or "live" (got "${env}").`);
  }

  const auth = c.auth;
  if (!auth || !["token", "apikey", "credentials"].includes(auth.mode)) {
    throw new Error('config.auth.mode must be "token", "apikey" or "credentials".');
  }
  if (auth.mode === "token" && !auth.accessToken) {
    // A per-account token is still allowed, but a shared one is the common case.
    const anyAccountHasToken =
      c.master?.accessToken || (c.followers ?? []).some((f) => f?.accessToken);
    if (!anyAccountHasToken) {
      throw new Error(
        "Token mode needs auth.accessToken (paste the token from your logged-in Tradovate web session).",
      );
    }
  }

  const checkAccount = (a: AccountConfig | undefined, where: string): AccountConfig => {
    if (!a) throw new Error(`Missing ${where} in config.`);
    if (!a.label) throw new Error(`Missing ${where}.label.`);
    if (a.environment && a.environment !== "demo" && a.environment !== "live") {
      throw new Error(`${where}.environment must be "demo" or "live" (got "${a.environment}").`);
    }
    if (auth.mode === "apikey") {
      if (!a.name) throw new Error(`Missing ${where}.name (login) for apikey mode.`);
      if (!a.password) throw new Error(`Missing ${where}.password for apikey mode.`);
      if (!a.cid) throw new Error(`Missing ${where}.cid (API key client id) for apikey mode.`);
      if (!a.sec) throw new Error(`Missing ${where}.sec (API key secret) for apikey mode.`);
    } else {
      if (auth.mode === "credentials") {
        // Each account needs a way in: its login's username+password, or a
        // pasted token as a per-account fallback.
        if (!a.accessToken && !(a.name && a.password)) {
          throw new Error(`${where}: set name+password (or an accessToken fallback).`);
        }
      }
      // Must be able to point at the right account under the login.
      if (!a.accountId && !a.accountSpec) {
        throw new Error(`Set ${where}.accountSpec or ${where}.accountId.`);
      }
    }
    return a;
  };

  const master = checkAccount(c.master, "master");
  const followers = (c.followers ?? []).map((f, i) => {
    checkAccount(f, `followers[${i}]`);
    return { multiplier: 1, symbolMap: {}, ...f } as FollowerConfig;
  });
  if (followers.length === 0) throw new Error("No followers configured.");

  return {
    environment: env,
    appId: c.appId ?? "MacCopier",
    appVersion: c.appVersion ?? "0.1",
    dryRun: c.dryRun ?? true,
    license: c.license,
    auth,
    master,
    followers,
  };
}
