import type { AccountConfig, Config } from "../config";
import { logger } from "../logger";
import { TradovateClient, type ClientOptions } from "../tradovate/client";
import type { Account, Order, OrderVersion, PropsEvent } from "../tradovate/types";
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
  status: "pending" | "placed" | "canceled" | "skipped";
  followerOrderId?: number;
}

interface MirrorRecord {
  legs: MirrorLeg[];
  lastVersionId: number;
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

  constructor(cfg: Config) {
    this.cfg = cfg;
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
    this.masterClient = this.getClient(this.cfg.master);

    for (const f of this.cfg.followers) {
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

    // Connect every distinct login in parallel.
    log.info(
      `Starting on ${this.cfg.environment.toUpperCase()} — ` +
        `${this.clients.size} login(s), ${this.followers.length} follower account(s)` +
        (this.cfg.dryRun ? " [DRY-RUN]" : ""),
    );
    await Promise.all([...this.clients.values()].map((c) => c.start()));

    this.resolveAccounts();
    this.checkStartFlat();
    this.wireMaster();

    log.info("Copier is live. Place a trade on the master account to replicate it.");
  }

  private resolveAccounts(): void {
    const pick = (client: TradovateClient, wantId?: number, wantSpec?: string, label = "") => {
      const accts = client.accounts;
      const first = accts[0];
      if (!first) throw new Error(`[${label}] login has no trading accounts.`);
      const available = () => accts.map((a) => `${a.name}#${a.id}`).join(", ");
      // An explicitly requested account MUST exist on this login. Falling back
      // to "some other account" silently is how orders end up duplicated on the
      // wrong account — fail loudly instead.
      if (wantId && wantId > 0) {
        const acct = accts.find((a) => a.id === wantId);
        if (!acct) {
          throw new Error(
            `[${label}] accountId ${wantId} not found on this login (has: ${available()}). ` +
              `Wrong token for this account?`,
          );
        }
        return acct;
      }
      if (wantSpec) {
        const acct = accts.find((a) => a.name === wantSpec);
        if (!acct) {
          throw new Error(
            `[${label}] account "${wantSpec}" not found on this login (has: ${available()}). ` +
              `Wrong token for this account?`,
          );
        }
        return acct;
      }
      if (accts.length > 1) {
        log.warn(
          `[${label}] login has ${accts.length} accounts; defaulting to ${first.name}#${first.id}. ` +
            `Set accountId/accountSpec in config to be explicit.`,
        );
      }
      return first;
    };

    const mAcct = pick(this.masterClient, this.cfg.master.accountId, this.cfg.master.accountSpec, this.cfg.master.label);
    this.masterAccountId = mAcct.id;
    this.masterAccountSpec = mAcct.name;
    log.info(`Master account: ${mAcct.name}#${mAcct.id}`);

    for (let i = 0; i < this.followers.length; i++) {
      const f = this.followers[i]!;
      const fc = this.cfg.followers[i]!;
      const acct = pick(f.client, fc.accountId, fc.accountSpec, f.label);
      f.accountId = acct.id;
      f.accountSpec = acct.name;
      log.info(`Follower ${f.label}: ${acct.name}#${acct.id} (x${f.multiplier})`);
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
          leg.status = "skipped";
          log.error(`  ${f.label}: placeorder FAILED — ${String(err)}`);
        }
      }),
    );
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
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
  }
}
