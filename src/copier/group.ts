// Mode « sync » : PAS de compte maître. Le Copieur est le panneau d'ordre unique ; chaque
// ordre est envoyé à TOUS les comptes du groupe en parallèle, au même instant (les trames
// partent dos à dos sur les websockets déjà ouverts → écart entre comptes ≈ quelques ms).
//
//   Panneau (dashboard) ──► GroupEngine.placeGroupOrder ──► order/placeorder × N comptes
//                                                             (Promise.all, même tick)
//   Fill de CHAQUE compte ──► SL/TP posés à SON prix de fill (order/placeoco)
//   Position → 0 sur un compte ──► ses SL/TP orphelins sont annulés (garde)
//   Toutes les 3 s ──► contrôle de synchronisation (positions ÷ multiplicateur égales ?)
import { writeFileSync } from "node:fs";
import type { AccountEntry, Config } from "../config";
import type { LicenseGate } from "../license";
import { logger } from "../logger";
import { TradovateClient, type ClientOptions } from "../tradovate/client";
import type { Account, Fill, Order, OrderAction, OrderVersion, Position, PropsEvent } from "../tradovate/types";
import { jwtClaims } from "../tradovate/tokenStore";

const TERMINAL = new Set(["Canceled", "Cancelled", "Rejected", "Expired", "Filled", "Completed"]);
const TERMINAL_CANCEL = new Set(["Canceled", "Cancelled", "Rejected", "Expired"]);
/** Un écart de position doit persister ce délai avant d'être signalé (fills quasi simultanés
 *  mais pas strictement — la fenêtre normale ne doit pas alarmer). */
const SYNC_GRACE_MS = 6_000;
/** Un bracket en attente de fill est oublié au bout de ce délai (ordre limite jamais rempli
 *  reste couvert : on garde 12 h, largement plus qu'une séance). */
const PENDING_TTL_MS = 12 * 60 * 60_000;
const INSTRUMENT_TTL_MS = 10 * 60_000;

export type EntryType = "Market" | "Limit" | "Stop";
export type TimeInForce = "Day" | "GTC";

/** Ce que le panneau envoie. `qty` = quantité de base, multipliée par compte. */
export interface OrderRequest {
  symbol: string;
  action: OrderAction;
  qty: number;
  orderType: EntryType;
  price?: number;
  stopPrice?: number;
  tif?: TimeInForce;
  /** SL / TP en ticks, posés au fill de chaque compte (à son propre prix). */
  bracket?: { stopTicks?: number; targetTicks?: number };
}

export interface GroupLeg {
  label: string;
  spec: string;
  qty: number;
  status: "placed" | "failed" | "skipped" | "dry";
  orderId?: number;
  error?: string;
  /** ms entre le premier envoi du groupe et celui de ce compte (≈ 0 = simultané). */
  sentOffsetMs?: number;
  /** ms entre la demande et l'accusé de réception Tradovate pour ce compte. */
  ackMs?: number;
}

/** Une action de groupe, diffusée au journal du dashboard. */
export interface GroupEvent {
  ts: number;
  kind: "entry" | "bracket" | "exit" | "cancel" | "flatten" | "modify" | "blocked" | "info";
  groupId?: string;
  symbol?: string;
  action?: OrderAction;
  qty?: number;
  orderType?: string;
  price?: number;
  stopPrice?: number;
  ok: number;
  failed: number;
  skipped: number;
  legs: GroupLeg[];
  /** demande → dernier accusé de réception (tous comptes). */
  latencyMs?: number;
  /** écart entre le premier et le dernier envoi (la « simultanéité »). */
  spreadMs?: number;
  note?: string;
}

export interface Instrument {
  symbol: string;
  contractId: number;
  root: string;
  productName: string;
  tickSize: number;
  valuePerPoint: number;
  /** valeur d'un tick en devise du contrat ($ pour les futures US). */
  tickValue: number;
  fetchedAt: number;
}

interface GroupAccount {
  key: string; // spec (ou label) en minuscules — identifiant stable côté UI
  label: string;
  spec: string;
  accountId: number;
  client: TradovateClient;
  multiplier: number;
  enabled: boolean;
  environment: string;
}

interface PendingBracket {
  orderId: number;
  account: GroupAccount;
  symbol: string;
  entryAction: OrderAction;
  stopTicks?: number;
  targetTicks?: number;
  tickSize: number;
  tif: TimeInForce;
  groupId: string;
  createdAt: number;
  filledQty: number;
}

interface ExitOrder {
  orderId: number;
  account: GroupAccount;
  contractId: number;
  symbol: string;
  role: "stop" | "target";
  action: OrderAction;
  price: number;
  qty: number;
  groupId: string;
  siblingId?: number;
}

export interface ExitGroup {
  key: string;
  symbol: string;
  role: "stop" | "target";
  action: OrderAction;
  count: number;
  minPrice: number;
  maxPrice: number;
  accounts: Array<{ label: string; spec: string; price: number; qty: number; orderId: number }>;
}

export interface DesyncEntry {
  symbol: string;
  contractId: number;
  reference: number; // position normalisée (÷ multiplicateur) majoritaire
  accounts: Array<{ label: string; spec: string; actual: number; expected: number; delta: number }>;
}

const log = logger("group");

// --- helpers purs (testables) --------------------------------------------------

/** Quantité d'un compte : base × multiplicateur, arrondie VERS LE BAS (×0,5 d'1 lot → 0,
 *  jamais 1 : un multiplicateur fractionnaire réduit le risque, il ne l'arrondit pas). */
export function scaledQty(base: number, mult: number): number {
  return Math.max(0, Math.floor(base * mult + 1e-9));
}

/** Nombre de décimales d'un tick (0.25 → 2, 0.0001 → 4, 1 → 0). */
export function tickDecimals(tick: number): number {
  const s = String(tick);
  if (s.includes("e-")) return Number(s.split("e-")[1]) + (s.split(".")[1]?.length ?? 0);
  return (s.split(".")[1] ?? "").length;
}

/** Arrondit un prix au tick le plus proche (sans dérive flottante). */
export function roundToTick(price: number, tick: number): number {
  if (!tick) return price;
  return Number((Math.round(price / tick) * tick).toFixed(tickDecimals(tick)));
}

/** Prix des sorties d'un fill : stop du côté adverse, cible du côté favorable. */
export function exitPrices(
  entryAction: OrderAction,
  fillPrice: number,
  tick: number,
  stopTicks?: number,
  targetTicks?: number,
): { stop?: number; target?: number; exitAction: OrderAction } {
  const dir = entryAction === "Buy" ? 1 : -1;
  const out: { stop?: number; target?: number; exitAction: OrderAction } = {
    exitAction: entryAction === "Buy" ? "Sell" : "Buy",
  };
  if (stopTicks && stopTicks > 0) out.stop = roundToTick(fillPrice - dir * stopTicks * tick, tick);
  if (targetTicks && targetTicks > 0) out.target = roundToTick(fillPrice + dir * targetTicks * tick, tick);
  return out;
}

