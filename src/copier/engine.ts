import { writeFileSync } from "node:fs";
import type { AccountConfig, Config, FollowerConfig } from "../config";
import type { LicenseGate } from "../license";
import { resolveRoster, isKnownSpec, setMasterSpec } from "../roster";
import { logger } from "../logger";
import { TradovateClient, type ClientOptions } from "../tradovate/client";
import type { Account, Order, OrderVersion, PropsEvent } from "../tradovate/types";
import { jwtClaims } from "../tradovate/tokenStore";
import { MasterBook } from "./masterBook";

const TERMINAL_CANCEL = new Set(["Canceled", "Cancelled", "Rejected", "Expired"]);
// Un écart de position doit persister ce délai avant d'être signalé comme « dérive »
// (sinon la fenêtre normale de copie — maître rempli, follower pas encore — alarmerait).
const DRIFT_GRACE_MS = 6_000;

/** Écart de position maître↔follower sur un symbole. */
interface DriftEntry {
  symbol: string;
  expected: number; // ce que le follower DEVRAIT porter (net maître × multiplicateur)
  actual: number; // ce qu'il porte réellement
  delta: number; // actual - expected (≠ 0 = désync)
}

interface Follower {
  label: string;
  client: TradovateClient;
  accountId: number;
  accountSpec: string;
  multiplier: number;
  symbolMap: Record<string, string>;
  /** Unchecked in the dashboard => skip NEW orders for this account (cancels/
   *  modifies of already-copied orders still flow, so nothing is orphaned). */
  enabled: boolean;
}

interface MirrorLeg {
  follower: Follower;
  qty: number;
  /** Multiplier in force when the leg was PLACED. Modifies must use this snapshot,
   *  not the live f.multiplier — a live edit must never resize working orders. */
  mult: number;
  status: "pending" | "placed" | "canceled" | "skipped" | "failed";
  followerOrderId?: number;
  error?: string;
}

interface MirrorRecord {
  legs: MirrorLeg[];
  lastVersionId: number;
}

/** A copy action broadcast to the dashboard's live order log. */
export interface CopyEvent {
  ts: number;
  kind: "new" | "cancel" | "modify" | "blocked";
  masterOrderId: number;
  action?: string;
  qty?: number;
  symbol?: string;
  orderType?: string;
  price?: number;
  stopPrice?: number;
  ok: number;
  failed: number;
  legs: Array<{ label: string; status: string; qty: number; error?: string }>;
  note?: string;
  latencyMs?: number; // temps décision-de-copie → tous les ordres follower envoyés
}

const log = logger("engine");

export class CopierEngine {
  private cfg: Config;
  private configPath = "";
  private clients = new Map<string, TradovateClient>();
  private masterClient!: TradovateClient;
  private masterAccountId = 0;
  private masterAccountSpec = "";
  private followers: Follower[] = [];

  private book = new MasterBook();
  /** masterOrderId -> mirrored legs across followers */
  private mirrors = new Map<number, MirrorRecord>();
  /** master orders we've already decided on (mirrored or knowingly ignored) */
  private handled = new Set<number>();
  /** follower indices whose account is resolved (so re-syncs don't re-log) */
  private resolvedFollowers = new Set<number>();
  /** dashboard live-log subscribers */
  private copyListeners = new Set<(e: CopyEvent) => void>();
  /** Edge entitlement gate (set via setLicenseGate); copying requires it. */
  private gate?: LicenseGate;
  /** User-controlled arm switch — nothing is copied until the user arms it. */
  private active = false;
  /** Effective roster for this run (which account is master vs followers). */
  private rosterMaster!: AccountConfig;
  private rosterFollowers: FollowerConfig[] = [];
  private masterSpec = "";
  // Détection de dérive (position réelle du follower vs attendue depuis le maître).
  private driftTimer?: NodeJS.Timeout;
  private driftSince = new Map<string, { since: number; logged: boolean }>();
  private confirmedDrift = new Map<string, DriftEntry[]>();

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /** Wire the Edge license gate. New copies are blocked unless `gate.licensed`. */
  setLicenseGate(gate: LicenseGate): void {
    this.gate = gate;
  }

  /** Arm/disarm copying — the dashboard ON/OFF switch. Disarmed by default so
   *  the copier never mirrors until the user explicitly turns it on. */
  setActive(on: boolean): void {
    this.active = on;
    log.info(on ? "▶ Copieur ARMÉ — la copie est active." : "⏸ Copieur DÉSARMÉ — copie en pause.");
  }
  get isActive(): boolean {
    return this.active;
  }

  /** Where to persist config.json when new accounts are auto-added (rescan). */
  setPersistPath(path: string): void {
    this.configPath = path;
  }

