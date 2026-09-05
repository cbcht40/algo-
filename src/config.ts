import { readFileSync } from "node:fs";
import type { Environment } from "./tradovate/types";

/**
 * Deux modes de fonctionnement :
 *   - "sync"   (défaut) : PAS de compte maître. Le Copieur est le panneau d'ordre :
 *                chaque ordre est envoyé à TOUS les comptes du groupe en parallèle,
 *                au même instant (latence entre comptes ≈ quelques ms).
 *   - "mirror" (historique) : un compte maître tradé dans Tradovate, recopié sur des
 *                followers dès que l'ordre apparaît (latence = aller-retour serveur).
 */
export type CopierMode = "sync" | "mirror";

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

/** Un compte du groupe (mode sync). Tous les comptes sont égaux : pas de maître. */
export interface AccountEntry extends AccountConfig {
  /** Multiplicateur de taille vs la quantité du panneau (ex. 3 pour un compte 150K
   *  quand la quantité de base est pensée pour un 50K). Défaut 1. */
  multiplier?: number;
  /** Dans le groupe ? Décoché dans le dashboard => false (aucun ordre envoyé). */
  enabled?: boolean;
}

export interface Config {
  mode: CopierMode;
  environment: Environment;
  appId: string;
  appVersion: string;
  /** When true, log intended orders but never actually send them. */
  dryRun: boolean;
  /** Edge license key (copy-pasted from Let-Trade Journal). Unlocks trading. */
  license?: string;
  auth: AuthConfig;
  /** Mode sync : le groupe de comptes (source de vérité). */
  accounts: AccountEntry[];
  /** Relais Tradovate : un ordre passé dans le navigateur sur un compte du groupe est
   *  envoyé au même instant sur les autres (extension → pont local). Défaut true. */
  relay?: boolean;
  /** Mode mirror (historique) — dérivés de `accounts` s'ils sont absents. */
  master: AccountConfig;
  followers: FollowerConfig[];
  /** Comptes supprimés manuellement depuis le dashboard → rescan ne les ré-ajoute pas. */
  removedSpecs?: string[];
  /** Ordre d'affichage des comptes dans le dashboard (specs/labels). Les comptes
   *  absents de la liste s'affichent à la fin, dans leur ordre naturel. */
  accountOrder?: string[];
  /** @deprecated alias historique de accountOrder (mode mirror). */
  followerOrder?: string[];
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
  const mode: CopierMode = (process.env.COPIER_MODE as CopierMode) || c.mode || "sync";
  if (mode !== "sync" && mode !== "mirror") {
    throw new Error(`mode must be "sync" or "mirror" (got "${String(mode)}").`);
  }

  const auth = c.auth;
  if (!auth || !["token", "apikey", "credentials"].includes(auth.mode)) {
    throw new Error('config.auth.mode must be "token", "apikey" or "credentials".');
  }

  // --- pool de comptes : `accounts` (nouveau) ou master+followers (ancien format) ---
  let accounts: AccountEntry[] = Array.isArray(c.accounts) ? c.accounts.filter(Boolean) : [];
  if (!accounts.length) {
    // Migration automatique de l'ancien format maître/followers → tous égaux.
    if (c.master) accounts.push({ ...c.master, multiplier: 1, enabled: true });
    for (const f of c.followers ?? []) {
      if (!f) continue;
      const { symbolMap: _drop, ...rest } = f as FollowerConfig;
      accounts.push({ ...rest });
    }
  }

  if (auth.mode === "token" && !auth.accessToken) {
    // A per-account token is still allowed, but a shared one is the common case.
    if (!accounts.some((a) => a?.accessToken)) {
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

  accounts = accounts.map((a, i) => {
    checkAccount(a, `accounts[${i}]`);
    const m = Number(a.multiplier ?? 1);
    return { ...a, multiplier: Number.isFinite(m) && m >= 0 ? m : 1, enabled: a.enabled !== false };
  });
  if (accounts.length === 0) throw new Error("No accounts configured.");

  // Mode mirror : maître + followers dérivés du pool si l'ancien format est absent.
  let master: AccountConfig;
  let followers: FollowerConfig[];
  if (c.master) {
    master = checkAccount(c.master, "master");
    followers = (c.followers ?? []).map((f, i) => {
      checkAccount(f, `followers[${i}]`);
      return { multiplier: 1, symbolMap: {}, ...f } as FollowerConfig;
    });
  } else {
    master = accounts[0]!;
    followers = accounts.slice(1).map((a) => ({ symbolMap: {}, ...a }));
  }
  if (mode === "mirror" && followers.length === 0) throw new Error("Mirror mode needs at least one follower.");

  const dryRun = process.env.COPIER_DRYRUN === "1" ? true : (c.dryRun ?? true);

  return {
    mode,
    environment: env,
    appId: c.appId ?? "MacCopier",
    appVersion: c.appVersion ?? "0.1",
    dryRun,
    license: c.license,
    auth,
    accounts,
    relay: c.relay !== false,
    master,
    followers,
    removedSpecs: c.removedSpecs,
    accountOrder: c.accountOrder ?? c.followerOrder,
    followerOrder: c.followerOrder,
  };
}
