import type { AccountConfig, Config, FollowerConfig } from "../config";
import type { LicenseGate } from "../license";
import { resolveRoster, isKnownSpec, setMasterSpec } from "../roster";
import { logger } from "../logger";
import { TradovateClient, type ClientOptions } from "../tradovate/client";
import type { Account, Order, OrderVersion, PropsEvent } from "../tradovate/types";
import { jwtClaims } from "../tradovate/tokenStore";
import { MasterBook } from "./masterBook";

const TERMINAL_CANCEL = new Set(["Canceled", "Cancelled", "Rejected", "Expired"]);
const FILLED = new Set(["Filled", "Completed"]);

interface Follower {
  label: string;
  client: TradovateClient;
  accountId: number;
  accountSpec: string;
  multiplier: number;
  symbolMap: Record<string, string>;
}

interface MirrorLeg {
  follower: Follower;
  qty: number;
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
}

const log = logger("engine");

export class CopierEngine {
  private cfg: Config;
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
      });
    }

    // Resolve accounts and wire the master as each login becomes ready — now at
    // startup, or later when the Copilink extension pushes a fresh token to a
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
          `They activate automatically when a fresh token arrives (Copilink extension) or on restart.`,
      );
    }
    log.info("Copier is live. Ready logins mirror immediately; place a trade on the master account.");
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
      const isMarketFill = FILLED.has(o.ordStatus) && v.orderType === "Market";
      if (!isWorking && !isMarketFill) return; // not actionable yet (PendingNew, etc.)

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
        const qty = Math.round(v.orderQty * f.multiplier);
        const leg: MirrorLeg = { follower: f, qty, status: "pending" };
        rec.legs.push(leg);
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
          const qty = Math.round(v.orderQty * leg.follower.multiplier);
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
        positions: this.masterAccountId ? this.masterClient.openPositions(this.masterAccountId) : [],
      },
      followers: this.followers.map((f) => ({
        label: f.label,
        account: f.accountSpec || null,
        accountId: f.accountId || null,
        multiplier: f.multiplier,
        connected: f.client.isReady,
        positions: f.accountId ? f.client.openPositions(f.accountId) : [],
      })),
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
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
  }
}