  /** Re-discover the accounts on every connected login and auto-add any NEW one as a
   *  follower (×1). Triggered by the dashboard "Rechercher de nouveaux comptes" button.
   *  Persisted to config.json so the new accounts survive a restart. */
  async rescanAccounts(): Promise<{ added: number; total: number; names: string[] }> {
    await Promise.all([...this.clients.values()].map((c) => c.reSyncAccounts().catch(() => undefined)));

    const knownSpec = new Set<string>();
    const addSpec = (s?: string) => { if (s) knownSpec.add(s.toLowerCase()); };
    addSpec(this.masterAccountSpec);
    addSpec(this.rosterMaster?.accountSpec);
    addSpec(this.rosterMaster?.label);
    addSpec(this.cfg.master?.accountSpec);
    addSpec(this.cfg.master?.label);
    for (const f of this.cfg.followers ?? []) { addSpec(f.accountSpec); addSpec(f.label); }
    const knownId = new Set<number>([this.masterAccountId, ...this.followers.map((f) => f.accountId).filter(Boolean)]);
    // Comptes supprimés manuellement → on ne les ré-ajoute PAS (sinon le bouton Supprimer
    // serait inutile : le rescan les ferait réapparaître).
    const removed = new Set((this.cfg.removedSpecs ?? []).map((s) => s.toLowerCase()));

    const added: string[] = [];
    for (const client of this.clients.values()) {
      for (const acct of client.accounts) {
        if (knownId.has(acct.id) || knownSpec.has(acct.name.toLowerCase()) || removed.has(acct.name.toLowerCase())) continue;
        const fc: FollowerConfig = { label: acct.name, accountSpec: acct.name, multiplier: 1, enabled: true, accessToken: client.seedToken };
        this.cfg.followers = [...(this.cfg.followers ?? []), fc];
        this.rosterFollowers.push(fc);
        this.followers.push({ label: acct.name, client, accountId: acct.id, accountSpec: acct.name, multiplier: 1, symbolMap: {}, enabled: true });
        this.resolvedFollowers.add(this.followers.length - 1);
        knownId.add(acct.id);
        addSpec(acct.name);
        added.push(acct.name);
        log.info(`Nouveau compte détecté → follower : ${acct.name}#${acct.id}`);
      }
    }
    if (added.length) this.persistConfig();
    return { added: added.length, total: this.followers.length, names: added };
  }

  /** Per-follower settings from the dashboard: copy on/off (checkbox) and size
   *  multiplier. Applied LIVE (next master order) and persisted to config.json. */
  setFollowerSettings(spec: string, patch: { enabled?: boolean; multiplier?: number }): { ok: boolean; error?: string } {
    const key = (spec || "").toLowerCase();
    const match = (label?: string, acct?: string) =>
      (acct ?? "").toLowerCase() === key || (label ?? "").toLowerCase() === key;
    const f = this.followers.find((x) => match(x.label, x.accountSpec));
    if (!f) return { ok: false, error: `Compte inconnu : ${spec}` };

    if (patch.multiplier !== undefined) {
      const m = Number(patch.multiplier);
      if (!Number.isFinite(m) || m < 0 || m > 100) {
        return { ok: false, error: "Multiplicateur invalide (0 à 100)." };
      }
    }

    // Resolve the PERSISTED entry FIRST — refuse the change if we can't save it.
    // The entry may live in cfg.master (ex-maître devenu follower après un changement
    // de maître) et le spec runtime peut être le nom résolu par l'API alors que la
    // config n'a que label+accountId — on cherche donc tout le pool, par spec/label
    // ET par accountId/label du follower runtime. Sans entrée → erreur franche
    // (jamais un réglage de risque appliqué en mémoire qui se perdrait au restart).
    const pool = [this.cfg.master as FollowerConfig, ...(this.cfg.followers ?? [])];
    const fc = pool.find(
      (c) =>
        c &&
        (match(c.label, c.accountSpec) ||
          (!!c.accountId && c.accountId === f.accountId) ||
          (c.label ?? "").toLowerCase() === f.label.toLowerCase()),
    );
    if (!fc) return { ok: false, error: `Entrée config introuvable pour ${spec} — réglage non sauvegardé.` };

    if (patch.multiplier !== undefined) {
      f.multiplier = Number(patch.multiplier);
      fc.multiplier = f.multiplier;
    }
    if (patch.enabled !== undefined) {
      f.enabled = !!patch.enabled;
      fc.enabled = f.enabled;
    }
    this.persistConfig();
    log.info(`Follower ${f.label} → ${f.enabled ? "copie ✓" : "copie ✗"} ×${f.multiplier}`);
    return { ok: true };
  }

  /** Retire un follower du copieur (bouton × du dashboard). Splice les tableaux runtime
   *  parallèles + la config, réindexe resolvedFollowers, et mémorise le spec dans
   *  removedSpecs pour que « Rechercher de nouveaux comptes » ne le ré-ajoute pas. Le
   *  login n'est PAS déconnecté (d'autres followers peuvent le partager) : le compte
   *  cesse simplement d'être mirroré. */
  removeFollower(spec: string): { ok: boolean; error?: string } {
    const key = (spec || "").toLowerCase();
    const match = (label?: string, acct?: string) =>
      (acct ?? "").toLowerCase() === key || (label ?? "").toLowerCase() === key;
    const i = this.followers.findIndex((x) => match(x.label, x.accountSpec));
    if (i < 0) return { ok: false, error: `Compte inconnu : ${spec}` };
    const f = this.followers[i]!;

    // Retire de la config persistée (par spec/label/accountId).
    if (this.cfg.followers) {
      this.cfg.followers = this.cfg.followers.filter(
        (c) => !(match(c.label, c.accountSpec)
          || (!!c.accountId && c.accountId === f.accountId)
          || (c.label ?? "").toLowerCase() === f.label.toLowerCase()),
      );
    }

    // Splice les tableaux runtime parallèles + réindexe resolvedFollowers (les index
    // supérieurs à i se décalent de -1).
    this.followers.splice(i, 1);
    this.rosterFollowers.splice(i, 1);
    const reindexed = new Set<number>();
    for (const idx of this.resolvedFollowers) {
      if (idx < i) reindexed.add(idx);
      else if (idx > i) reindexed.add(idx - 1);
    }
    this.resolvedFollowers = reindexed;

    // Ignore-list rescan (spec ET label) + nettoie l'ordre d'affichage.
    const removed = new Set(this.cfg.removedSpecs ?? []);
    if (f.accountSpec) removed.add(f.accountSpec);
    removed.add(f.label);
    this.cfg.removedSpecs = [...removed];
    if (this.cfg.followerOrder) {
      this.cfg.followerOrder = this.cfg.followerOrder.filter((s) => !match(s, s));
    }

    this.persistConfig();
    log.info(`Follower retiré : ${f.label} (${this.followers.length} restant(s)).`);
    return { ok: true };
  }