/** Racine produit d'un contrat : MNQZ6 → MNQ, ESH27 → ES, 6EU6 → 6E. */
export function productRoot(symbol: string): string {
  const m = symbol.toUpperCase().match(/^(.+?)[FGHJKMNQUVXZ]\d{1,2}$/);
  return m ? m[1]! : symbol.toUpperCase().slice(0, Math.max(1, symbol.length - 2));
}

/** Valeur majoritaire d'une liste (égalité → la plus grande en valeur absolue, puis la
 *  première vue) : sert de référence pour dire QUI est désynchronisé. */
export function majority(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && best !== undefined && Math.abs(v) > Math.abs(best))) {
      best = v;
      bestN = n;
    }
  }
  return best ?? 0;
}

/** Écarts de synchronisation sur UN contrat : chaque compte prêt devrait porter
 *  référence × multiplicateur (référence = position normalisée majoritaire). */
export function computeDesync(
  rows: Array<{ label: string; spec: string; multiplier: number; netPos: number }>,
): Array<{ label: string; spec: string; actual: number; expected: number; delta: number }> & { reference: number } {
  const usable = rows.filter((r) => r.multiplier > 0);
  const normalized = usable.map((r) => r.netPos / r.multiplier);
  const reference = majority(normalized.map((n) => Number(n.toFixed(6))));
  const out = usable
    .map((r) => {
      const expected = Math.sign(reference) * Math.floor(Math.abs(reference) * r.multiplier + 1e-9);
      return { label: r.label, spec: r.spec, actual: r.netPos, expected, delta: r.netPos - expected };
    })
    .filter((r) => r.delta !== 0) as Array<{ label: string; spec: string; actual: number; expected: number; delta: number }> & { reference: number };
  out.reference = reference;
  return out;
}

const uid = (): string => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

export class GroupEngine {
  private cfg: Config;
  private configPath = "";
  private clients = new Map<string, TradovateClient>();
  private wired = new Set<TradovateClient>();
  private accounts: GroupAccount[] = [];
  private resolved = new Set<string>();
  private gate?: LicenseGate;
  private locked = false;
  private listeners = new Set<(e: GroupEvent) => void>();

  private pendingBrackets = new Map<number, PendingBracket>();
  /** Fills reçus AVANT la réponse au placement (même trame websocket) : on les garde
   *  quelques secondes pour poser le SL/TP dès que l'orderId est connu. */
  private earlyFills = new Map<number, { client: TradovateClient; fills: Fill[]; at: number }>();
  private exits = new Map<number, ExitOrder>();
  private instruments = new Map<string, Instrument>();
  private recentSymbols: string[] = [];

  private syncTimer?: NodeJS.Timeout;
  private syncSince = new Map<string, { since: number; logged: boolean }>();
  private confirmedDesync: DesyncEntry[] = [];

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  setLicenseGate(gate: LicenseGate): void {
    this.gate = gate;
  }
  setPersistPath(path: string): void {
    this.configPath = path;
  }

  /** Verrou du panneau : aucune ENTRÉE tant qu'il est posé (annulations / mise à plat
   *  restent possibles — un verrou ne doit jamais empêcher de sortir). */
  setLocked(on: boolean): void {
    this.locked = on;
    log.info(on ? "Panneau VERROUILLÉ — aucune entrée ne partira." : "Panneau déverrouillé.");
  }
  get isLocked(): boolean {
    return this.locked;
  }

  // --- démarrage ------------------------------------------------------------------

  private getClient(acct: AccountEntry): TradovateClient {
    const auth = this.cfg.auth;
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
      key = `token|${environment}|${pastedToken}`;
      opts = { ...common, accessToken: pastedToken };
    } else if (acct.name && acct.password) {
      key = `cred|${environment}|${acct.name}`;
      opts = { ...common, name: acct.name, password: acct.password, cid: acct.cid ?? auth.cid, sec: acct.sec ?? auth.sec };
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

  private keyOf(spec: string | undefined, label: string): string {
    return (spec || label || "").toLowerCase();
  }

  async start(): Promise<void> {
    for (const a of this.cfg.accounts) {
      const client = this.getClient(a);
      this.accounts.push({
        key: this.keyOf(a.accountSpec, a.label),
        label: a.label,
        spec: a.accountSpec ?? "",
        accountId: a.accountId ?? 0,
        client,
        multiplier: a.multiplier ?? 1,
        enabled: a.enabled !== false,
        environment: a.environment ?? this.cfg.environment,
      });
    }
    for (const c of this.clients.values()) {
      c.onStatus((s) => {
        if (s === "ready") this.onLoginReady(c);
      });
    }
    log.info(
      `Mode SYNC — ${this.clients.size} login(s), ${this.accounts.length} compte(s) dans le groupe` +
        (this.cfg.dryRun ? " [DRY-RUN : aucun ordre réel]" : ""),
    );
    const results = await Promise.allSettled([...this.clients.values()].map((c) => c.start()));
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      log.warn(
        `${failed}/${this.clients.size} login(s) non authentifié(s) (token expiré ?). ` +
          `Ils s'activent dès qu'un token frais arrive (extension Let Trade Copieur).`,
      );
    }
    log.info("Groupe prêt. Les ordres du panneau partent sur tous les comptes cochés, en même temps.");
    this.syncTimer = setInterval(() => {
      try { this.evaluateSync(); } catch (err) { log.warn(`sync eval: ${String(err)}`); }
      this.purgePending();
    }, 3_000);
  }

  private pick(client: TradovateClient, wantId: number | undefined, wantSpec: string | undefined, label: string): Account {
    const accts = client.accounts;
    const first = accts[0];
    if (!first) throw new Error(`[${label}] login has no trading accounts.`);
    const available = () => accts.map((a) => `${a.name}#${a.id}`).join(", ");
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
    if (accts.length > 1) log.warn(`[${label}] login has ${accts.length} accounts; defaulting to ${first.name}#${first.id}.`);
    return first;
  }

  private onLoginReady(client: TradovateClient): void {
    if (!this.wired.has(client)) {
      this.wired.add(client);
      client.onEntity((ev) => this.onEntity(client, ev));
    }
    for (const a of this.accounts) {
      if (a.client !== client || this.resolved.has(a.key)) continue;
      const cfgEntry = this.cfg.accounts.find((c) => this.keyOf(c.accountSpec, c.label) === a.key);
      try {
        const acct = this.pick(client, cfgEntry?.accountId, cfgEntry?.accountSpec || a.spec || undefined, a.label);
        a.accountId = acct.id;
        a.spec = acct.name;
        this.resolved.add(a.key);
        log.info(`Compte ${a.label}: ${acct.name}#${acct.id} (×${a.multiplier}${a.enabled ? "" : ", hors groupe"})`);
      } catch (err) {
        log.warn(`Compte ${a.label} non résolu : ${String(err)}`);
      }
    }
  }

  // --- flux d'entités (fills → brackets, ordres → cycle de vie, positions → garde) ---

  private onEntity(client: TradovateClient, ev: PropsEvent): void {
    if (ev.eventType === "Snapshot") return;
    switch (ev.entityType) {
      case "fill":
        void this.onFill(client, ev.entity as unknown as Fill);
        return;
      case "order":
        this.onOrder(client, ev.entity as unknown as Order);
        return;
      case "orderVersion":
        this.onVersion(ev.entity as unknown as OrderVersion);
        return;
      case "position":
        this.onPosition(client, ev.entity as unknown as Position);
        return;
      default:
        return;
    }
  }

  private async onFill(client: TradovateClient, fill: Fill): Promise<void> {
    if (typeof fill.orderId !== "number") return;
    if (!fill.qty || typeof fill.price !== "number") return;
    const pb = this.pendingBrackets.get(fill.orderId);
    if (!pb) {
      // Peut-être un fill d'une entrée dont la réponse placeorder n'est pas encore traitée.
      const e = this.earlyFills.get(fill.orderId) ?? { client, fills: [], at: Date.now() };
      e.fills.push(fill);
      this.earlyFills.set(fill.orderId, e);
      return;
    }
    if (pb.account.client !== client) return;
    pb.filledQty += fill.qty;
    const px = exitPrices(pb.entryAction, fill.price, pb.tickSize, pb.stopTicks, pb.targetTicks);
    if (px.stop === undefined && px.target === undefined) return;
    const a = pb.account;
    const t0 = Date.now();
    const leg: GroupLeg = { label: a.label, spec: a.spec, qty: fill.qty, status: "placed" };
    try {
      if (this.cfg.dryRun) {
        leg.status = "dry";
        log.info(`  [DRY] ${a.label}: SL/TP ${pb.symbol} fill ${fill.price} → stop ${px.stop ?? "—"} · cible ${px.target ?? "—"}`);
      } else if (px.stop !== undefined && px.target !== undefined) {
        const body = {
          accountId: a.accountId,
          accountSpec: a.spec,
          action: px.exitAction,
          symbol: pb.symbol,
          orderQty: fill.qty,
          orderType: "Stop",
          stopPrice: px.stop,
          timeInForce: pb.tif,
          isAutomated: true,
          other: { action: px.exitAction, orderType: "Limit", price: px.target, timeInForce: pb.tif },
        };
        const res = await a.client.request("order/placeoco", body);
        const d = (res.d ?? {}) as Record<string, any>;
        if (d.failureReason || d.failureText) throw new Error(String(d.failureText || d.failureReason));
        const stopId = Number(d.orderId);
        const targetId = Number(d.ocoId);
        if (stopId) this.registerExit({ orderId: stopId, account: a, contractId: fill.contractId, symbol: pb.symbol, role: "stop", action: px.exitAction, price: px.stop, qty: fill.qty, groupId: pb.groupId, siblingId: targetId || undefined });
        if (targetId) this.registerExit({ orderId: targetId, account: a, contractId: fill.contractId, symbol: pb.symbol, role: "target", action: px.exitAction, price: px.target, qty: fill.qty, groupId: pb.groupId, siblingId: stopId || undefined });
        leg.orderId = stopId || undefined;
        leg.ackMs = Date.now() - t0;
        log.info(`  ${a.label}: SL/TP posés (${pb.symbol} fill ${fill.price} → stop ${px.stop} · cible ${px.target}) #${stopId}/#${targetId}`);
      } else {
        const role: "stop" | "target" = px.stop !== undefined ? "stop" : "target";
        const price = (px.stop ?? px.target)!;
        const body: Record<string, unknown> = {
          accountId: a.accountId,
          accountSpec: a.spec,
          action: px.exitAction,
          symbol: pb.symbol,
          orderQty: fill.qty,
          orderType: role === "stop" ? "Stop" : "Limit",
          timeInForce: pb.tif,
          isAutomated: true,
        };
        if (role === "stop") body.stopPrice = price; else body.price = price;
        const res = await a.client.request("order/placeorder", body);
        const d = (res.d ?? {}) as Record<string, any>;
        if (d.failureReason || d.failureText) throw new Error(String(d.failureText || d.failureReason));
        const id = Number(d.orderId);
        if (id) this.registerExit({ orderId: id, account: a, contractId: fill.contractId, symbol: pb.symbol, role, action: px.exitAction, price, qty: fill.qty, groupId: pb.groupId });
        leg.orderId = id || undefined;
        leg.ackMs = Date.now() - t0;
        log.info(`  ${a.label}: ${role === "stop" ? "stop" : "cible"} posé(e) ${pb.symbol} @${price} #${id}`);
      }
    } catch (err) {
      leg.status = "failed";
      leg.error = String((err as Error)?.message || err);
      log.error(`  ${a.label}: SL/TP ÉCHEC — ${leg.error}`);
    }
    this.emit({
      ts: Date.now(),
      kind: "bracket",
      groupId: pb.groupId,
      symbol: pb.symbol,
      action: px.exitAction,
      qty: fill.qty,
      price: px.target,
      stopPrice: px.stop,
      ok: leg.status === "failed" ? 0 : 1,
      failed: leg.status === "failed" ? 1 : 0,
      skipped: 0,
      legs: [leg],
      note: `fill ${a.label} @${fill.price}`,
    });
  }

  private registerExit(x: ExitOrder): void {
    this.exits.set(x.orderId, x);
  }