  /** Réordonne l'AFFICHAGE des followers (glisser ou flèches ↑↓ du dashboard). On persiste
   *  juste une liste de specs ; le snapshot d'état trie dessus. Aucun tableau runtime touché
   *  → zéro risque sur les connexions ou les index. */
  reorderFollowers(orderedSpecs: string[]): { ok: boolean; error?: string } {
    if (!Array.isArray(orderedSpecs)) return { ok: false, error: "ordre invalide" };
    this.cfg.followerOrder = orderedSpecs.map((s) => String(s));
    this.persistConfig();
    log.info(`Ordre des followers mis à jour (${orderedSpecs.length}).`);
    return { ok: true };
  }

  /** Ré-affiche un compte précédemment masqué (bouton « Réafficher » du dashboard) :
   *  retire son spec/label de removedSpecs pour que « Rechercher de nouveaux comptes »
   *  puisse le re-découvrir. Ne reconnecte rien et ne re-crée pas le follower ici : il
   *  faut ensuite un rescan (login connecté) pour qu'il réapparaisse. */
  restoreFollower(spec: string): { ok: boolean; error?: string } {
    const key = (spec || "").toLowerCase();
    const before = this.cfg.removedSpecs ?? [];
    const after = before.filter((s) => String(s).toLowerCase() !== key);
    if (after.length === before.length) return { ok: false, error: `Compte non masqué : ${spec}` };
    this.cfg.removedSpecs = after;
    this.persistConfig();
    log.info(`Compte ré-affiché : ${spec} (${after.length} masqué(s) restant(s)).`);
    return { ok: true };
  }

  /** Bouton « Actualiser » d'un compte : force une reconnexion immédiate de son login
   *  (si down) + re-sync + re-résolution, puis renvoie l'état. Ne peut PAS ranimer un
   *  token expiré — dans ce cas `connected` reste faux et l'UI invite à rouvrir la
   *  session Tradovate (l'extension pousse alors un token frais). */
  async refreshFollower(spec: string): Promise<{ ok: boolean; connected: boolean; resolved: boolean; error?: string }> {
    const key = (spec || "").toLowerCase();
    const match = (label?: string, acct?: string) =>
      (acct ?? "").toLowerCase() === key || (label ?? "").toLowerCase() === key;
    const f = this.followers.find((x) => match(x.label, x.accountSpec));
    if (!f) return { ok: false, connected: false, resolved: false, error: `Compte inconnu : ${spec}` };
    try {
      await f.client.refresh();
      this.onLoginReady(f.client); // re-résout les followers de ce login
      return { ok: true, connected: f.client.isReady, resolved: !!f.accountId };
    } catch (err) {
      return { ok: false, connected: f.client.isReady, resolved: !!f.accountId, error: String((err as Error)?.message || err) };
    }
  }

  /** Bouton « Flatten All » du dashboard : met TOUS les comptes à plat — pour chaque
   *  compte (maître + followers), annule d'abord tous les ordres en attente puis
   *  clôture chaque position ouverte AU MARCHÉ (order/liquidateposition). DÉSARME
   *  d'abord le copieur pour qu'une clôture du maître ne soit pas recopiée en nouvelle
   *  position sur les followers (ils sont mis à plat directement, indépendamment). */
  async flattenAll(): Promise<{ ok: boolean; accounts: number; canceled: number; flattened: number; skipped: string[]; errors: string[] }> {
    const wasActive = this.active;
    this.active = false; // panique → on coupe la copie immédiatement
    if (wasActive) log.warn("⏸ Copieur DÉSARMÉ (Flatten All).");

    type Target = { label: string; client: TradovateClient; accountId: number };
    const targets: Target[] = [];
    const seen = new Set<number>();
    const add = (label: string, client: TradovateClient | undefined, accountId: number | undefined | null) => {
      if (!client || !accountId || seen.has(accountId)) return;
      seen.add(accountId);
      targets.push({ label, client, accountId });
    };
    add(this.masterAccountSpec || this.rosterMaster?.label || "maître", this.masterClient, this.masterAccountId);
    for (const f of this.followers) add(f.label, f.client, f.accountId);

    let canceled = 0, flattened = 0;
    const skipped: string[] = [];
    const errors: string[] = [];
    for (const t of targets) {
      if (!t.client.isReady) { skipped.push(t.label); continue; }
      // 1) annule tous les ordres en attente (limit + stop)
      for (const o of t.client.workingOrders(t.accountId)) {
        try { await t.client.request("order/cancelorder", { orderId: o.id }); canceled++; }
        catch (err) { errors.push(`${t.label} annul #${o.id}: ${String(err)}`); }
      }
      // 2) clôture chaque position ouverte au marché
      for (const p of t.client.openPositions(t.accountId)) {
        try { await t.client.request("order/liquidateposition", { accountId: t.accountId, contractId: p.contractId, admin: false }); flattened++; }
        catch (err) { errors.push(`${t.label} flatten ${p.symbol}: ${String(err)}`); }
      }
    }
    const processed = targets.length - skipped.length;
    log.info(`Flatten All → ${processed} compte(s) traité(s) · ${canceled} ordre(s) annulé(s) · ${flattened} position(s) clôturée(s)` +
      (skipped.length ? ` · ${skipped.length} ignoré(s) (déconnecté)` : "") + (errors.length ? ` · ${errors.length} erreur(s)` : ""));
    return { ok: errors.length === 0, accounts: processed, canceled, flattened, skipped, errors };
  }