  private onOrder(client: TradovateClient, o: Order): void {
    if (typeof o.id !== "number") return;
    // Cycle de vie des sorties SL/TP posées par le groupe.
    const x = this.exits.get(o.id);
    if (x && x.account.client === client) {
      if (TERMINAL.has(o.ordStatus)) {
        this.exits.delete(o.id);
        if (o.ordStatus === "Filled") {
          this.emit({
            ts: Date.now(),
            kind: "exit",
            groupId: x.groupId,
            symbol: x.symbol,
            action: x.action,
            qty: x.qty,
            price: x.role === "target" ? x.price : undefined,
            stopPrice: x.role === "stop" ? x.price : undefined,
            ok: 1,
            failed: 0,
            skipped: 0,
            legs: [{ label: x.account.label, spec: x.account.spec, qty: x.qty, status: "placed", orderId: o.id }],
            note: x.role === "stop" ? "stop exécuté" : "cible atteinte",
          });
          log.info(`${x.account.label}: ${x.role === "stop" ? "STOP exécuté" : "CIBLE atteinte"} ${x.symbol} @${x.price}`);
        }
      }
      return;
    }
    // Jumeau OCO d'une sortie connue (si la réponse placeoco n'a pas donné l'ocoId).
    if (o.ocoId && this.exits.has(o.ocoId) && !TERMINAL.has(o.ordStatus)) {
      const s = this.exits.get(o.ocoId)!;
      if (s.account.client === client && s.account.accountId === o.accountId) {
        const v = client.orderVersion(o.id);
        const role: "stop" | "target" = s.role === "stop" ? "target" : "stop";
        this.registerExit({
          orderId: o.id,
          account: s.account,
          contractId: o.contractId,
          symbol: s.symbol,
          role,
          action: o.action,
          price: v ? (role === "stop" ? v.stopPrice ?? 0 : v.price ?? 0) : 0,
          qty: v?.orderQty ?? s.qty,
          groupId: s.groupId,
          siblingId: s.orderId,
        });
        s.siblingId = o.id;
      }
      return;
    }
    // Entrée annulée / rejetée avant fill → plus de bracket à poser.
    const pb = this.pendingBrackets.get(o.id);
    if (pb && pb.account.client === client && TERMINAL_CANCEL.has(o.ordStatus)) this.pendingBrackets.delete(o.id);
  }

  private onVersion(v: OrderVersion): void {
    const x = this.exits.get(v.orderId);
    if (!x) return;
    const p = x.role === "stop" ? v.stopPrice : v.price;
    if (typeof p === "number") x.price = p;
    if (typeof v.orderQty === "number") x.qty = v.orderQty;
  }

  /** Garde anti-orphelins : un compte revenu À PLAT sur un contrat (sortie manuelle dans
   *  Tradovate, stop d'un autre outil…) ne doit pas garder un SL/TP qui rouvrirait une
   *  position inverse. On attend 400 ms (le temps que l'OCO annule son jumeau tout seul),
   *  on re-vérifie, puis on annule ce qui reste. */
  private onPosition(client: TradovateClient, p: Position): void {
    if (typeof p.accountId !== "number" || typeof p.contractId !== "number") return;
    if (p.netPos) return;
    const acct = this.accounts.find((a) => a.client === client && a.accountId === p.accountId);
    if (!acct) return;
    setTimeout(() => {
      const still = client.openPositions(p.accountId).some((q) => q.contractId === p.contractId && q.netPos);
      if (still) return;
      const orphans = [...this.exits.values()].filter((x) => x.account === acct && x.contractId === p.contractId);
      for (const x of orphans) {
        const live = client.order(x.orderId);
        if (live && TERMINAL.has(live.ordStatus)) { this.exits.delete(x.orderId); continue; }
        this.exits.delete(x.orderId);
        if (this.cfg.dryRun) continue;
        client.request("order/cancelorder", { orderId: x.orderId }).then(
          () => log.info(`${acct.label}: ${x.role === "stop" ? "stop" : "cible"} orphelin(e) annulé(e) (#${x.orderId}, compte à plat)`),
          (err) => log.debug(`${acct.label}: annulation orphelin #${x.orderId} : ${String(err)}`),
        );
      }
    }, 400);
  }

  private purgePending(): void {
    const now = Date.now();
    for (const [id, pb] of this.pendingBrackets) if (now - pb.createdAt > PENDING_TTL_MS) this.pendingBrackets.delete(id);
    for (const [id, e] of this.earlyFills) if (now - e.at > 15_000) this.earlyFills.delete(id);
  }

  /** Après enregistrement d'un bracket en attente : rejoue les fills arrivés trop tôt. */
  private replayEarlyFills(orderId: number): void {
    const e = this.earlyFills.get(orderId);
    if (!e) return;
    this.earlyFills.delete(orderId);
    for (const f of e.fills) void this.onFill(e.client, f);
  }

  // --- instruments -------------------------------------------------------------------

  private anyReadyClient(): TradovateClient | undefined {
    return [...this.clients.values()].find((c) => c.isReady);
  }

  /** Suggestions de contrats pour un préfixe tapé dans le panneau. */
  async suggest(text: string): Promise<string[]> {
    const q = text.trim().toUpperCase();
    if (!q) return [];
    const c = this.anyReadyClient();
    if (!c) return [];
    try {
      const list = await c.suggestContracts(q, 10);
      const names = list.map((x) => x.name).filter(Boolean);
      return [...new Set(names)];
    } catch (err) {
      log.debug(`suggest ${q}: ${String(err)}`);
      return [];
    }
  }

  /** Résout un contrat + son produit (tick, valeur du point). Mis en cache 10 min. */
  async resolveInstrument(symbol: string): Promise<Instrument> {
    const sym = symbol.trim().toUpperCase();
    if (!sym) throw new Error("instrument manquant");
    const cached = this.instruments.get(sym);
    if (cached && Date.now() - cached.fetchedAt < INSTRUMENT_TTL_MS) return cached;
    const c = this.anyReadyClient();
    if (!c) throw new Error("aucun compte connecté pour résoudre l'instrument");
    const contract = await c.findContract(sym);
    if (!contract) throw new Error(`contrat inconnu : ${sym}`);
    const root = productRoot(contract.name);
    const product = await c.findProduct(root);
    if (!product) throw new Error(`produit inconnu pour ${contract.name} (${root})`);
    const inst: Instrument = {
      symbol: contract.name,
      contractId: contract.id,
      root,
      productName: product.description || product.name,
      tickSize: product.tickSize,
      valuePerPoint: product.valuePerPoint,
      tickValue: Number((product.tickSize * product.valuePerPoint).toFixed(6)),
      fetchedAt: Date.now(),
    };
    this.instruments.set(sym, inst);
    this.instruments.set(contract.name, inst);
    return inst;
  }

  // --- l'ordre de groupe ---------------------------------------------------------

  /** Envoie l'ordre à TOUS les comptes cochés en parallèle. Les trames partent dos à dos
   *  (même boucle d'événements) → `spreadMs` mesure l'écart réel entre le 1er et le dernier
   *  envoi. Les SL/TP éventuels sont mémorisés et posés au fill de chaque compte. */
  async placeGroupOrder(req: OrderRequest): Promise<GroupEvent> {
    const symbol = String(req.symbol || "").trim().toUpperCase();
    const qty = Math.floor(Number(req.qty));
    const base: Omit<GroupEvent, "ok" | "failed" | "skipped" | "legs"> = {
      ts: Date.now(),
      kind: "entry",
      symbol,
      action: req.action,
      qty,
      orderType: req.orderType,
      price: req.price,
      stopPrice: req.stopPrice,
    };
    const blocked = (note: string): GroupEvent => {
      const e: GroupEvent = { ...base, kind: "blocked", ok: 0, failed: 0, skipped: 0, legs: [], note };
      log.warn(`Entrée bloquée — ${note}`);
      this.emit(e);
      return e;
    };
    if (!symbol) return blocked("instrument manquant");
    if (!qty || qty < 1) return blocked("quantité invalide");
    if (req.action !== "Buy" && req.action !== "Sell") return blocked("sens invalide");
    if (!["Market", "Limit", "Stop"].includes(req.orderType)) return blocked("type d'ordre invalide");
    if (req.orderType === "Limit" && !(typeof req.price === "number" && req.price > 0)) return blocked("prix limite manquant");
    if (req.orderType === "Stop" && !(typeof req.stopPrice === "number" && req.stopPrice > 0)) return blocked("prix stop manquant");
    if (this.locked) return blocked("panneau verrouillé");
    if (this.gate && !this.gate.licensed) return blocked("abonnement Edge requis");

    const wantBracket = !!(req.bracket && ((req.bracket.stopTicks ?? 0) > 0 || (req.bracket.targetTicks ?? 0) > 0));
    let inst: Instrument | undefined;
    if (wantBracket) {
      try { inst = await this.resolveInstrument(symbol); }
      catch (err) { return blocked(`SL/TP impossibles : ${String((err as Error)?.message || err)}`); }
    }
    const tif: TimeInForce = req.tif === "GTC" ? "GTC" : "Day";
    const groupId = uid();
    const targets = this.accounts.filter((a) => a.enabled);
    if (!targets.length) return blocked("aucun compte coché dans le groupe");

    log.info(
      `GROUPE ${req.action.toUpperCase()} ${qty} ${symbol} ${req.orderType}` +
        (req.price ? ` @${req.price}` : "") + (req.stopPrice ? ` stop ${req.stopPrice}` : "") +
        (wantBracket ? ` · SL ${req.bracket?.stopTicks ?? "—"} / TP ${req.bracket?.targetTicks ?? "—"} ticks` : "") +
        ` → ${targets.length} compte(s)`,
    );

    const t0 = Date.now();
    let firstSent = 0;
    let lastSent = 0;
    let lastAck = t0;
    const legs: GroupLeg[] = [];
    await Promise.all(
      targets.map(async (a) => {
        const q = scaledQty(qty, a.multiplier);
        const leg: GroupLeg = { label: a.label, spec: a.spec, qty: q, status: "placed" };
        legs.push(leg);
        if (!a.client.isReady || !a.accountId) {
          leg.status = "skipped";
          leg.error = "déconnecté";
          return;
        }
        if (q <= 0) {
          leg.status = "skipped";
          leg.error = "quantité 0 (multiplicateur)";
          return;
        }
        const body: Record<string, unknown> = {
          accountId: a.accountId,
          accountSpec: a.spec,
          action: req.action,
          symbol,
          orderQty: q,
          orderType: req.orderType,
          isAutomated: true,
          timeInForce: tif,
        };
        if (req.orderType === "Limit") body.price = req.price;
        if (req.orderType === "Stop") body.stopPrice = req.stopPrice;
        if (this.cfg.dryRun) {
          leg.status = "dry";
          const sent = Date.now();
          firstSent = firstSent || sent;
          lastSent = sent;
          log.info(`  [DRY] ${a.label}: ${req.action} ${q} ${symbol} ${req.orderType}`);
          return;
        }
        const sent = Date.now();
        firstSent = firstSent || sent;
        lastSent = sent;
        leg.sentOffsetMs = sent - firstSent;
        try {
          const res = await a.client.request("order/placeorder", body);
          const ack = Date.now();
          leg.ackMs = ack - sent;
          lastAck = Math.max(lastAck, ack);
          const d = (res.d ?? {}) as Record<string, any>;
          if (d.failureReason || d.failureText) throw new Error(String(d.failureText || d.failureReason));
          leg.orderId = Number(d.orderId) || undefined;
          if (wantBracket && leg.orderId && inst) {
            this.pendingBrackets.set(leg.orderId, {
              orderId: leg.orderId,
              account: a,
              symbol: inst.symbol,
              entryAction: req.action,
              stopTicks: req.bracket?.stopTicks,
              targetTicks: req.bracket?.targetTicks,
              tickSize: inst.tickSize,
              tif,
              groupId,
              createdAt: Date.now(),
              filledQty: 0,
            });
            this.replayEarlyFills(leg.orderId);
          }
          log.info(`  ${a.label}: ordre #${leg.orderId} (${q} ${symbol}) en ${leg.ackMs} ms`);
        } catch (err) {
          leg.status = "failed";
          leg.error = String((err as Error)?.message || err);
          log.error(`  ${a.label}: ÉCHEC — ${leg.error}`);
        }
      }),
    );
    // Ordre d'affichage stable (celui du groupe), pas l'ordre d'achèvement des promesses.
    legs.sort((x, y) => targets.findIndex((a) => a.spec === x.spec) - targets.findIndex((a) => a.spec === y.spec));
    this.rememberSymbol(symbol);
    const ev: GroupEvent = {
      ...base,
      groupId,
      ok: legs.filter((l) => l.status === "placed" || l.status === "dry").length,
      failed: legs.filter((l) => l.status === "failed").length,
      skipped: legs.filter((l) => l.status === "skipped").length,
      legs,
      latencyMs: this.cfg.dryRun ? 0 : lastAck - t0,
      spreadMs: firstSent ? lastSent - firstSent : 0,
      note: wantBracket ? `SL ${req.bracket?.stopTicks ?? "—"} / TP ${req.bracket?.targetTicks ?? "—"} ticks au fill` : undefined,
    };
    this.emit(ev);
    return ev;
  }

  private rememberSymbol(symbol: string): void {
    this.recentSymbols = [symbol, ...this.recentSymbols.filter((s) => s !== symbol)].slice(0, 6);
  }

  // --- sorties SL/TP groupées -------------------------------------------------------