  /** Followers triés selon cfg.followerOrder pour l'affichage (les non listés à la fin,
   *  ordre naturel). Ne modifie pas this.followers. */
  private displayFollowers(): Follower[] {
    const order = this.cfg.followerOrder;
    if (!order || !order.length) return this.followers;
    const rank = new Map(order.map((s, idx) => [String(s).toLowerCase(), idx]));
    const keyOf = (f: Follower) => (f.accountSpec || f.label || "").toLowerCase();
    return this.followers
      .map((f, idx) => ({ f, idx }))
      .sort((a, b) => {
        const ra = rank.get(keyOf(a.f)) ?? order.length + a.idx;
        const rb = rank.get(keyOf(b.f)) ?? order.length + b.idx;
        return ra - rb;
      })
      .map((x) => x.f);
  }

  private persistConfig(): void {
    if (!this.configPath) return;
    try {
      writeFileSync(this.configPath, JSON.stringify(this.cfg, null, 2));
      log.info(`Config mise à jour → ${this.followers.length} follower(s).`);
    } catch (err) {
      log.warn(`Persist config échouée : ${String(err)}`);
    }
  }

  /** Choose which account is the master. Persisted; applied on the next restart
   *  (the Electron app restarts the copier automatically when this changes). */
  requestMaster(spec: string): { ok: boolean; error?: string; masterSpec?: string } {
    if (!spec || !isKnownSpec(this.cfg, spec)) return { ok: false, error: "compte inconnu" };
    setMasterSpec(spec);
    log.info(`Changement de maître demandé → ${spec} (appliqué au redémarrage).`);
    return { ok: true, masterSpec: spec };
  }

  // One websocket per distinct login (token, or name+cid); accounts on the same
  // login share the connection.
  private getClient(acct: AccountConfig): TradovateClient {
    const auth = this.cfg.auth;
    // A login can sit on a different network than the global one (e.g. funded
    // accounts on "live" while the master eval is on "demo"). Per-account host
    // overrides only apply when the account rides the global network.
    const environment = acct.environment ?? this.cfg.environment;
    const usingGlobalEnv = acct.environment === undefined;
    const common = {
      label: acct.label,
      environment,
      appId: this.cfg.appId,
      appVersion: this.cfg.appVersion,
      restBase: usingGlobalEnv ? auth.restBase : undefined,
      wsUrl: usingGlobalEnv ? auth.wsUrl : undefined,
    };

    let key: string;
    let opts: ClientOptions;
    const pastedToken = acct.accessToken ?? (auth.mode === "token" ? auth.accessToken : undefined);
    if (pastedToken) {
      // Key on the FULL token: JWTs from the same issuer share an identical
      // header prefix, so a sliced key would collapse distinct logins into one.
      key = `token|${environment}|${pastedToken}`;
      opts = { ...common, accessToken: pastedToken };
    } else if (acct.name && acct.password) {
      // credentials / apikey: one client per username (cid/sec default to the
      // public pair inside the client when not provided).
      key = `cred|${environment}|${acct.name}`;
      opts = {
        ...common,
        name: acct.name,
        password: acct.password,
        cid: acct.cid ?? auth.cid,
        sec: acct.sec ?? auth.sec,
      };
    } else {
      throw new Error(`[${acct.label}] no credentials: set accessToken or name+password.`);
    }

    let c = this.clients.get(key);
    if (!c) {
      c = new TradovateClient(opts);
      this.clients.set(key, c);
    }
    return c;
  }

  async start(): Promise<void> {
    const roster = resolveRoster(this.cfg);
    this.rosterMaster = roster.master;
    this.rosterFollowers = roster.followers;
    this.masterSpec = roster.masterSpec;
    log.info(`Master selected: ${this.rosterMaster.label}`);

    this.masterClient = this.getClient(this.rosterMaster);

    for (const f of this.rosterFollowers) {
      const client = this.getClient(f);
      this.followers.push({
        label: f.label,
        client,
        accountId: f.accountId ?? 0,
        accountSpec: f.accountSpec ?? "",
        multiplier: f.multiplier ?? 1,
        symbolMap: f.symbolMap ?? {},
        enabled: f.enabled !== false,
      });
    }

    // Resolve accounts and wire the master as each login becomes ready — now at
    // startup, or later when the Let Trade Copieur extension pushes a fresh token to a
    // login whose configured token had expired.
    for (const c of this.clients.values()) {
      c.onStatus((s) => {
        if (s === "ready") this.onLoginReady(c);
      });
    }

    log.info(
      `Starting on ${this.cfg.environment.toUpperCase()} — ` +
        `${this.clients.size} login(s), ${this.followers.length} follower account(s)` +
        (this.cfg.dryRun ? " [DRY-RUN]" : ""),
    );

    // A dead/expired token must NOT take the whole copier down: the other logins
    // keep working, and the failed one revives the moment a fresh token arrives.
    const results = await Promise.allSettled([...this.clients.values()].map((c) => c.start()));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      log.warn(
        `${failed}/${this.clients.size} login(s) not authenticated (expired token?). ` +
          `They activate automatically when a fresh token arrives (Let Trade Copieur extension) or on restart.`,
      );
    }
    log.info("Copier is live. Ready logins mirror immediately; place a trade on the master account.");