  exitGroups(): ExitGroup[] {
    const map = new Map<string, ExitGroup>();
    for (const x of this.exits.values()) {
      const key = `${x.symbol}|${x.role}|${x.action}`;
      let g = map.get(key);
      if (!g) {
        g = { key, symbol: x.symbol, role: x.role, action: x.action, count: 0, minPrice: x.price, maxPrice: x.price, accounts: [] };
        map.set(key, g);
      }
      g.count++;
      g.minPrice = Math.min(g.minPrice, x.price);
      g.maxPrice = Math.max(g.maxPrice, x.price);
      g.accounts.push({ label: x.account.label, spec: x.account.spec, price: x.price, qty: x.qty, orderId: x.orderId });
    }
    return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol) || a.role.localeCompare(b.role));
  }

  /** Déplace TOUTES les sorties d'un groupe (ex. tous les stops MNQZ6) au même prix. */
  async modifyExits(key: string, price: number): Promise<{ ok: boolean; modified: number; errors: string[] }> {
    const list = [...this.exits.values()].filter((x) => `${x.symbol}|${x.role}|${x.action}` === key);
    if (!list.length) return { ok: false, modified: 0, errors: ["aucune sortie pour ce groupe"] };
    if (!(typeof price === "number" && price > 0)) return { ok: false, modified: 0, errors: ["prix invalide"] };
    const inst = this.instruments.get(list[0]!.symbol);
    const px = inst ? roundToTick(price, inst.tickSize) : price;
    const errors: string[] = [];
    let modified = 0;
    const legs: GroupLeg[] = [];
    await Promise.all(
      list.map(async (x) => {
        const leg: GroupLeg = { label: x.account.label, spec: x.account.spec, qty: x.qty, status: "placed", orderId: x.orderId };
        legs.push(leg);
        const body: Record<string, unknown> = { orderId: x.orderId, orderQty: x.qty, orderType: x.role === "stop" ? "Stop" : "Limit", isAutomated: true };
        if (x.role === "stop") body.stopPrice = px; else body.price = px;
        if (this.cfg.dryRun) { leg.status = "dry"; modified++; x.price = px; return; }
        try {
          const res = await x.account.client.request("order/modifyorder", body);
          const d = (res.d ?? {}) as Record<string, any>;
          if (d.failureReason || d.failureText) throw new Error(String(d.failureText || d.failureReason));
          x.price = px;
          modified++;
        } catch (err) {
          leg.status = "failed";
          leg.error = String((err as Error)?.message || err);
          errors.push(`${x.account.label}: ${leg.error}`);
        }
      }),
    );
    log.info(`${list[0]!.role === "stop" ? "Stops" : "Cibles"} ${list[0]!.symbol} → ${px} : ${modified}/${list.length} modifié(s)` + (errors.length ? ` · ${errors.length} erreur(s)` : ""));
    this.emit({
      ts: Date.now(),
      kind: "modify",
      symbol: list[0]!.symbol,
      action: list[0]!.action,
      orderType: list[0]!.role === "stop" ? "Stop" : "Limit",
      price: list[0]!.role === "target" ? px : undefined,
      stopPrice: list[0]!.role === "stop" ? px : undefined,
      ok: modified,
      failed: errors.length,
      skipped: 0,
      legs,
      note: list[0]!.role === "stop" ? "stops déplacés" : "cibles déplacées",
    });
    return { ok: errors.length === 0, modified, errors };
  }

  async cancelExits(key: string): Promise<{ ok: boolean; canceled: number; errors: string[] }> {
    const list = [...this.exits.values()].filter((x) => `${x.symbol}|${x.role}|${x.action}` === key);
    if (!list.length) return { ok: false, canceled: 0, errors: ["aucune sortie pour ce groupe"] };
    const errors: string[] = [];
    let canceled = 0;
    await Promise.all(
      list.map(async (x) => {
        if (this.cfg.dryRun) { this.exits.delete(x.orderId); canceled++; return; }
        try {
          await x.account.client.request("order/cancelorder", { orderId: x.orderId });
          this.exits.delete(x.orderId);
          canceled++;
        } catch (err) {
          errors.push(`${x.account.label}: ${String((err as Error)?.message || err)}`);
        }
      }),
    );
    log.info(`Sorties ${key} annulées : ${canceled}/${list.length}`);
    this.emit({ ts: Date.now(), kind: "cancel", symbol: list[0]!.symbol, ok: canceled, failed: errors.length, skipped: 0, legs: [], note: `${list[0]!.role === "stop" ? "stops" : "cibles"} annulé(e)s` });
    return { ok: errors.length === 0, canceled, errors };
  }

  // --- annulation / mise à plat ------------------------------------------------------

  private targetsFor(spec?: string): GroupAccount[] {
    if (!spec) return this.accounts;
    const key = spec.toLowerCase();
    return this.accounts.filter((a) => a.key === key || a.spec.toLowerCase() === key || a.label.toLowerCase() === key);
  }

  /** Annule tous les ordres en attente (entrées ET sorties) d'un compte, ou de tous. */
  async cancelOrders(spec?: string): Promise<{ ok: boolean; accounts: number; canceled: number; skipped: string[]; errors: string[] }> {
    const targets = this.targetsFor(spec);
    if (!targets.length) return { ok: false, accounts: 0, canceled: 0, skipped: [], errors: [`compte inconnu : ${spec}`] };
    const skipped: string[] = [];
    const errors: string[] = [];
    let canceled = 0;
    await Promise.all(
      targets.map(async (a) => {
        if (!a.client.isReady || !a.accountId) { skipped.push(a.label); return; }
        for (const o of a.client.workingOrders(a.accountId)) {
          this.pendingBrackets.delete(o.id);
          this.exits.delete(o.id);
          if (this.cfg.dryRun) { canceled++; continue; }
          try { await a.client.request("order/cancelorder", { orderId: o.id }); canceled++; }
          catch (err) { errors.push(`${a.label} #${o.id}: ${String((err as Error)?.message || err)}`); }
        }
      }),
    );
    const processed = targets.length - skipped.length;
    log.info(`Annulation${spec ? ` ${spec}` : " groupe"} → ${canceled} ordre(s) annulé(s) sur ${processed} compte(s)` + (errors.length ? ` · ${errors.length} erreur(s)` : ""));
    this.emit({ ts: Date.now(), kind: "cancel", ok: canceled, failed: errors.length, skipped: skipped.length, legs: [], note: spec ? `ordres annulés · ${spec}` : "tous les ordres annulés" });
    return { ok: errors.length === 0, accounts: processed, canceled, skipped, errors };
  }

  /** Met à plat un compte, ou tout le groupe : annule les ordres puis clôture les positions
   *  AU MARCHÉ. Tous les comptes en parallèle. */
  async flatten(spec?: string): Promise<{ ok: boolean; accounts: number; canceled: number; flattened: number; skipped: string[]; errors: string[] }> {
    const targets = this.targetsFor(spec);
    if (!targets.length) return { ok: false, accounts: 0, canceled: 0, flattened: 0, skipped: [], errors: [`compte inconnu : ${spec}`] };
    const skipped: string[] = [];
    const errors: string[] = [];
    let canceled = 0;
    let flattened = 0;
    const legs: GroupLeg[] = [];
    await Promise.all(
      targets.map(async (a) => {
        if (!a.client.isReady || !a.accountId) { skipped.push(a.label); return; }
        for (const o of a.client.workingOrders(a.accountId)) {
          this.pendingBrackets.delete(o.id);
          this.exits.delete(o.id);
          if (this.cfg.dryRun) { canceled++; continue; }
          try { await a.client.request("order/cancelorder", { orderId: o.id }); canceled++; }
          catch (err) { errors.push(`${a.label} annul #${o.id}: ${String((err as Error)?.message || err)}`); }
        }
        for (const p of a.client.openPositions(a.accountId)) {
          const leg: GroupLeg = { label: a.label, spec: a.spec, qty: Math.abs(p.netPos), status: "placed" };
          legs.push(leg);
          if (this.cfg.dryRun) { leg.status = "dry"; flattened++; continue; }
          try {
            await a.client.request("order/liquidateposition", { accountId: a.accountId, contractId: p.contractId, admin: false });
            flattened++;
          } catch (err) {
            leg.status = "failed";
            leg.error = String((err as Error)?.message || err);
            errors.push(`${a.label} flatten ${p.symbol}: ${leg.error}`);
          }
        }
      }),
    );
    const processed = targets.length - skipped.length;
    log.info(`Mise à plat${spec ? ` ${spec}` : " GROUPE"} → ${processed} compte(s) · ${canceled} ordre(s) annulé(s) · ${flattened} position(s) clôturée(s)` +
      (skipped.length ? ` · ${skipped.length} ignoré(s) (déconnecté)` : "") + (errors.length ? ` · ${errors.length} erreur(s)` : ""));
    this.emit({ ts: Date.now(), kind: "flatten", ok: flattened, failed: errors.length, skipped: skipped.length, legs, note: spec ? `à plat · ${spec}` : "tout le groupe à plat" });
    return { ok: errors.length === 0, accounts: processed, canceled, flattened, skipped, errors };
  }

  // --- synchronisation -----------------------------------------------------------------

  private evaluateSync(): void {
    const now = Date.now();
    const ready = this.accounts.filter((a) => a.enabled && a.client.isReady && a.accountId && a.multiplier > 0);
    const byContract = new Map<number, { symbol: string; rows: Map<string, number> }>();
    for (const a of ready) {
      for (const p of a.client.openPositions(a.accountId)) {
        if (!p.netPos) continue;
        let c = byContract.get(p.contractId);
        if (!c) { c = { symbol: p.symbol, rows: new Map() }; byContract.set(p.contractId, c); }
        if (!p.symbol.startsWith("#")) c.symbol = p.symbol;
        c.rows.set(a.key, p.netPos);
      }
    }
    const seen = new Set<string>();
    const confirmed: DesyncEntry[] = [];
    const sgn = (n: number) => (n >= 0 ? "+" : "") + n;
    for (const [contractId, c] of byContract) {
      const rows = ready.map((a) => ({ label: a.label, spec: a.spec, multiplier: a.multiplier, netPos: c.rows.get(a.key) ?? 0 }));
      const bad = computeDesync(rows);
      const entries: DesyncEntry["accounts"] = [];
      for (const d of bad) {
        const key = `${contractId}|${d.spec}`;
        seen.add(key);
        let rec = this.syncSince.get(key);
        if (!rec) { rec = { since: now, logged: false }; this.syncSince.set(key, rec); }
        if (now - rec.since >= SYNC_GRACE_MS) {
          entries.push(d);
          if (!rec.logged) {
            rec.logged = true;
            log.warn(`⚠ DÉSYNC ${d.label} ${c.symbol} : porte ${sgn(d.actual)}, attendu ${sgn(d.expected)} (écart ${sgn(d.delta)})`);
          }
        }
      }
      if (entries.length) confirmed.push({ symbol: c.symbol, contractId, reference: bad.reference, accounts: entries });
    }
    for (const key of [...this.syncSince.keys()]) if (!seen.has(key)) this.syncSince.delete(key);
    this.confirmedDesync = confirmed;
  }

  // --- administration des comptes -----------------------------------------------------

  private findAccount(spec: string): GroupAccount | undefined {
    const key = (spec || "").toLowerCase();
    return this.accounts.find((a) => a.key === key || a.spec.toLowerCase() === key || a.label.toLowerCase() === key);
  }
  private findCfg(a: GroupAccount): AccountEntry | undefined {
    return this.cfg.accounts.find(
      (c) => this.keyOf(c.accountSpec, c.label) === a.key || (!!c.accountId && c.accountId === a.accountId) || c.label.toLowerCase() === a.label.toLowerCase(),
    );
  }

  setAccountSettings(spec: string, patch: { enabled?: boolean; multiplier?: number }): { ok: boolean; error?: string } {
    const a = this.findAccount(spec);
    if (!a) return { ok: false, error: `Compte inconnu : ${spec}` };
    if (patch.multiplier !== undefined) {
      const m = Number(patch.multiplier);
      if (!Number.isFinite(m) || m < 0 || m > 100) return { ok: false, error: "Multiplicateur invalide (0 à 100)." };
    }
    const fc = this.findCfg(a);
    if (!fc) return { ok: false, error: `Entrée config introuvable pour ${spec} — réglage non sauvegardé.` };
    if (patch.multiplier !== undefined) { a.multiplier = Number(patch.multiplier); fc.multiplier = a.multiplier; }
    if (patch.enabled !== undefined) { a.enabled = !!patch.enabled; fc.enabled = a.enabled; }
    this.persistConfig();
    log.info(`Compte ${a.label} → ${a.enabled ? "dans le groupe" : "hors groupe"} ×${a.multiplier}`);
    return { ok: true };
  }

  removeAccount(spec: string): { ok: boolean; error?: string } {
    const a = this.findAccount(spec);
    if (!a) return { ok: false, error: `Compte inconnu : ${spec}` };
    this.cfg.accounts = this.cfg.accounts.filter((c) => c !== this.findCfg(a));
    this.accounts = this.accounts.filter((x) => x !== a);
    this.resolved.delete(a.key);
    const removed = new Set(this.cfg.removedSpecs ?? []);
    if (a.spec) removed.add(a.spec);
    removed.add(a.label);
    this.cfg.removedSpecs = [...removed];
    if (this.cfg.accountOrder) this.cfg.accountOrder = this.cfg.accountOrder.filter((s) => s.toLowerCase() !== a.key);
    this.persistConfig();
    log.info(`Compte retiré : ${a.label} (${this.accounts.length} restant(s)).`);
    return { ok: true };
  }

  restoreAccount(spec: string): { ok: boolean; error?: string } {
    const key = (spec || "").toLowerCase();
    const before = this.cfg.removedSpecs ?? [];
    const after = before.filter((s) => String(s).toLowerCase() !== key);
    if (after.length === before.length) return { ok: false, error: `Compte non masqué : ${spec}` };
    this.cfg.removedSpecs = after;
    this.persistConfig();
    return { ok: true };
  }

  reorderAccounts(orderedSpecs: string[]): { ok: boolean; error?: string } {
    if (!Array.isArray(orderedSpecs)) return { ok: false, error: "ordre invalide" };
    this.cfg.accountOrder = orderedSpecs.map((s) => String(s));
    this.persistConfig();
    return { ok: true };
  }

  async refreshAccount(spec: string): Promise<{ ok: boolean; connected: boolean; resolved: boolean; error?: string }> {
    const a = this.findAccount(spec);
    if (!a) return { ok: false, connected: false, resolved: false, error: `Compte inconnu : ${spec}` };
    try {
      await a.client.refresh();
      this.onLoginReady(a.client);
      return { ok: true, connected: a.client.isReady, resolved: !!a.accountId };
    } catch (err) {
      return { ok: false, connected: a.client.isReady, resolved: !!a.accountId, error: String((err as Error)?.message || err) };
    }
  }

  async rescanAccounts(): Promise<{ added: number; total: number; names: string[] }> {
    await Promise.all([...this.clients.values()].map((c) => c.reSyncAccounts().catch(() => undefined)));
    const known = new Set<string>(this.accounts.flatMap((a) => [a.key, a.label.toLowerCase(), a.spec.toLowerCase()]));
    const knownId = new Set<number>(this.accounts.map((a) => a.accountId).filter(Boolean));
    const removed = new Set((this.cfg.removedSpecs ?? []).map((s) => s.toLowerCase()));
    const added: string[] = [];
    for (const client of this.clients.values()) {
      for (const acct of client.accounts) {
        const k = acct.name.toLowerCase();
        if (knownId.has(acct.id) || known.has(k) || removed.has(k)) continue;
        const entry: AccountEntry = { label: acct.name, accountSpec: acct.name, multiplier: 1, enabled: true, accessToken: client.seedToken, environment: client.env };
        this.cfg.accounts.push(entry);
        this.accounts.push({ key: k, label: acct.name, spec: acct.name, accountId: acct.id, client, multiplier: 1, enabled: true, environment: client.env });
        this.resolved.add(k);
        knownId.add(acct.id);
        known.add(k);
        added.push(acct.name);
        log.info(`Nouveau compte détecté → ajouté au groupe : ${acct.name}#${acct.id}`);
      }
    }
    if (added.length) this.persistConfig();
    return { added: added.length, total: this.accounts.length, names: added };
  }

  private displayAccounts(): GroupAccount[] {
    const order = this.cfg.accountOrder;
    if (!order || !order.length) return this.accounts;
    const rank = new Map(order.map((s, idx) => [String(s).toLowerCase(), idx]));
    return this.accounts
      .map((a, idx) => ({ a, idx }))
      .sort((x, y) => (rank.get(x.a.key) ?? order.length + x.idx) - (rank.get(y.a.key) ?? order.length + y.idx))
      .map((x) => x.a);
  }

  private persistConfig(): void {
    if (!this.configPath) return;
    try {
      // Le format persistant est `accounts` ; les champs maître/followers historiques sont
      // retirés (dérivés automatiquement au chargement si le mode mirror est réactivé).
      const { master: _m, followers: _f, followerOrder: _o, ...rest } = this.cfg;
      writeFileSync(this.configPath, JSON.stringify({ ...rest, mode: "sync" }, null, 2));
      log.info(`Config mise à jour → ${this.accounts.length} compte(s).`);
    } catch (err) {
      log.warn(`Persist config échouée : ${String(err)}`);
    }
  }

  // --- pont extension / dashboard -------------------------------------------------------

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

  status(): Array<{ label: string; userId: number; ready: boolean; sub?: string }> {
    return [...this.clients.values()].map((c) => ({ label: c.label, userId: c.userId, ready: c.isReady, sub: c.sub }));
  }

  dashboardState() {
    const accounts = this.displayAccounts();
    const nameById = new Map<number, string>();
    const allPos = accounts.map((a) => (a.accountId ? a.client.openPositions(a.accountId) : []));
    for (const ps of allPos) for (const p of ps) if (!p.symbol.startsWith("#")) nameById.set(p.contractId, p.symbol);
    const named = <T extends { symbol: string; contractId: number }>(ps: T[]): T[] =>
      ps.map((p) => (p.symbol.startsWith("#") && nameById.has(p.contractId) ? { ...p, symbol: nameById.get(p.contractId)! } : p));
    const desyncBySpec = new Map<string, Array<{ symbol: string; actual: number; expected: number; delta: number }>>();
    for (const d of this.confirmedDesync) {
      for (const acc of d.accounts) {
        const list = desyncBySpec.get(acc.spec) ?? [];
        list.push({ symbol: d.symbol, actual: acc.actual, expected: acc.expected, delta: acc.delta });
        desyncBySpec.set(acc.spec, list);
      }
    }
    const exitsByAccount = new Map<string, number>();
    for (const x of this.exits.values()) exitsByAccount.set(x.account.key, (exitsByAccount.get(x.account.key) ?? 0) + 1);
    const connected = accounts.filter((a) => a.client.isReady).length;
    return {
      mode: "sync" as const,
      environment: this.cfg.environment,
      dryRun: this.cfg.dryRun,
      locked: this.locked,
      license: this.gate?.status() ?? null,
      connected,
      total: accounts.length,
      accounts: accounts.map((a, i) => {
        const working = a.accountId ? a.client.workingOrders(a.accountId) : [];
        return {
          label: a.label,
          spec: a.spec || null,
          key: a.key,
          accountId: a.accountId || null,
          environment: a.environment,
          connected: a.client.isReady,
          resolved: !!a.accountId,
          enabled: a.enabled,
          multiplier: a.multiplier,
          positions: named(allPos[i]!),
          workingOrders: working.length,
          exits: exitsByAccount.get(a.key) ?? 0,
          pendingBrackets: [...this.pendingBrackets.values()].filter((p) => p.account === a).length,
          desync: desyncBySpec.get(a.spec) ?? [],
        };
      }),
      exits: this.exitGroups(),
      desync: this.confirmedDesync,
      recentSymbols: this.recentSymbols,
      removedSpecs: [...(this.cfg.removedSpecs ?? [])],
    };
  }

  onEvent(h: (e: GroupEvent) => void): void {
    this.listeners.add(h);
  }
  private emit(e: GroupEvent): void {
    for (const h of this.listeners) {
      try { h(e); } catch (err) { log.error(`event handler threw: ${String(err)}`); }
    }
  }

  async stop(): Promise<void> {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = undefined; }
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
  }
}