    // Surveillance de la dérive : compare en continu la position réelle de chaque
    // follower à celle attendue depuis le maître (une copie ratée = follower désync).
    this.driftTimer = setInterval(() => {
      try { this.evaluateDrift(); } catch (err) { log.warn(`drift eval: ${String(err)}`); }
    }, 3_000);
  }

  /** Position attendue d'un follower : net maître × multiplicateur, arrondi vers zéro
   *  comme la copie (floor de la valeur absolue). Exact pour un multiplicateur entier ;
   *  approché pour un fractionnaire (la copie floore CHAQUE ordre, pas la position). */
  private scaledExpected(masterNet: number, mult: number): number {
    return Math.sign(masterNet) * Math.floor(Math.abs(masterNet) * mult + 1e-9);
  }

  /** Écarts de position entre ce follower et l'attendu. Vide si le follower est décoché,
   *  déconnecté, non résolu, ou si le maître n'est pas prêt.
   *
   *  IMPORTANT : on matche par `contractId` (identique d'un compte à l'autre), PAS par
   *  nom de symbole. Le nom (`contractCache`) est résolu PAR CLIENT : un follower qui
   *  n'a pas encore le nom d'un contrat renvoie « #<id> » → comparer par nom créait de
   *  fausses désync (« MNQU6 attendu +2 » ET « #4399654 réel +2 » pour la même position).
   *  Seul le symbolMap (contrats DIFFÉRENTS) se compare par nom du symbole mappé. */
  private computeFollowerDrift(f: Follower): DriftEntry[] {
    if (!f.enabled || !f.client.isReady || !f.accountId || !this.masterAccountId || !this.masterClient?.isReady) return [];
    const folPos = f.client.openPositions(f.accountId).filter((p) => p.netPos);
    const folById = new Map<number, number>();
    const folBySym = new Map<string, { net: number; contractId: number }>();
    for (const p of folPos) {
      folById.set(p.contractId, (folById.get(p.contractId) ?? 0) + p.netPos);
      folBySym.set(p.symbol, { net: (folBySym.get(p.symbol)?.net ?? 0) + p.netPos, contractId: p.contractId });
    }
    const out: DriftEntry[] = [];
    const consumed = new Set<number>(); // contractIds follower déjà comparés
    for (const p of this.masterClient.openPositions(this.masterAccountId)) {
      if (!p.netPos) continue;
      const expected = this.scaledExpected(p.netPos, f.multiplier);
      const mapped = f.symbolMap[p.symbol];
      let actual: number;
      let display: string;
      let cid: number;
      if (mapped !== undefined) {
        const hit = folBySym.get(mapped); // contrat différent → match par nom mappé
        actual = hit?.net ?? 0;
        display = mapped;
        cid = hit?.contractId ?? -1;
      } else {
        actual = folById.get(p.contractId) ?? 0; // même contrat → match par contractId
        display = p.symbol; // nom résolu côté maître (jamais « #id »)
        cid = p.contractId;
      }
      if (cid >= 0) consumed.add(cid);
      if (expected !== actual) out.push({ symbol: display, expected, actual, delta: actual - expected });
    }
    // Positions détenues par le follower que le maître n'a pas (dérive inverse).
    for (const p of folPos) {
      if (consumed.has(p.contractId)) continue;
      out.push({ symbol: p.symbol, expected: 0, actual: p.netPos, delta: p.netPos });
    }
    return out;
  }

  /** Évalue la dérive de tous les followers. Un écart doit PERSISTER DRIFT_GRACE_MS
   *  avant d'être « confirmé » (évite les faux positifs de la fenêtre de copie). Chaque
   *  dérive nouvellement confirmée est loguée une seule fois. Résultat lu par le dashboard. */
  private evaluateDrift(): void {
    const now = Date.now();
    const seen = new Set<string>();
    const byFollower = new Map<string, DriftEntry[]>();
    const sgn = (n: number) => (n >= 0 ? "+" : "") + n;
    for (const f of this.followers) {
      const confirmed: DriftEntry[] = [];
      for (const d of this.computeFollowerDrift(f)) {
        const key = `${f.label}|${d.symbol}`;
        seen.add(key);
        let rec = this.driftSince.get(key);
        if (!rec) { rec = { since: now, logged: false }; this.driftSince.set(key, rec); }
        if (now - rec.since >= DRIFT_GRACE_MS) {
          confirmed.push(d);
          if (!rec.logged) {
            rec.logged = true;
            log.warn(`⚠ DÉRIVE ${f.label} ${d.symbol} : attendu ${sgn(d.expected)}, réel ${sgn(d.actual)} (écart ${sgn(d.delta)})`);
          }
        }
      }
      if (confirmed.length) byFollower.set(f.label, confirmed);
    }
    // Purge les écarts résolus (plus vus ce tour).
    for (const key of [...this.driftSince.keys()]) if (!seen.has(key)) this.driftSince.delete(key);
    this.confirmedDrift = byFollower;
  }

  /** Resolve the exact account behind a config entry on a given login. */
  private pick(
    client: TradovateClient,
    wantId: number | undefined,
    wantSpec: string | undefined,
    label: string,
  ): Account {
    const accts = client.accounts;
    const first = accts[0];
    if (!first) throw new Error(`[${label}] login has no trading accounts.`);
    const available = () => accts.map((a) => `${a.name}#${a.id}`).join(", ");
    // An explicitly requested account MUST exist on this login — never fall back
    // to "some other account" silently (that duplicates orders on the wrong one).
    if (wantId && wantId > 0) {
      const acct = accts.find((a) => a.id === wantId);
      if (!acct) throw new Error(`[${label}] accountId ${wantId} not on this login (has: ${available()}).`);
      return acct;
    }
    if (wantSpec) {
      const acct = accts.find((a) => a.name === wantSpec);
      if (!acct) throw new Error(`[${label}] account "${wantSpec}" not on this login (has: ${available()}).`);
      return acct;
    }
    if (accts.length > 1) {
      log.warn(
        `[${label}] login has ${accts.length} accounts; defaulting to ${first.name}#${first.id}. ` +
          `Set accountId/accountSpec to be explicit.`,
      );
    }
    return first;
  }

  /** Fired when a login finishes its sync (at startup, or after a token revive). */
  private onLoginReady(client: TradovateClient): void {
    if (client === this.masterClient && !this.masterAccountId) {
      try {
        const m = this.pick(
          client,
          this.rosterMaster.accountId,
          this.rosterMaster.accountSpec,
          this.rosterMaster.label,
        );
        this.masterAccountId = m.id;
        this.masterAccountSpec = m.name;
        this.wireMaster();
        this.checkStartFlat();
        log.info(`Master account: ${m.name}#${m.id}`);
      } catch (err) {
        log.warn(`Master not resolved yet: ${String(err)}`);
      }
    }

    for (let i = 0; i < this.followers.length; i++) {
      if (this.resolvedFollowers.has(i)) continue;
      const f = this.followers[i]!;
      if (f.client !== client) continue;
      try {
        const fc = this.rosterFollowers[i]!;
        const acct = this.pick(client, fc.accountId, fc.accountSpec, f.label);
        f.accountId = acct.id;
        f.accountSpec = acct.name;
        this.resolvedFollowers.add(i);
        log.info(`Follower ${f.label}: ${acct.name}#${acct.id} (x${f.multiplier})`);
      } catch (err) {
        log.warn(`Follower ${f.label} not resolved: ${String(err)}`);
      }
    }
  }

  private checkStartFlat(): void {
    const openOrders = this.book.workingOrders(this.masterAccountId);
    const openPos = this.book.openPositions();
    if (openOrders.length || openPos.length) {
      log.warn(
        `Master is NOT flat at startup (${openPos.length} position(s), ${openOrders.length} working order(s)). ` +
          `Pre-existing orders/positions are NOT replicated — start flat for a clean mirror.`,
      );
    }
  }

  private wireMaster(): void {
    this.masterClient.onEntity((ev) => this.onMasterEntity(ev));
  }

  private onMasterEntity(ev: PropsEvent): void {
    const affected = this.book.apply(ev);

    // Live visibility: log every incoming entity event and whether it belongs to
    // the master account. Makes "I placed an order and nothing happened" diagnosable.
    if (ev.eventType !== "Snapshot") {
      const e = ev.entity as any;
      const acct = e?.accountId;
      log.debug(
        `event ${ev.entityType}/${ev.eventType}` +
          (acct !== undefined ? ` acct=${acct}` : "") +
          (e?.ordStatus ? ` status=${e.ordStatus}` : "") +
          (e?.id !== undefined ? ` id=${e.id}` : "") +
          (e?.orderId !== undefined ? ` orderId=${e.orderId}` : "") +
          (acct !== undefined && acct !== this.masterAccountId
            ? `  ← NOT master(${this.masterAccountId}), ignored`
            : ""),
      );
    }

    // Snapshot items (initial sync or post-reconnect resync) are existing state,
    // never live actions — record orders as known so we never replicate them.
    if (ev.eventType === "Snapshot") {
      if (ev.entityType === "order") {
        const o = ev.entity as unknown as Order;
        if (o.accountId === this.masterAccountId) this.handled.add(o.id);
      }
      return;
    }

    if (affected === undefined) return;
    this.reconcileOrder(affected);
  }

  private reconcileOrder(orderId: number): void {
    const o = this.book.order(orderId);
    if (!o || o.accountId !== this.masterAccountId) return;
    const v = this.book.version(orderId);

    if (!this.handled.has(orderId)) {
      if (!v) return; // wait until we have qty/type/price
      const isWorking = o.ordStatus === "Working";
      // Fluidité : un ordre au MARCHÉ est copié DÈS QU'IL APPARAÎT (PendingNew, etc.),
      // sans attendre le fill du maître → le follower part en même temps que le maître,
      // fills quasi simultanés, slippage minimal. Auparavant on attendait `Filled`, ce
      // qui rendait les fills séquentiels (maître PUIS follower). Seul cas exclu : déjà
      // annulé/rejeté (rien à copier). Limites/stops restent copiés sur « Working ».
      const fireMarketNow = v.orderType === "Market" && !TERMINAL_CANCEL.has(o.ordStatus);
      if (!isWorking && !fireMarketNow) return; // pas encore exploitable

      this.handled.add(orderId);
      this.mirrors.set(orderId, { legs: [], lastVersionId: v.id });
      void this.mirrorNew(o, v);
      return;
    }

    // Already mirrored — propagate lifecycle changes to the followers.
    if (TERMINAL_CANCEL.has(o.ordStatus)) {
      void this.propagateCancel(orderId);
    } else if (o.ordStatus === "Working") {
      const rec = this.mirrors.get(orderId);
      if (v && rec && rec.lastVersionId !== v.id) {
        rec.lastVersionId = v.id;
        void this.propagateModify(orderId, v);
      }
    }
  }

  // --- replication primitives ----------------------------------------------

  private async mirrorNew(o: Order, v: OrderVersion): Promise<void> {
    const t0 = Date.now(); // mesure de fluidité : décision de copie → ordres envoyés
    const symbol = await this.masterClient.contractName(o.contractId);
    const rec = this.mirrors.get(o.id);
    if (!rec) return;

    // Arm switch: the copier mirrors nothing until the user explicitly arms it.
    if (!this.active) {
      log.info(`⏸ Désarmé — ordre maître #${o.id} non copié (arme le copieur avant de trader).`);
      this.emitCopy({
        ts: Date.now(),
        kind: "blocked",
        masterOrderId: o.id,
        action: o.action,
        qty: v.orderQty,
        symbol,
        orderType: v.orderType,
        ok: 0,
        failed: 0,
        legs: [],
        note: "Copieur désarmé",
      });
      return;
    }

    // Edge gate: block NEW copies when unlicensed (cancels/modifies still flow,
    // so a lapsed subscription can still close out existing mirrored positions).
    if (this.gate && !this.gate.licensed) {
      log.warn(`🔒 Edge requis — ordre maître #${o.id} NON répliqué (copie désactivée).`);
      this.emitCopy({
        ts: Date.now(),
        kind: "blocked",
        masterOrderId: o.id,
        action: o.action,
        qty: v.orderQty,
        symbol,
        orderType: v.orderType,
        ok: 0,
        failed: 0,
        legs: [],
        note: "Abonnement Edge requis",
      });
      return;
    }

    log.info(
      `MASTER ${o.action} ${v.orderQty} ${symbol} ${v.orderType}` +
        (v.price ? ` @${v.price}` : "") +
        (v.stopPrice ? ` stop ${v.stopPrice}` : "") +
        ` (order#${o.id}) -> replicating to ${this.followers.length} follower(s)`,
    );

    // Fire every follower in parallel for minimal latency.
    await Promise.all(
      this.followers.map(async (f) => {
        // floor (jamais round) : ×0.5 d'1 lot ne doit JAMAIS copier 1 lot entier —
        // un multiplicateur fractionnaire réduit le risque, il ne l'arrondit pas vers le haut.
        const qty = Math.floor(v.orderQty * f.multiplier + 1e-9);
        const leg: MirrorLeg = { follower: f, qty, mult: f.multiplier, status: "pending" };
        rec.legs.push(leg);
        // Unchecked in the dashboard → no NEW orders for this account. (Its already-
        // copied orders keep receiving cancels/modifies via the recorded legs.)
        if (!f.enabled) {
          leg.status = "skipped";
          log.info(`  ${f.label}: décoché — pas de copie`);
          return;
        }
        if (qty <= 0) {
          leg.status = "skipped";
          log.debug(`  ${f.label}: qty ${qty} <= 0, skipped`);
          return;
        }
        const sym = f.symbolMap[symbol] ?? symbol;
        const body: Record<string, unknown> = {
          accountId: f.accountId,
          accountSpec: f.accountSpec,
          action: o.action,
          symbol: sym,
          orderQty: qty,
          orderType: v.orderType,
          isAutomated: true,
          timeInForce: v.timeInForce ?? "Day",
        };
        if (v.price !== undefined) body.price = v.price;
        if (v.stopPrice !== undefined) body.stopPrice = v.stopPrice;

        if (this.cfg.dryRun) {
          log.info(`  [DRY] ${f.label}: ${o.action} ${qty} ${sym} ${v.orderType}`);
          leg.status = "placed";
          return;
        }
        try {
          const res = await f.client.request("order/placeorder", body);
          leg.followerOrderId = (res.d as any)?.orderId;
          leg.status = "placed";
          log.info(`  ${f.label}: placed order#${leg.followerOrderId} (${qty} ${sym})`);
        } catch (err) {
          leg.status = "failed";
          leg.error = String(err);
          log.error(`  ${f.label}: placeorder FAILED — ${String(err)}`);
        }
      }),
    );

    this.emitCopy({
      ts: Date.now(),
      kind: "new",
      masterOrderId: o.id,
      action: o.action,
      qty: v.orderQty,
      symbol,
      orderType: v.orderType,
      price: v.price,
      stopPrice: v.stopPrice,
      ok: rec.legs.filter((l) => l.status === "placed").length,
      failed: rec.legs.filter((l) => l.status === "failed").length,
      legs: rec.legs.map((l) => ({ label: l.follower.label, status: l.status, qty: l.qty, error: l.error })),
      latencyMs: Date.now() - t0,
    });
  }

  private async propagateCancel(masterOrderId: number): Promise<void> {
    const rec = this.mirrors.get(masterOrderId);
    if (!rec) return;
    await Promise.all(
      rec.legs
        .filter((l) => l.status === "placed")
        .map(async (leg) => {
          if (this.cfg.dryRun || leg.followerOrderId === undefined) {
            log.info(`  [DRY] ${leg.follower.label}: cancel mirror of order#${masterOrderId}`);
            leg.status = "canceled";
            return;
          }
          try {
            await leg.follower.client.request("order/cancelorder", { orderId: leg.followerOrderId });
            leg.status = "canceled";
            log.info(`  ${leg.follower.label}: canceled order#${leg.followerOrderId}`);
          } catch (err) {
            log.error(`  ${leg.follower.label}: cancel FAILED — ${String(err)}`);
          }
        }),
    );

    this.emitCopy({
      ts: Date.now(),
      kind: "cancel",
      masterOrderId,
      ok: rec.legs.filter((l) => l.status === "canceled").length,
      failed: 0,
      legs: rec.legs.map((l) => ({ label: l.follower.label, status: l.status, qty: l.qty, error: l.error })),
    });
  }

  private async propagateModify(masterOrderId: number, v: OrderVersion): Promise<void> {
    const rec = this.mirrors.get(masterOrderId);
    if (!rec) return;
    await Promise.all(
      rec.legs
        .filter((l) => l.status === "placed")
        .map(async (leg) => {
          // Multiplicateur SNAPSHOTTÉ au placement (leg.mult) : un changement de
          // levier en cours de route ne doit pas redimensionner un stop qui travaille.
          const qty = Math.max(1, Math.floor(v.orderQty * leg.mult + 1e-9));
          if (this.cfg.dryRun || leg.followerOrderId === undefined) {
            log.info(`  [DRY] ${leg.follower.label}: modify order#${masterOrderId} -> qty ${qty}`);
            return;
          }
          const body: Record<string, unknown> = {
            orderId: leg.followerOrderId,
            orderType: v.orderType,
            orderQty: qty,
            isAutomated: true,
          };
          if (v.price !== undefined) body.price = v.price;
          if (v.stopPrice !== undefined) body.stopPrice = v.stopPrice;
          try {
            await leg.follower.client.request("order/modifyorder", body);
            leg.qty = qty;
            log.info(`  ${leg.follower.label}: modified order#${leg.followerOrderId} (qty ${qty})`);
          } catch (err) {
            log.error(`  ${leg.follower.label}: modify FAILED — ${String(err)}`);
          }
        }),
    );

    this.emitCopy({
      ts: Date.now(),
      kind: "modify",
      masterOrderId,
      qty: v.orderQty,
      orderType: v.orderType,
      price: v.price,
      stopPrice: v.stopPrice,
      ok: rec.legs.filter((l) => l.status === "placed").length,
      failed: 0,
      legs: rec.legs.map((l) => ({ label: l.follower.label, status: l.status, qty: l.qty, error: l.error })),
    });
  }

  // --- browser-extension bridge --------------------------------------------

  /** Route a token pushed by the extension to the login it belongs to. */
  async ingestToken(token: string): Promise<{ ok: boolean; login?: string; acted?: boolean; error?: string }> {
    const sub = jwtClaims(token).sub;
    if (!sub) return { ok: false, error: "token has no sub claim" };
    const client = [...this.clients.values()].find((c) => c.sub === sub);
    if (!client) return { ok: false, error: `no configured login for userId ${sub}` };
    try {
      const acted = await client.acceptToken(token);
      return { ok: true, login: client.label, acted };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /** Live snapshot for the extension popup. */
  status(): Array<{ label: string; userId: number; ready: boolean; sub?: string }> {
    return [...this.clients.values()].map((c) => ({
      label: c.label,
      userId: c.userId,
      ready: c.isReady,
      sub: c.sub,
    }));
  }

  /** Per-ACCOUNT state for the local dashboard (port 7879). `connected` = the
   *  underlying login's websocket is authorized + open. */
  dashboardState() {
    const followers = this.displayFollowers();
    const masterPos = this.masterAccountId ? this.masterClient.openPositions(this.masterAccountId) : [];
    const folPos = followers.map((f) => (f.accountId ? f.client.openPositions(f.accountId) : []));
    // Le nom d'un contrat est résolu PAR CLIENT : un compte peut renvoyer « #<id> ».
    // On construit un annuaire contractId→nom depuis TOUS les comptes qui, eux, ont le
    // nom, puis on remplace les « #<id> » à l'affichage (sinon le dashboard montre
    // « #4399654 » au lieu de « MNQU6 »).
    const nameById = new Map<number, string>();
    const collect = (ps: Array<{ symbol: string; contractId: number }>) =>
      ps.forEach((p) => { if (!p.symbol.startsWith("#")) nameById.set(p.contractId, p.symbol); });
    collect(masterPos);
    folPos.forEach(collect);
    const named = <T extends { symbol: string; contractId: number }>(ps: T[]): T[] =>
      ps.map((p) => (p.symbol.startsWith("#") && nameById.has(p.contractId) ? { ...p, symbol: nameById.get(p.contractId)! } : p));
    return {
      environment: this.cfg.environment,
      dryRun: this.cfg.dryRun,
      active: this.active,
      masterSpec: this.masterSpec || null,
      license: this.gate?.status() ?? null,
      master: {
        label: this.rosterMaster?.label ?? this.cfg.master.label,
        account: this.masterAccountSpec || null,
        accountId: this.masterAccountId || null,
        connected: this.masterClient?.isReady ?? false,
        positions: named(masterPos),
      },
      followers: followers.map((f, i) => ({
        label: f.label,
        account: f.accountSpec || null,
        accountId: f.accountId || null,
        multiplier: f.multiplier,
        enabled: f.enabled,
        connected: f.client.isReady,
        positions: named(folPos[i]!),
        drift: this.confirmedDrift.get(f.label) ?? [], // écarts de position confirmés
      })),
      removedSpecs: [...(this.cfg.removedSpecs ?? [])],
    };
  }

  /** Subscribe to copy actions — used by the dashboard's live order log. */
  onCopyEvent(h: (e: CopyEvent) => void): void {
    this.copyListeners.add(h);
  }
  private emitCopy(e: CopyEvent): void {
    for (const h of this.copyListeners) {
      try {
        h(e);
      } catch (err) {
        log.error(`copy-event handler threw: ${String(err)}`);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.driftTimer) { clearInterval(this.driftTimer); this.driftTimer = undefined; }
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
  }
}
