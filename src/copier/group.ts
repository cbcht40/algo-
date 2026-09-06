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
import { MarketDataClient, type Quote } from "../tradovate/marketData";
import type { JournalLink, ScoreRequest } from "../journal";
import type { Account, Environment, Fill, Order, OrderAction, OrderVersion, Position, PropsEvent } from "../tradovate/types";
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
/** Un échec réseau est relancé automatiquement si le compte revient dans ce délai. */
const AUTO_RETRY_WINDOW_MS = 90_000;
const MAX_AUTO_ATTEMPTS = 2;
/** Un symbole surveillé par le panneau reste abonné ce temps après la dernière demande. */
const WATCH_TTL_MS = 3 * 60_000;
/** Garde-fou du relais : délai avant d'évaluer un fill d'origine inconnue (le temps que la
 *  réponse Tradovate au placement — donc l'orderId source — soit relayée), fenêtre pendant
 *  laquelle les autres comptes doivent avoir « bougé » pour être considérés synchrones,
 *  fenêtre de couverture d'un relais récent, durée de mémoire des ordres connus. */
const GUARD_GRACE_MS = 1_200;
const GUARD_MOVED_WINDOW_MS = 2_500;
const GUARD_TEE_WINDOW_MS = 20_000;
const KNOWN_TTL_MS = 6 * 60 * 60_000;

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
/** Une action qui a ÉCHOUÉ sur un compte (ordre refusé, socket fermé…). Visible tant
 *  qu'elle n'est pas résolue ; relancée automatiquement quand la cause est réseau. */
export interface Incident {
  id: string;
  ts: number;
  kind: "entry" | "bracket" | "modify" | "cancel" | "flatten" | "relay";
  label: string;
  spec: string;
  symbol?: string;
  action?: OrderAction;
  qty?: number;
  error: string;
  /** vrai = erreur de transport (socket fermé / timeout) → relance auto à la reconnexion. */
  auto: boolean;
  /** vrai = position potentiellement sans protection ou non clôturée. */
  critical: boolean;
  attempts: number;
  status: "open" | "retrying" | "resolved" | "ignored";
  resolvedAt?: number;
}

export interface GroupEvent {
  ts: number;
  kind: "entry" | "bracket" | "exit" | "cancel" | "flatten" | "modify" | "blocked" | "info" | "retry";
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
  /** prix d'entrée du compte (fill) — sert au breakeven. */
  fillPrice?: number;
}

/** Erreur de transport (pas un refus Tradovate) → une relance a des chances d'aboutir. */
export function isTransportError(err: unknown): boolean {
  const s = String((err as Error)?.message || err || "").toLowerCase();
  return /socket (not open|closed)|timeout|econn|network|not open/.test(s);
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

// --- relais Tradovate (ordre intercepté dans le navigateur par l'extension) ------------

/** Message poussé par l'extension : la requête d'ordre telle que le navigateur l'envoie
 *  (kind "request"), puis la réponse Tradovate (kind "response") pour mémoriser l'orderId
 *  source → les modifications / annulations suivantes peuvent être mappées exactement. */
export interface RelayMessage {
  kind: "request" | "response";
  teeId: string;
  endpoint?: string;
  body?: Record<string, any>;
  /** Horodatage (ms epoch) de l'interception dans le navigateur. */
  t?: number;
  status?: number;
  data?: Record<string, any>;
  via?: string;
}

interface TeeLeg {
  account: GroupAccount;
  qty: number;
  status: "placed" | "failed" | "skipped" | "dry";
  orderId?: number;
  ocoId?: number;
  strategyId?: number;
  error?: string;
}

interface TeeRecord {
  teeId: string;
  ts: number;
  source: GroupAccount;
  endpoint: string;
  symbol?: string;
  sourceOrderId?: number;
  sourceOcoId?: number;
  sourceStrategyId?: number;
  legs: TeeLeg[];
}

const RELAY_ENTRY = new Set(["order/placeorder", "order/placeoco", "order/placeoso", "orderstrategy/startorderstrategy"]);

/** Quantité relayée : qty_source × mult_cible ÷ mult_source, arrondie VERS LE BAS
 *  (mult source 0 ou absent → 1). Ex. source ×1 qty 2 → cible ×3 = 6 ; cible ×0,5 = 1. */
export function relayQty(sourceQty: number, sourceMult: number, targetMult: number): number {
  const sm = sourceMult > 0 ? sourceMult : 1;
  return Math.max(0, Math.floor((Number(sourceQty) || 0) * targetMult / sm + 1e-9));
}

/** Rescale les quantités d'un `params` de stratégie Tradovate (entryVersion + brackets). */
export function scaleStrategyParams(params: string, qtyOf: (q: number) => number): { params: string; entryQty: number; entry?: Record<string, any> } {
  try {
    const p = JSON.parse(params);
    const entry = p?.entryVersion;
    const q0 = Number(entry?.orderQty) || 0;
    const q1 = qtyOf(q0);
    if (entry) entry.orderQty = q1;
    if (Array.isArray(p?.brackets)) {
      for (const b of p.brackets) if (b && typeof b.qty === "number") b.qty = Math.max(0, Math.min(q1, qtyOf(b.qty)));
    }
    return { params: JSON.stringify(p), entryQty: q1, entry };
  } catch {
    return { params, entryQty: 0 };
  }
}

/** Corps de la requête pour un compte cible : même ordre, compte + quantité changés.
 *  null = rien à envoyer (quantité 0). */
export function teeBody(
  endpoint: string,
  body: Record<string, any>,
  target: { accountId: number; spec: string },
  qtyOf: (q: number) => number,
): Record<string, unknown> | null {
  const ep = endpoint.toLowerCase();
  if (ep === "orderstrategy/startorderstrategy") {
    const s = scaleStrategyParams(String(body.params ?? ""), qtyOf);
    if (s.entryQty <= 0) return null;
    return { ...body, accountId: target.accountId, accountSpec: target.spec, params: s.params, uuid: cryptoUuid(), isAutomated: true };
  }
  if (ep === "order/liquidateposition") {
    return { accountId: target.accountId, contractId: body.contractId, admin: false };
  }
  const qty = qtyOf(Number(body.orderQty) || 0);
  if (qty <= 0) return null;
  const out: Record<string, unknown> = { ...body, accountId: target.accountId, accountSpec: target.spec, orderQty: qty, isAutomated: true };
  delete out.uuid;
  return out;
}

function cryptoUuid(): string {
  try { return (globalThis.crypto as any).randomUUID(); } catch { return uid() + "-" + uid(); }
}

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
  /** Mode « même prix » : le PREMIER fill d'un ordre de groupe fixe la référence (prix
   *  d'entrée, stop, objectif) pour TOUS les comptes → une seule ligne de stop. */
  private bracketRef = new Map<string, { price: number; stop?: number; target?: number; at: number }>();
  private exits = new Map<number, ExitOrder>();
  private instruments = new Map<string, Instrument>();
  private recentSymbols: string[] = [];

  private syncTimer?: NodeJS.Timeout;
  private syncSince = new Map<string, { since: number; logged: boolean }>();
  private confirmedDesync: DesyncEntry[] = [];

  /** Relais Tradovate (ordres interceptés dans le navigateur). */
  private relayEnabled = true;
  private tees = new Map<string, TeeRecord>();
  private bySourceOrder = new Map<number, TeeRecord>();
  private relayStats = { lastSeenAt: 0, count: 0, lastDelayMs: undefined as number | undefined, extensionSeenAt: 0 };
  /** Garde-fou du relais : ordres créés / relayés par le copieur (id → date), couvertures
   *  « stratégie » (compte|symbole → date : les ordres engendrés par une stratégie Tradovate
   *  n'ont pas d'id connu), fills récents (les autres comptes ont-ils bougé ensemble ?). */
  private known = new Map<number, number>();
  private strategyCover = new Map<string, number>();
  private recentFills: Array<{ client: TradovateClient; fill: Fill; at: number }> = [];
  private seenFills = new Map<number, number>();
  private guardMode: NonNullable<Config["relayGuard"]> = "auto";
  private guardGraceMs = GUARD_GRACE_MS;
  private guardStats = { caught: 0, lastAt: 0 };

  /** Incidents (échecs par compte) + leur relance. */
  private incidents = new Map<string, Incident & { retry: () => Promise<void>; account: GroupAccount }>();
  /** Lien avec Let-Trade Journal (synchro des trades clôturés + avis IA à l'entrée). */
  private journal?: JournalLink;
  /** Flux de marché (cotations) : un socket, alimenté par le token du premier login prêt. */
  private md?: MarketDataClient;
  private watched = new Map<string, number>(); // symbole surveillé par le panneau → dernier vu
  private mdWanted = new Map<string, number | undefined>(); // symbole → contractId
  private chartWanted = new Map<string, { symbol: string; tf: number; at: number }>(); // graphiques demandés (TTL)

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.relayEnabled = cfg.relay !== false;
    this.guardMode = cfg.relayGuard === "alert" || cfg.relayGuard === "off" ? cfg.relayGuard : "auto";
  }

  /** L'extension vient de parler au pont (token ou relais) : sert à l'indicateur du dashboard. */
  noteExtension(): void {
    this.relayStats.extensionSeenAt = Date.now();
  }

  setRelay(on: boolean): void {
    this.relayEnabled = on;
    this.cfg.relay = on;
    this.persistConfig();
    log.info(on ? "Relais Tradovate ACTIVÉ — un ordre passé dans le navigateur part aussi sur les autres comptes." : "Relais Tradovate désactivé.");
  }
  get isRelayEnabled(): boolean {
    return this.relayEnabled;
  }

  /** Garde-fou du relais : "auto" (entrées rattrapées au marché), "alert" (incident + bip,
   *  rattrapage sur clic), "off". */
  setRelayGuard(mode: string): NonNullable<Config["relayGuard"]> {
    const m: NonNullable<Config["relayGuard"]> = mode === "alert" || mode === "off" ? mode : "auto";
    this.guardMode = m;
    this.cfg.relayGuard = m;
    this.persistConfig();
    log.info(m === "off" ? "Garde-fou du relais désactivé." : m === "alert" ? "Garde-fou du relais : alerte seule (rattrapage sur clic)." : "Garde-fou du relais : rattrapage automatique des entrées.");
    return m;
  }
  get relayGuardMode(): NonNullable<Config["relayGuard"]> {
    return this.guardMode;
  }

  /** Mémorise un ordre créé ou relayé par le copieur : le garde-fou ne le prendra jamais pour
   *  un ordre passé en dehors du relais. */
  private remember(...ids: Array<number | undefined | null>): void {
    const now = Date.now();
    for (const id of ids) if (typeof id === "number" && id > 0) this.known.set(id, now);
    if (this.known.size > 5000) {
      for (const [id, at] of this.known) if (now - at > KNOWN_TTL_MS) this.known.delete(id);
      while (this.known.size > 5000) this.known.delete(this.known.keys().next().value as number);
    }
  }

  /** Une stratégie Tradovate (entrée + brackets côté serveur) tourne sur ce compte et ce
   *  symbole : ses ordres n'ont pas d'id connu, ils sont couverts jusqu'au retour à plat. */
  private coverStrategy(a: GroupAccount, symbol?: string): void {
    if (symbol) this.strategyCover.set(`${a.key}|${symbol.toUpperCase()}`, Date.now());
  }

  setLicenseGate(gate: LicenseGate): void {
    this.gate = gate;
  }

  setJournal(j: JournalLink): void {
    this.journal = j;
  }

  /** Synchro manuelle du journal (bouton du dashboard). */
  journalSyncNow(force = true) {
    return this.journal ? this.journal.syncNow(force, "manual") : Promise.resolve(null);
  }

  /** Demande l'avis IA sur une entrée (après envoi, jamais bloquant) et le journalise. */
  private askScore(req: ScoreRequest): void {
    if (!this.journal?.enabled) return;
    void this.journal.scoreEntry(req).then((r) => {
      if (!r) return;
      this.emit({
        ts: Date.now(),
        kind: "info",
        symbol: req.symbol,
        action: req.action,
        qty: req.qty,
        ok: r.error ? 0 : 1,
        failed: r.error ? 1 : 0,
        skipped: 0,
        legs: [],
        note: r.error ? `avis IA indisponible — ${r.error}` : `Avis IA ${r.score}/100 · ${r.headline}`,
      });
    });
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
      c = this.makeClient(opts);
      this.clients.set(key, c);
    }
    return c;
  }

  /** Fabrique de clients (remplaçable dans les tests). */
  private makeClient(opts: ClientOptions): TradovateClient {
    return new TradovateClient(opts);
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
      try { this.ensureMarketData(); this.reconcileMarketData(); } catch (err) { log.debug(`md: ${String(err)}`); }
      void this.retrySweep();
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
    this.ensureMarketData();
    // Login revenu : relance les échecs réseau récents de ses comptes.
    for (const inc of this.incidents.values()) {
      if (inc.status === "open" && inc.auto && inc.account.client === client && Date.now() - inc.ts < AUTO_RETRY_WINDOW_MS && inc.attempts < MAX_AUTO_ATTEMPTS) {
        void this.retryIncident(inc.id, true);
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
    this.guardObserve(client, fill);
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
    // Même prix pour tout le groupe : le premier fill fixe la référence ; les fills suivants
    // (autres comptes, à ±1 tick) reprennent EXACTEMENT le même stop et le même objectif.
    let px: ReturnType<typeof exitPrices>;
    let refPrice = fill.price;
    if (this.cfg.bracketMode !== "sameDistance") {
      let ref = this.bracketRef.get(pb.groupId);
      if (!ref) {
        const first = exitPrices(pb.entryAction, fill.price, pb.tickSize, pb.stopTicks, pb.targetTicks);
        ref = { price: fill.price, stop: first.stop, target: first.target, at: Date.now() };
        this.bracketRef.set(pb.groupId, ref);
      }
      refPrice = ref.price;
      px = { exitAction: pb.entryAction === "Buy" ? "Sell" : "Buy", stop: ref.stop, target: ref.target };
      if (fill.price !== ref.price) log.info(`  ${pb.account.label}: fill @${fill.price} → SL/TP alignés sur la référence du groupe @${ref.price}`);
    } else {
      px = exitPrices(pb.entryAction, fill.price, pb.tickSize, pb.stopTicks, pb.targetTicks);
    }
    if (px.stop === undefined && px.target === undefined) return;
    const a = pb.account;
    const refFill: Fill = { ...fill, price: refPrice };
    const leg = await this.placeBracket(pb, refFill, px);
    if (leg.status === "failed") {
      this.addIncident({
        kind: "bracket", account: a, symbol: pb.symbol, action: px.exitAction, qty: fill.qty, error: leg.error || "échec",
        critical: true, auto: isTransportError(leg.error),
        retry: async () => {
          const l2 = await this.placeBracket(pb, refFill, px);
          if (l2.status === "failed") throw new Error(l2.error || "échec");
        },
      });
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

  /** Pose le SL/TP d'un fill (OCO si les deux, ordre simple sinon). Réutilisé par la relance. */
  private async placeBracket(pb: PendingBracket, fill: Fill, px: ReturnType<typeof exitPrices>): Promise<GroupLeg> {
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
        this.remember(stopId, targetId);
        if (stopId) this.registerExit({ orderId: stopId, account: a, contractId: fill.contractId, symbol: pb.symbol, role: "stop", action: px.exitAction, price: px.stop, qty: fill.qty, groupId: pb.groupId, siblingId: targetId || undefined, fillPrice: fill.price });
        if (targetId) this.registerExit({ orderId: targetId, account: a, contractId: fill.contractId, symbol: pb.symbol, role: "target", action: px.exitAction, price: px.target, qty: fill.qty, groupId: pb.groupId, siblingId: stopId || undefined, fillPrice: fill.price });
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
        this.remember(id);
        if (id) this.registerExit({ orderId: id, account: a, contractId: fill.contractId, symbol: pb.symbol, role, action: px.exitAction, price, qty: fill.qty, groupId: pb.groupId, fillPrice: fill.price });
        leg.orderId = id || undefined;
        leg.ackMs = Date.now() - t0;
        log.info(`  ${a.label}: ${role === "stop" ? "stop" : "cible"} posé(e) ${pb.symbol} @${price} #${id}`);
      }
    } catch (err) {
      leg.status = "failed";
      leg.error = String((err as Error)?.message || err);
      log.error(`  ${a.label}: SL/TP ÉCHEC — ${leg.error}`);
    }
    return leg;
  }

  private registerExit(x: ExitOrder): void {
    this.exits.set(x.orderId, x);
  }

  private onOrder(client: TradovateClient, o: Order): void {
    if (typeof o.id !== "number") return;
    // Enfant d'un ordre connu (bracket OSO, jumeau OCO, ordre lié) → connu lui aussi.
    if (!this.known.has(o.id) && ((o.parentId && this.known.has(o.parentId)) || (o.ocoId && this.known.has(o.ocoId)) || (o.linkedId && this.known.has(o.linkedId)))) this.remember(o.id);
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
          fillPrice: s.fillPrice,
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
    // Position clôturée → le journal tire le trade tout de suite (regroupé sur 8 s).
    this.journal?.positionClosed(acct.label);
    setTimeout(() => {
      const still = client.openPositions(p.accountId).some((q) => q.contractId === p.contractId && q.netPos);
      if (still) return;
      const sym = client.symbolOf(p.contractId);
      if (sym) this.strategyCover.delete(`${acct.key}|${sym.toUpperCase()}`);
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
    for (const [id, r] of this.bracketRef) if (now - r.at > PENDING_TTL_MS) this.bracketRef.delete(id);
    for (const [k, at] of this.strategyCover) if (now - at > PENDING_TTL_MS) this.strategyCover.delete(k);
    for (const [id, at] of this.seenFills) if (now - at > 10 * 60_000) this.seenFills.delete(id);
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
          this.remember(leg.orderId);
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
          this.addIncident({
            kind: "entry", account: a, symbol, action: req.action, qty: q, error: leg.error, critical: false, auto: isTransportError(err),
            retry: async () => {
              const res = await a.client.request("order/placeorder", body);
              const d = (res.d ?? {}) as Record<string, any>;
              if (d.failureReason || d.failureText) throw new Error(String(d.failureText || d.failureReason));
              const id = Number(d.orderId) || undefined;
              this.remember(id);
              if (wantBracket && id && inst) {
                this.pendingBrackets.set(id, { orderId: id, account: a, symbol: inst.symbol, entryAction: req.action, stopTicks: req.bracket?.stopTicks, targetTicks: req.bracket?.targetTicks, tickSize: inst.tickSize, tif, groupId, createdAt: Date.now(), filledQty: 0 });
                this.replayEarlyFills(id);
              }
            },
          });
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
    if (ev.ok > 0) {
      const q = this.md?.quote(symbol);
      this.askScore({
        symbol, action: req.action, qty, orderType: req.orderType,
        price: req.price ?? req.stopPrice ?? q?.last ?? undefined,
        stopTicks: req.bracket?.stopTicks, targetTicks: req.bracket?.targetTicks, tickSize: inst?.tickSize ?? this.instruments.get(symbol)?.tickSize,
        accounts: ev.ok, source: "panneau", ts: Date.now(),
      });
    }
    return ev;
  }

  private rememberSymbol(symbol: string): void {
    this.recentSymbols = [symbol, ...this.recentSymbols.filter((s) => s !== symbol)].slice(0, 6);
  }

  // --- relais Tradovate --------------------------------------------------------------

  private accountByIds(accountId?: unknown, accountSpec?: unknown): GroupAccount | undefined {
    const id = Number(accountId) || 0;
    const spec = String(accountSpec ?? "").toLowerCase();
    return this.accounts.find((a) => (id && a.accountId === id) || (spec && (a.spec.toLowerCase() === spec || a.label.toLowerCase() === spec)));
  }

  /** Point d'entrée du pont : un ordre (ou sa réponse) intercepté dans le navigateur. */
  async relay(msg: RelayMessage): Promise<{ ok: boolean; note?: string; event?: GroupEvent }> {
    this.noteExtension();
    if (!msg || !msg.teeId) return { ok: false, note: "message invalide" };
    if (msg.kind === "response") {
      const rec = this.tees.get(msg.teeId);
      if (!rec) return { ok: false, note: "tee inconnu" };
      const d = msg.data ?? {};
      if (d.orderId) { rec.sourceOrderId = Number(d.orderId); this.bySourceOrder.set(rec.sourceOrderId, rec); }
      if (d.ocoId) { rec.sourceOcoId = Number(d.ocoId); this.bySourceOrder.set(rec.sourceOcoId, rec); }
      if (d.orderStrategy?.id) { rec.sourceStrategyId = Number(d.orderStrategy.id); this.coverStrategy(rec.source, rec.symbol); }
      this.remember(Number(d.orderId) || undefined, Number(d.ocoId) || undefined);
      return { ok: true };
    }
    if (this.tees.has(msg.teeId)) return { ok: false, note: "doublon" };
    const endpoint = String(msg.endpoint || "").toLowerCase();
    const body = msg.body ?? {};
    const delay = typeof msg.t === "number" && msg.t > 0 ? Math.max(0, Date.now() - msg.t) : undefined;
    this.relayStats.lastSeenAt = Date.now();
    this.relayStats.count++;
    this.relayStats.lastDelayMs = delay;
    if (RELAY_ENTRY.has(endpoint)) return this.relayEntry(msg.teeId, endpoint, body, delay);
    if (endpoint === "order/modifyorder") return this.relayModifyOrCancel("modify", body, delay);
    if (endpoint === "order/cancelorder") return this.relayModifyOrCancel("cancel", body, delay);
    if (endpoint === "order/liquidateposition") return this.relayLiquidate(body, delay);
    return { ok: false, note: `endpoint ignoré : ${endpoint}` };
  }

  private relayNote(source: GroupAccount, delay?: number, extra?: string): string {
    return `relais Tradovate · ${source.label}` + (delay !== undefined ? ` · relais ${delay} ms` : "") + (extra ? ` · ${extra}` : "");
  }

  private async relayEntry(teeId: string, endpoint: string, body: Record<string, any>, delay?: number): Promise<{ ok: boolean; note?: string; event?: GroupEvent }> {
    const source = this.accountByIds(body.accountId, body.accountSpec);
    if (!source) {
      log.debug(`relais : compte source inconnu (${body.accountSpec ?? body.accountId}) — ignoré`);
      return { ok: false, note: "compte source hors du copieur" };
    }
    if (!source.enabled) {
      log.info(`relais : ${source.label} est hors groupe — ordre non relayé`);
      return { ok: false, note: "compte source hors groupe" };
    }
    // Description de l'ordre source (pour le journal).
    let qty = Number(body.orderQty) || 0;
    let orderType = String(body.orderType ?? "");
    let price = typeof body.price === "number" ? body.price : undefined;
    let stopPrice = typeof body.stopPrice === "number" ? body.stopPrice : undefined;
    let extra = endpoint === "order/placeoco" ? "OCO" : endpoint === "order/placeoso" ? "OSO" : undefined;
    if (endpoint === "orderstrategy/startorderstrategy") {
      const s = scaleStrategyParams(String(body.params ?? ""), (q) => q);
      qty = s.entryQty;
      orderType = String(s.entry?.orderType ?? "");
      price = typeof s.entry?.price === "number" ? s.entry.price : undefined;
      stopPrice = typeof s.entry?.stopPrice === "number" ? s.entry.stopPrice : undefined;
      extra = "brackets";
    }
    const symbol = String(body.symbol ?? "").toUpperCase();
    const action: OrderAction = body.action === "Sell" ? "Sell" : "Buy";
    const base: Omit<GroupEvent, "ok" | "failed" | "skipped" | "legs"> = { ts: Date.now(), kind: "entry", symbol, action, qty, orderType, price, stopPrice };
    const blocked = (why: string) => {
      const e: GroupEvent = { ...base, kind: "blocked", ok: 0, failed: 0, skipped: 0, legs: [], note: this.relayNote(source, delay, why) };
      log.warn(`Relais bloqué — ${why} (${source.label} ${action} ${qty} ${symbol})`);
      this.emit(e);
      return { ok: false, note: why, event: e };
    };
    if (!this.relayEnabled) return blocked("relais désactivé");
    if (this.locked) return blocked("panneau verrouillé");
    if (this.gate && !this.gate.licensed) return blocked("abonnement Edge requis");

    const targets = this.accounts.filter((a) => a.enabled && a !== source);
    const rec: TeeRecord = { teeId, ts: Date.now(), source, endpoint, symbol, legs: [] };
    this.tees.set(teeId, rec);
    if (this.tees.size > 500) this.tees.delete(this.tees.keys().next().value as string);
    if (endpoint === "orderstrategy/startorderstrategy") this.coverStrategy(source, symbol);
    log.info(`RELAIS ${source.label} ${action.toUpperCase()} ${qty} ${symbol} ${orderType}${extra ? ` (${extra})` : ""}` + (delay !== undefined ? ` · ${delay} ms depuis le navigateur` : "") + ` → ${targets.length} autre(s) compte(s)`);

    const t0 = Date.now();
    let firstSent = 0, lastSent = 0, lastAck = t0;
    const legs: GroupLeg[] = [];
    await Promise.all(
      targets.map(async (a) => {
        const qtyOf = (q: number) => relayQty(q, source.multiplier, a.multiplier);
        const tb = teeBody(endpoint, body, { accountId: a.accountId, spec: a.spec }, qtyOf);
        const q = tb ? Number((tb as any).orderQty ?? qtyOf(qty)) || qtyOf(qty) : 0;
        const leg: GroupLeg = { label: a.label, spec: a.spec, qty: q, status: "placed" };
        const tl: TeeLeg = { account: a, qty: q, status: "placed" };
        legs.push(leg);
        rec.legs.push(tl);
        if (!a.client.isReady || !a.accountId) { leg.status = tl.status = "skipped"; leg.error = "déconnecté"; return; }
        if (!tb) { leg.status = tl.status = "skipped"; leg.error = "quantité 0 (multiplicateur)"; return; }
        const sent = Date.now();
        firstSent = firstSent || sent;
        lastSent = sent;
        leg.sentOffsetMs = sent - firstSent;
        if (this.cfg.dryRun) { leg.status = tl.status = "dry"; log.info(`  [DRY] ${a.label}: ${endpoint} ${JSON.stringify(tb)}`); return; }
        try {
          const res = await a.client.request(endpoint === "orderstrategy/startorderstrategy" ? "orderStrategy/startOrderStrategy" : endpoint, tb);
          const ack = Date.now();
          leg.ackMs = ack - sent;
          lastAck = Math.max(lastAck, ack);
          const d = (res.d ?? {}) as Record<string, any>;
          if (d.failureReason || d.failureText || d.errorText) throw new Error(String(d.failureText || d.failureReason || d.errorText));
          tl.orderId = Number(d.orderId) || undefined;
          tl.ocoId = Number(d.ocoId) || undefined;
          tl.strategyId = Number(d.orderStrategy?.id) || undefined;
          this.remember(tl.orderId, tl.ocoId);
          if (tl.strategyId) this.coverStrategy(a, symbol);
          leg.orderId = tl.orderId ?? tl.strategyId;
          log.info(`  ${a.label}: relayé #${leg.orderId ?? "?"} (${q} ${symbol}) en ${leg.ackMs} ms`);
        } catch (err) {
          leg.status = tl.status = "failed";
          leg.error = tl.error = String((err as Error)?.message || err);
          log.error(`  ${a.label}: relais ÉCHEC — ${leg.error}`);
          const ep = endpoint === "orderstrategy/startorderstrategy" ? "orderStrategy/startOrderStrategy" : endpoint;
          this.addIncident({
            kind: "entry", account: a, symbol, action, qty: q, error: leg.error, critical: false, auto: isTransportError(err),
            retry: async () => {
              const res = await a.client.request(ep, tb);
              const d = (res.d ?? {}) as Record<string, any>;
              if (d.failureReason || d.failureText || d.errorText) throw new Error(String(d.failureText || d.failureReason || d.errorText));
              tl.orderId = Number(d.orderId) || undefined;
              tl.ocoId = Number(d.ocoId) || undefined;
              tl.strategyId = Number(d.orderStrategy?.id) || undefined;
              this.remember(tl.orderId, tl.ocoId);
              if (tl.strategyId) this.coverStrategy(a, symbol);
              tl.status = "placed";
            },
          });
        }
      }),
    );
    legs.sort((x, y) => targets.findIndex((a) => a.spec === x.spec) - targets.findIndex((a) => a.spec === y.spec));
    if (symbol) this.rememberSymbol(symbol);
    const ev: GroupEvent = {
      ...base,
      groupId: teeId,
      ok: legs.filter((l) => l.status === "placed" || l.status === "dry").length,
      failed: legs.filter((l) => l.status === "failed").length,
      skipped: legs.filter((l) => l.status === "skipped").length,
      legs,
      latencyMs: this.cfg.dryRun ? 0 : lastAck - t0,
      spreadMs: firstSent ? lastSent - firstSent : 0,
      note: this.relayNote(source, delay, extra),
    };
    this.emit(ev);
    // La source a pris la position quoi qu'il arrive → avis IA (copies ou pas).
    {
      const q = this.md?.quote(symbol);
      const inst = this.instruments.get(symbol);
      const tick = inst?.tickSize;
      let stopTicks: number | undefined;
      let targetTicks: number | undefined;
      if (endpoint === "orderstrategy/startorderstrategy" && tick) {
        try {
          const p = JSON.parse(String(body.params ?? "{}"));
          const b = Array.isArray(p?.brackets) ? p.brackets[0] : null;
          if (b && typeof b.stopLoss === "number") stopTicks = Math.round(Math.abs(b.stopLoss) / tick);
          if (b && typeof b.profitTarget === "number") targetTicks = Math.round(Math.abs(b.profitTarget) / tick);
        } catch { /* params illisibles */ }
      }
      this.askScore({
        symbol, action, qty, orderType, price: price ?? stopPrice ?? q?.last ?? undefined,
        stopTicks, targetTicks, tickSize: tick,
        accounts: ev.ok + 1, source: `Tradovate (${source.label})`, ts: Date.now(),
      });
    }
    return { ok: ev.failed === 0, event: ev };
  }

  /** Modification / annulation faite dans Tradovate sur l'ordre source → même chose sur les
   *  copies. Mapping EXACT via la réponse mémorisée (orderId source → orderId de chaque
   *  compte) ; sinon PAR CORRESPONDANCE : sur chaque autre compte, les ordres en attente de
   *  même contrat + sens + type (un trader a en général un seul stop par instrument). */
  private async relayModifyOrCancel(op: "modify" | "cancel", body: Record<string, any>, delay?: number): Promise<{ ok: boolean; note?: string; event?: GroupEvent }> {
    const orderId = Number(body.orderId) || 0;
    if (!orderId) return { ok: false, note: "orderId manquant" };
    const rec = this.bySourceOrder.get(orderId);
    let source: GroupAccount | undefined = rec?.source;
    let srcOrder: Order | undefined;
    if (!source) {
      for (const a of this.accounts) {
        const o = a.client.order(orderId);
        if (o && a.accountId === o.accountId) { source = a; srcOrder = o; break; }
      }
    }
    if (!source) {
      log.debug(`relais ${op} : ordre source #${orderId} inconnu — ignoré`);
      return { ok: false, note: "ordre source inconnu" };
    }
    if (!source.enabled) return { ok: false, note: "compte source hors groupe" };
    if (!this.relayEnabled) return { ok: false, note: "relais désactivé" };
    const targets = this.accounts.filter((a) => a.enabled && a !== source && a.client.isReady && a.accountId);
    const legs: GroupLeg[] = [];
    let mapped = 0, matched = 0;
    // Clé de correspondance (fallback).
    const version = srcOrder ? source.client.orderVersion(orderId) : undefined;
    const key = srcOrder ? { contractId: srcOrder.contractId, action: srcOrder.action, orderType: String(body.orderType ?? version?.orderType ?? "") } : undefined;

    const jobs: Array<{ a: GroupAccount; id: number; qty?: number }> = [];
    for (const a of targets) {
      let ids: number[] = [];
      const leg = rec?.legs.find((l) => l.account === a);
      if (rec && leg) {
        const id = rec.sourceOrderId === orderId ? leg.orderId : rec.sourceOcoId === orderId ? leg.ocoId : undefined;
        if (id) { ids = [id]; mapped++; }
      }
      if (!ids.length && key) {
        ids = a.client.workingOrders(a.accountId)
          .filter((o) => o.contractId === key.contractId && o.action === key.action && (!key.orderType || (a.client.orderVersion(o.id)?.orderType ?? key.orderType) === key.orderType))
          .map((o) => o.id);
        if (ids.length) matched++;
      }
      if (!ids.length) { legs.push({ label: a.label, spec: a.spec, qty: 0, status: "skipped", error: "aucun ordre correspondant" }); continue; }
      for (const id of ids) jobs.push({ a, id, qty: typeof body.orderQty === "number" ? relayQty(body.orderQty, source.multiplier, a.multiplier) : undefined });
    }
    const symbol = rec?.symbol ?? (srcOrder ? await source.client.contractName(srcOrder.contractId).catch(() => "") : "");
    log.info(`RELAIS ${op === "modify" ? "MODIF" : "ANNUL"} ${source.label} #${orderId}${symbol ? ` ${symbol}` : ""} → ${jobs.length} ordre(s) sur ${targets.length} compte(s) (${mapped} mappé(s), ${matched} par correspondance)`);
    await Promise.all(
      jobs.map(async ({ a, id, qty }) => {
        const leg: GroupLeg = { label: a.label, spec: a.spec, qty: qty ?? 0, status: "placed", orderId: id };
        legs.push(leg);
        if (this.cfg.dryRun) { leg.status = "dry"; return; }
        try {
          if (op === "cancel") {
            await a.client.request("order/cancelorder", { orderId: id });
          } else {
            const b: Record<string, unknown> = { ...body, orderId: id, isAutomated: true };
            if (qty !== undefined) b.orderQty = qty; else delete b.orderQty;
            if (b.orderQty === 0) delete b.orderQty;
            await a.client.request("order/modifyorder", b);
          }
        } catch (err) {
          leg.status = "failed";
          leg.error = String((err as Error)?.message || err);
          log.error(`  ${a.label}: relais ${op} ÉCHEC — ${leg.error}`);
        }
      }),
    );
    const ev: GroupEvent = {
      ts: Date.now(),
      kind: op === "modify" ? "modify" : "cancel",
      symbol: symbol || undefined,
      orderType: body.orderType ? String(body.orderType) : undefined,
      price: typeof body.price === "number" ? body.price : undefined,
      stopPrice: typeof body.stopPrice === "number" ? body.stopPrice : undefined,
      ok: legs.filter((l) => l.status === "placed" || l.status === "dry").length,
      failed: legs.filter((l) => l.status === "failed").length,
      skipped: legs.filter((l) => l.status === "skipped").length,
      legs,
      note: this.relayNote(source, delay, op === "modify" ? "ordre modifié" : "ordre annulé") + (matched ? " · par correspondance" : ""),
    };
    this.emit(ev);
    return { ok: ev.failed === 0, event: ev };
  }

  private async relayLiquidate(body: Record<string, any>, delay?: number): Promise<{ ok: boolean; note?: string; event?: GroupEvent }> {
    const source = this.accountByIds(body.accountId, body.accountSpec);
    if (!source) return { ok: false, note: "compte source hors du copieur" };
    if (!source.enabled) return { ok: false, note: "compte source hors groupe" };
    if (!this.relayEnabled) return { ok: false, note: "relais désactivé" };
    const contractId = Number(body.contractId) || 0;
    const targets = this.accounts.filter((a) => a.enabled && a !== source && a.client.isReady && a.accountId);
    const legs: GroupLeg[] = [];
    let symbol = "";
    await Promise.all(
      targets.map(async (a) => {
        const pos = a.client.openPositions(a.accountId).filter((p) => !contractId || p.contractId === contractId).filter((p) => p.netPos);
        if (!pos.length) { legs.push({ label: a.label, spec: a.spec, qty: 0, status: "skipped", error: "à plat" }); return; }
        for (const p of pos) {
          if (!p.symbol.startsWith("#")) symbol = p.symbol;
          const leg: GroupLeg = { label: a.label, spec: a.spec, qty: Math.abs(p.netPos), status: "placed" };
          legs.push(leg);
          if (this.cfg.dryRun) { leg.status = "dry"; continue; }
          try {
            const res = await a.client.request("order/liquidateposition", { accountId: a.accountId, contractId: p.contractId, admin: false });
            this.remember(Number((res.d as Record<string, any> | undefined)?.orderId) || undefined);
          } catch (err) { leg.status = "failed"; leg.error = String((err as Error)?.message || err); }
        }
      }),
    );
    log.info(`RELAIS À PLAT ${source.label}${symbol ? ` ${symbol}` : ""} → ${legs.filter((l) => l.status !== "skipped").length} position(s) sur les autres comptes`);
    const ev: GroupEvent = {
      ts: Date.now(),
      kind: "flatten",
      symbol: symbol || undefined,
      ok: legs.filter((l) => l.status === "placed" || l.status === "dry").length,
      failed: legs.filter((l) => l.status === "failed").length,
      skipped: legs.filter((l) => l.status === "skipped").length,
      legs,
      note: this.relayNote(source, delay, "position clôturée dans Tradovate"),
    };
    this.emit(ev);
    return { ok: ev.failed === 0, event: ev };
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
          await this.modifyExit(x, px);
          modified++;
        } catch (err) {
          leg.status = "failed";
          leg.error = String((err as Error)?.message || err);
          errors.push(`${x.account.label}: ${leg.error}`);
          this.addIncident({ kind: "modify", account: x.account, symbol: x.symbol, action: x.action, qty: x.qty, error: leg.error, critical: false, auto: isTransportError(err), retry: () => this.modifyExit(x, px) });
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

  /** Modifie UNE sortie (prix). Lève en cas de refus. */
  private async modifyExit(x: ExitOrder, price: number): Promise<void> {
    const body: Record<string, unknown> = { orderId: x.orderId, orderQty: x.qty, orderType: x.role === "stop" ? "Stop" : "Limit", isAutomated: true };
    if (x.role === "stop") body.stopPrice = price; else body.price = price;
    if (this.cfg.dryRun) { x.price = price; return; }
    const res = await x.account.client.request("order/modifyorder", body);
    const d = (res.d ?? {}) as Record<string, any>;
    if (d.failureReason || d.failureText) throw new Error(String(d.failureText || d.failureReason));
    x.price = price;
  }

  private tickOf(symbol: string): number | undefined {
    return this.instruments.get(symbol)?.tickSize;
  }

  /** Breakeven groupé : chaque STOP du groupe est ramené au prix d'entrée de SON compte
   *  (fill mémorisé, sinon prix moyen de la position), ± un décalage en ticks dans le sens
   *  favorable (offset > 0 = verrouille un petit gain). */
  async breakevenExits(key: string, offsetTicks = 0): Promise<{ ok: boolean; modified: number; skipped: string[]; errors: string[] }> {
    const list = [...this.exits.values()].filter((x) => `${x.symbol}|${x.role}|${x.action}` === key && x.role === "stop");
    if (!list.length) return { ok: false, modified: 0, skipped: [], errors: ["aucun stop pour ce groupe"] };
    let tick = this.tickOf(list[0]!.symbol);
    if (!tick) { try { tick = (await this.resolveInstrument(list[0]!.symbol)).tickSize; } catch { /* sans tick : pas d'offset */ } }
    const skipped: string[] = [];
    const errors: string[] = [];
    let modified = 0;
    const legs: GroupLeg[] = [];
    await Promise.all(
      list.map(async (x) => {
        const pos = x.account.client.openPositions(x.account.accountId).find((p) => p.contractId === x.contractId);
        const entry = x.fillPrice ?? pos?.netPrice;
        if (!entry) { skipped.push(x.account.label); legs.push({ label: x.account.label, spec: x.account.spec, qty: x.qty, status: "skipped", error: "prix d'entrée inconnu" }); return; }
        // Stop Sell = position longue → BE au-dessus de l'entrée si offset ; Stop Buy = short → en dessous.
        const dir = x.action === "Sell" ? 1 : -1;
        const px = tick ? roundToTick(entry + dir * offsetTicks * tick, tick) : entry;
        const leg: GroupLeg = { label: x.account.label, spec: x.account.spec, qty: x.qty, status: "placed", orderId: x.orderId };
        legs.push(leg);
        try { await this.modifyExit(x, px); modified++; if (this.cfg.dryRun) leg.status = "dry"; }
        catch (err) {
          leg.status = "failed"; leg.error = String((err as Error)?.message || err); errors.push(`${x.account.label}: ${leg.error}`);
          this.addIncident({ kind: "modify", account: x.account, symbol: x.symbol, action: x.action, qty: x.qty, error: leg.error, critical: false, auto: isTransportError(err), retry: () => this.modifyExit(x, px) });
        }
      }),
    );
    log.info(`Breakeven ${list[0]!.symbol} (+${offsetTicks} tick) : ${modified}/${list.length} stop(s) déplacé(s)` + (skipped.length ? ` · ${skipped.length} sans prix d'entrée` : "") + (errors.length ? ` · ${errors.length} erreur(s)` : ""));
    this.emit({ ts: Date.now(), kind: "modify", symbol: list[0]!.symbol, action: list[0]!.action, orderType: "Stop", ok: modified, failed: errors.length, skipped: skipped.length, legs, note: `breakeven${offsetTicks ? ` +${offsetTicks} tick` : ""}` });
    return { ok: errors.length === 0, modified, skipped, errors };
  }

  /** Décale chaque sortie du groupe de N ticks (signé, en prix) PAR RAPPORT À SON PROPRE
   *  prix — conserve les écarts entre comptes (fills différents). */
  async shiftExits(key: string, ticks: number): Promise<{ ok: boolean; modified: number; errors: string[] }> {
    const list = [...this.exits.values()].filter((x) => `${x.symbol}|${x.role}|${x.action}` === key);
    if (!list.length) return { ok: false, modified: 0, errors: ["aucune sortie pour ce groupe"] };
    if (!Number.isFinite(ticks) || !ticks) return { ok: false, modified: 0, errors: ["décalage invalide"] };
    let tick = this.tickOf(list[0]!.symbol);
    if (!tick) { try { tick = (await this.resolveInstrument(list[0]!.symbol)).tickSize; } catch (err) { return { ok: false, modified: 0, errors: [`tick inconnu : ${String((err as Error)?.message || err)}`] }; } }
    const errors: string[] = [];
    let modified = 0;
    const legs: GroupLeg[] = [];
    await Promise.all(
      list.map(async (x) => {
        const px = roundToTick(x.price + ticks * tick!, tick!);
        const leg: GroupLeg = { label: x.account.label, spec: x.account.spec, qty: x.qty, status: "placed", orderId: x.orderId };
        legs.push(leg);
        try { await this.modifyExit(x, px); modified++; if (this.cfg.dryRun) leg.status = "dry"; }
        catch (err) {
          leg.status = "failed"; leg.error = String((err as Error)?.message || err); errors.push(`${x.account.label}: ${leg.error}`);
          this.addIncident({ kind: "modify", account: x.account, symbol: x.symbol, action: x.action, qty: x.qty, error: leg.error, critical: false, auto: isTransportError(err), retry: () => this.modifyExit(x, px) });
        }
      }),
    );
    log.info(`${list[0]!.role === "stop" ? "Stops" : "Cibles"} ${list[0]!.symbol} décalé(e)s de ${ticks > 0 ? "+" : ""}${ticks} tick(s) : ${modified}/${list.length}`);
    this.emit({ ts: Date.now(), kind: "modify", symbol: list[0]!.symbol, action: list[0]!.action, orderType: list[0]!.role === "stop" ? "Stop" : "Limit", ok: modified, failed: errors.length, skipped: 0, legs, note: `${list[0]!.role === "stop" ? "stops" : "cibles"} décalé(e)s de ${ticks > 0 ? "+" : ""}${ticks} tick(s)` });
    return { ok: errors.length === 0, modified, errors };
  }

  // --- incidents ---------------------------------------------------------------------

  private addIncident(i: { kind: Incident["kind"]; account: GroupAccount; symbol?: string; action?: OrderAction; qty?: number; error: string; critical: boolean; auto: boolean; retry: () => Promise<void> }): string {
    const id = uid();
    this.incidents.set(id, {
      id, ts: Date.now(), kind: i.kind, label: i.account.label, spec: i.account.spec, symbol: i.symbol, action: i.action, qty: i.qty,
      error: i.error, auto: i.auto, critical: i.critical, attempts: 0, status: "open", retry: i.retry, account: i.account,
    });
    log.warn(`⚠ INCIDENT ${i.kind} ${i.account.label}${i.symbol ? ` ${i.symbol}` : ""} : ${i.error}${i.auto ? " (relance auto à la reconnexion)" : ""}${i.critical ? " — CRITIQUE" : ""}`);
    // Purge : garde 100 incidents max.
    if (this.incidents.size > 100) this.incidents.delete(this.incidents.keys().next().value as string);
    return id;
  }

  /** Relance une action échouée (bouton « Réessayer » ou automatique). */
  async retryIncident(id: string, auto = false): Promise<{ ok: boolean; error?: string }> {
    const inc = this.incidents.get(id);
    if (!inc) return { ok: false, error: "incident inconnu" };
    if (inc.status === "retrying") return { ok: false, error: "déjà en cours" };
    if (inc.status === "resolved") return { ok: true };
    if (!inc.account.client.isReady) return { ok: false, error: "compte déconnecté" };
    inc.status = "retrying";
    inc.attempts++;
    const leg: GroupLeg = { label: inc.label, spec: inc.spec, qty: inc.qty ?? 0, status: "placed" };
    try {
      await inc.retry();
      inc.status = "resolved";
      inc.resolvedAt = Date.now();
      log.info(`✓ Relance ${auto ? "automatique" : "manuelle"} réussie : ${inc.kind} ${inc.label}${inc.symbol ? ` ${inc.symbol}` : ""}`);
      this.emit({ ts: Date.now(), kind: "retry", symbol: inc.symbol, action: inc.action, qty: inc.qty, ok: 1, failed: 0, skipped: 0, legs: [leg], note: `relance ${auto ? "auto" : "manuelle"} · ${inc.kind} · ${inc.label}` });
      return { ok: true };
    } catch (err) {
      inc.status = "open";
      inc.error = String((err as Error)?.message || err);
      inc.auto = inc.auto && isTransportError(err);
      leg.status = "failed";
      leg.error = inc.error;
      log.error(`✗ Relance échouée : ${inc.kind} ${inc.label} — ${inc.error}`);
      this.emit({ ts: Date.now(), kind: "retry", symbol: inc.symbol, action: inc.action, qty: inc.qty, ok: 0, failed: 1, skipped: 0, legs: [leg], note: `relance ${auto ? "auto" : "manuelle"} · ${inc.kind} · ${inc.label}` });
      return { ok: false, error: inc.error };
    }
  }

  ignoreIncident(id: string): { ok: boolean; error?: string } {
    const inc = this.incidents.get(id);
    if (!inc) return { ok: false, error: "incident inconnu" };
    inc.status = "ignored";
    inc.resolvedAt = Date.now();
    log.info(`Incident ignoré : ${inc.kind} ${inc.label}`);
    return { ok: true };
  }

  /** Balayage périodique : un échec réseau dont le compte est déjà revenu (timeout isolé)
   *  est relancé une fois après quelques secondes. */
  private async retrySweep(): Promise<void> {
    const now = Date.now();
    for (const inc of this.incidents.values()) {
      if (inc.status !== "open" || !inc.auto || inc.attempts >= MAX_AUTO_ATTEMPTS) continue;
      const age = now - inc.ts;
      if (age < 4_000 || age > AUTO_RETRY_WINDOW_MS) continue;
      if (!inc.account.client.isReady) continue;
      await this.retryIncident(inc.id, true);
    }
  }

  listIncidents(): Incident[] {
    return [...this.incidents.values()]
      .filter((i) => i.status === "open" || i.status === "retrying" || (i.resolvedAt && Date.now() - i.resolvedAt < 60_000))
      .map(({ retry: _r, account: _a, ...rest }) => rest)
      .sort((a, b) => b.ts - a.ts);
  }

  // --- garde-fou du relais -----------------------------------------------------------
  //
  // Le copieur voit chaque fill de chaque compte par ses propres connexions. Un fill dont
  // l'ordre n'a été ni placé par le panneau, ni relayé, ni posé comme SL/TP, ni engendré par
  // une stratégie relayée = un ordre passé EN DEHORS du relais (extension muette ou cassée
  // par un changement Tradovate, app bureau/mobile, ordre posé avant le lancement). Si les
  // autres comptes n'ont pas bougé avec lui → incident « relais manqué » : les ENTRÉES sont
  // rattrapées au marché automatiquement (mode "auto") ; les sorties et inversions attendent
  // un clic — une cible limite servie sur un seul compte par priorité de file ne doit pas
  // faire clôturer les autres au marché sans accord.

  private guardObserve(client: TradovateClient, fill: Fill): void {
    if (this.guardMode === "off" || !this.relayEnabled) return;
    const now = Date.now();
    if (typeof fill.id === "number") {
      if (this.seenFills.has(fill.id)) return;
      this.seenFills.set(fill.id, now);
      if (this.seenFills.size > 2000) this.seenFills.delete(this.seenFills.keys().next().value as number);
    }
    this.recentFills.push({ client, fill, at: now });
    const cutoff = now - 60_000;
    if (this.recentFills.length > 500 || this.recentFills[0]!.at < cutoff) this.recentFills = this.recentFills.filter((r) => r.at >= cutoff);
    setTimeout(() => { void this.guardEvaluate(client, fill, now); }, this.guardGraceMs);
  }

  /** Compte d'un fill : via l'ordre (mémorisé même terminé), sinon le seul compte de ce login. */
  private accountOfFill(client: TradovateClient, fill: Fill): GroupAccount | undefined {
    const id = client.accountOfOrder(fill.orderId);
    if (id) return this.accounts.find((a) => a.client === client && a.accountId === id);
    const mine = this.accounts.filter((a) => a.client === client && a.accountId);
    return mine.length === 1 ? mine[0] : undefined;
  }

  /** L'ordre de ce fill est-il connu du copieur (panneau, relais, SL/TP, stratégie, enfant
   *  d'un ordre connu, relais récent sur ce compte et ce symbole) ? */
  private isKnownOrigin(acct: GroupAccount, fill: Fill, symbol: string): boolean {
    if (this.known.has(fill.orderId)) return true;
    const o = acct.client.order(fill.orderId);
    if (o && ((o.parentId && this.known.has(o.parentId)) || (o.ocoId && this.known.has(o.ocoId)) || (o.linkedId && this.known.has(o.linkedId)))) return true;
    if (this.strategyCover.has(`${acct.key}|${symbol}`)) return true;
    // Relais récent sur ce compte et ce symbole : la réponse (donc l'orderId) n'est pas encore
    // arrivée, ou s'est perdue — dans le doute, jamais de double.
    const since = Date.now() - GUARD_TEE_WINDOW_MS;
    for (const rec of this.tees.values()) {
      if (rec.ts < since || (rec.symbol ?? "") !== symbol) continue;
      if (rec.source === acct) return true;
      if (rec.legs.some((l) => l.account === acct && (l.status === "placed" || l.status === "dry"))) return true;
    }
    return false;
  }

  private async guardEvaluate(client: TradovateClient, fill: Fill, at: number): Promise<void> {
    try {
      if (this.guardMode === "off" || !this.relayEnabled) return;
      const acct = this.accountOfFill(client, fill);
      if (!acct || !acct.enabled) return;
      let symbol = client.symbolOf(fill.contractId);
      if (!symbol) { try { symbol = await client.contractName(fill.contractId); } catch { symbol = `#${fill.contractId}`; } }
      symbol = symbol.toUpperCase();
      if (this.isKnownOrigin(acct, fill, symbol)) return;
      const action: OrderAction = fill.action === "Sell" ? "Sell" : "Buy";
      const dir = action === "Buy" ? 1 : -1;
      const net = client.openPositions(acct.accountId).find((p) => p.contractId === fill.contractId)?.netPos ?? 0;
      const increasing = Math.sign(net) === dir && Math.abs(net) >= fill.qty;
      // Les autres comptes ont-ils bougé avec lui (même contrat, même sens, dans la fenêtre) ?
      const others = this.accounts.filter((a) => a.enabled && a !== acct);
      const lagging = others.filter((t) => !this.recentFills.some((r) =>
        r.fill.contractId === fill.contractId && r.fill.action === fill.action && r.at >= at - GUARD_MOVED_WINDOW_MS && this.accountOfFill(r.client, r.fill) === t));
      if (!others.length) return;
      if (!lagging.length) {
        log.debug(`garde-fou : ${acct.label} ${action} ${fill.qty} ${symbol} hors relais, mais tous les comptes ont bougé ensemble — rien à faire`);
        return;
      }
      const ext = this.relayStats.extensionSeenAt;
      const cause = !ext || Date.now() - ext > 60_000
        ? "extension muette : onglet Tradovate fermé, extension désactivée ou dépassée"
        : "ordre non intercepté : app Tradovate bureau/mobile, ordre antérieur au lancement, ou changement côté Tradovate";
      const what = increasing ? "entrée" : net === 0 ? "sortie" : "inversion";
      const error = `${what} passée hors relais (${cause}) — ${lagging.map((l) => l.label).join(", ")} ${lagging.length > 1 ? "n'ont" : "n'a"} pas suivi`;
      log.warn(`⚠ RELAIS MANQUÉ ${acct.label} ${action.toUpperCase()} ${fill.qty} ${symbol} @${fill.price} : ${error}`);
      this.guardStats.caught++;
      this.guardStats.lastAt = Date.now();
      const remaining = new Set(lagging);
      const id = this.addIncident({
        kind: "relay", account: acct, symbol, action, qty: fill.qty, error, critical: true, auto: false,
        retry: () => this.guardCatchUp(acct, symbol!, action, fill.qty, remaining, increasing),
      });
      if (increasing && this.guardMode === "auto") void this.retryIncident(id, true);
    } catch (err) {
      log.warn(`garde-fou : ${String(err)}`);
    }
  }

  /** Rattrapage au marché sur les comptes qui n'ont pas suivi (quantité × multiplicateur).
   *  `remaining` est vidé au fur et à mesure : une relance ne renvoie jamais un compte déjà servi. */
  private async guardCatchUp(source: GroupAccount, symbol: string, action: OrderAction, qty: number, remaining: Set<GroupAccount>, increasing: boolean): Promise<void> {
    const legs: GroupLeg[] = [];
    const errors: string[] = [];
    await Promise.all([...remaining].map(async (a) => {
      const q = relayQty(qty, source.multiplier, a.multiplier);
      const leg: GroupLeg = { label: a.label, spec: a.spec, qty: q, status: "placed" };
      legs.push(leg);
      if (q <= 0) { leg.status = "skipped"; leg.error = "quantité 0 (multiplicateur)"; remaining.delete(a); return; }
      if (!a.client.isReady || !a.accountId) { leg.status = "failed"; leg.error = "déconnecté"; errors.push(`${a.label}: déconnecté`); return; }
      if (this.cfg.dryRun) { leg.status = "dry"; remaining.delete(a); log.info(`  [DRY] ${a.label}: rattrapage ${action} ${q} ${symbol} au marché`); return; }
      try {
        // Sortie / inversion : les SL/TP posés par le copieur sur ce contrat ne protègent plus
        // la bonne position → annulés d'abord (sinon un stop rouvrirait l'inverse).
        if (!increasing) await this.cancelExitsOf(a, symbol);
        const res = await a.client.request("order/placeorder", { accountId: a.accountId, accountSpec: a.spec, action, symbol, orderQty: q, orderType: "Market", timeInForce: "Day", isAutomated: true });
        const d = (res.d ?? {}) as Record<string, any>;
        if (d.failureReason || d.failureText) throw new Error(String(d.failureText || d.failureReason));
        leg.orderId = Number(d.orderId) || undefined;
        this.remember(leg.orderId);
        remaining.delete(a);
        log.info(`  ${a.label}: rattrapage ${action} ${q} ${symbol} au marché #${leg.orderId ?? "?"}`);
      } catch (err) {
        leg.status = "failed";
        leg.error = String((err as Error)?.message || err);
        errors.push(`${a.label}: ${leg.error}`);
        log.error(`  ${a.label}: rattrapage ÉCHEC — ${leg.error}`);
      }
    }));
    this.emit({
      ts: Date.now(), kind: "entry", symbol, action, qty, orderType: "Market",
      ok: legs.filter((l) => l.status === "placed" || l.status === "dry").length, failed: errors.length, skipped: legs.filter((l) => l.status === "skipped").length,
      legs, note: `rattrapage · relais manqué · ${source.label}`,
    });
    if (errors.length) throw new Error(errors.join(" · "));
  }

  private async cancelExitsOf(a: GroupAccount, symbol: string): Promise<void> {
    const mine = [...this.exits.values()].filter((x) => x.account === a && x.symbol === symbol);
    for (const x of mine) {
      this.exits.delete(x.orderId);
      try { await a.client.request("order/cancelorder", { orderId: x.orderId }); }
      catch (err) { log.debug(`${a.label}: annulation ${x.role} #${x.orderId} avant rattrapage : ${String(err)}`); }
    }
  }

  // --- flux de marché ---------------------------------------------------------------

  /** Le panneau regarde un instrument : abonne-le (TTL 3 min après la dernière demande). */
  watch(symbol: string): void {
    const sym = String(symbol || "").trim().toUpperCase();
    if (!sym) return;
    this.watched.set(sym, Date.now());
    if (!this.mdWanted.has(sym)) {
      this.mdWanted.set(sym, this.instruments.get(sym)?.contractId);
      this.md?.subscribe(sym, this.instruments.get(sym)?.contractId);
      // Résout l'instrument en fond (tick, valeur du point → P&L, arrondis).
      void this.resolveInstrument(sym).then((i) => { this.mdWanted.set(i.symbol, i.contractId); this.md?.subscribe(i.symbol, i.contractId); }).catch(() => undefined);
    }
  }

  private ensureMarketData(): void {
    if (this.md?.isAlive) return;
    const c = this.anyReadyClient();
    if (!c || !c.mdToken) return;
    if (this.md && this.md.environment === c.env) return; // en reconnexion, on laisse faire
    void this.md?.stop();
    const md = new MarketDataClient({ env: c.env as Environment, tokenProvider: () => this.anyReadyClient()?.mdToken });
    this.md = md;
    for (const [sym, cid] of this.mdWanted) md.subscribe(sym, cid);
    for (const w of this.chartWanted.values()) md.subscribeChart(w.symbol, w.tf);
    md.start().catch((err) => log.debug(`md start : ${String((err as Error)?.message || err)}`));
  }

  /** Bougies `tf` minutes d'un symbole pour le graphique du dashboard (abonnement à la
   *  demande, gardé 3 min après la dernière lecture). */
  chartBars(symbol: string, tf: number): { bars: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>; active: boolean; eoh: boolean } {
    const sym = String(symbol || "").trim().toUpperCase();
    const minutes = [1, 2, 3, 5, 10, 15, 30, 60].includes(tf) ? tf : 1;
    if (!sym) return { bars: [], active: false, eoh: false };
    const key = `${sym}|${minutes}`;
    this.chartWanted.set(key, { symbol: sym, tf: minutes, at: Date.now() });
    this.watch(sym);
    this.md?.subscribeChart(sym, minutes);
    const info = this.md?.chartInfo(sym, minutes);
    return { bars: this.md?.bars(sym, minutes) ?? [], active: !!info?.active, eoh: !!info?.eoh };
  }

  /** Abonnements = instruments surveillés (TTL) + positions ouvertes + sorties en place. */
  private reconcileMarketData(): void {
    const now = Date.now();
    const wanted = new Map<string, number | undefined>();
    for (const [sym, ts] of this.watched) { if (now - ts < WATCH_TTL_MS) wanted.set(sym, this.instruments.get(sym)?.contractId); else this.watched.delete(sym); }
    for (const a of this.accounts) {
      if (!a.accountId) continue;
      for (const p of a.client.openPositions(a.accountId)) if (!p.symbol.startsWith("#")) wanted.set(p.symbol, p.contractId);
    }
    for (const x of this.exits.values()) wanted.set(x.symbol, x.contractId);
    for (const [sym, cid] of wanted) {
      if (!this.mdWanted.has(sym)) { this.mdWanted.set(sym, cid); this.md?.subscribe(sym, cid); }
      if (!this.instruments.get(sym)) void this.resolveInstrument(sym).catch(() => undefined);
    }
    for (const sym of [...this.mdWanted.keys()]) if (!wanted.has(sym)) { this.mdWanted.delete(sym); this.md?.unsubscribe(sym); }
    // Graphiques : on garde ceux lus récemment, on coupe les autres.
    for (const [key, w] of [...this.chartWanted]) {
      if (now - w.at > WATCH_TTL_MS) { this.chartWanted.delete(key); this.md?.unsubscribeChart(w.symbol, w.tf); }
      else this.md?.subscribeChart(w.symbol, w.tf);
    }
  }

  quotes(): Record<string, Quote & { tickSize?: number; valuePerPoint?: number; decimals?: number }> {
    const out: Record<string, Quote & { tickSize?: number; valuePerPoint?: number; decimals?: number }> = {};
    if (!this.md) return out;
    for (const [sym, q] of Object.entries(this.md.allQuotes())) {
      const inst = this.instruments.get(sym);
      out[sym] = { ...q, tickSize: inst?.tickSize, valuePerPoint: inst?.valuePerPoint, decimals: inst ? tickDecimals(inst.tickSize) : undefined };
    }
    return out;
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
            const res = await a.client.request("order/liquidateposition", { accountId: a.accountId, contractId: p.contractId, admin: false });
            this.remember(Number((res.d as Record<string, any> | undefined)?.orderId) || undefined);
            flattened++;
          } catch (err) {
            leg.status = "failed";
            leg.error = String((err as Error)?.message || err);
            errors.push(`${a.label} flatten ${p.symbol}: ${leg.error}`);
            this.addIncident({
              kind: "flatten", account: a, symbol: p.symbol, qty: Math.abs(p.netPos), error: leg.error, critical: true, auto: isTransportError(err),
              retry: async () => {
                const r2 = await a.client.request("order/liquidateposition", { accountId: a.accountId, contractId: p.contractId, admin: false });
                this.remember(Number((r2.d as Record<string, any> | undefined)?.orderId) || undefined);
              },
            });
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
    const added: string[] = [];
    for (const client of this.clients.values()) added.push(...this.addAccountsOf(client));
    return { added: added.length, total: this.accounts.length, names: added };
  }

  /** Ajoute au groupe les comptes d'un login qui n'y sont pas encore (ni connus, ni masqués). */
  private addAccountsOf(client: TradovateClient): string[] {
    const known = new Set<string>(this.accounts.flatMap((a) => [a.key, a.label.toLowerCase(), a.spec.toLowerCase()]));
    const knownId = new Set<number>(this.accounts.map((a) => a.accountId).filter(Boolean));
    const removed = new Set((this.cfg.removedSpecs ?? []).map((s) => s.toLowerCase()));
    const added: string[] = [];
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
    if (added.length) this.persistConfig();
    return added;
  }

  /** Token d'un login Tradovate ABSENT de la config (nouvelle prop firm, autre login) : on
   *  l'adopte à la volée — client en mode token (demo puis live), ses comptes rejoignent le
   *  groupe, la config est réécrite. Plus besoin de refaire l'onboarding : ouvrir la session
   *  dans le navigateur suffit. */
  private adopting = new Set<string>();
  private async adoptLogin(token: string, sub: string): Promise<{ ok: boolean; login?: string; acted?: boolean; adopted?: string[]; error?: string }> {
    if (this.adopting.has(sub)) return { ok: false, error: `login ${sub} : adoption en cours` };
    this.adopting.add(sub);
    try {
      for (const env of ["demo", "live"] as Environment[]) {
        const c = this.makeClient({ label: `login ${sub}`, environment: env, appId: this.cfg.appId, appVersion: this.cfg.appVersion, accessToken: token });
        try {
          await c.start();
        } catch (err) {
          await c.stop().catch(() => undefined);
          log.debug(`adoption du login ${sub} [${env}] : ${String((err as Error)?.message || err)}`);
          continue;
        }
        if (!c.accounts.length) { await c.stop().catch(() => undefined); continue; }
        this.clients.set(`token|${env}|${token}`, c);
        c.onStatus((s) => { if (s === "ready") this.onLoginReady(c); });
        const added = this.addAccountsOf(c);
        this.onLoginReady(c);
        const names = c.accounts.map((a) => a.name);
        log.info(`Nouveau login Tradovate adopté [${env}] : ${names.join(", ")}` + (added.length ? ` → ${added.length} compte(s) ajouté(s) au groupe` : " (comptes déjà connus ou masqués)"));
        this.emit({
          ts: Date.now(), kind: "info", ok: 1, failed: 0, skipped: 0, legs: [],
          note: `nouveau login Tradovate (${env}) : ${added.length ? added.join(", ") + " ajouté(s) au groupe" : names.join(", ") + " déjà connu(s)"}`,
        });
        return { ok: true, login: c.label, acted: true, adopted: added };
      }
      log.warn(`Token reçu pour un login inconnu (${sub}) : aucun compte accessible en demo ni en live.`);
      return { ok: false, error: `login ${sub} : aucun compte accessible avec ce token` };
    } finally {
      this.adopting.delete(sub);
    }
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

  async ingestToken(token: string): Promise<{ ok: boolean; login?: string; acted?: boolean; adopted?: string[]; error?: string }> {
    const sub = jwtClaims(token).sub;
    if (!sub) return { ok: false, error: "token has no sub claim" };
    const client = [...this.clients.values()].find((c) => c.sub === sub);
    // Login absent de la config (nouvelle prop firm, nouveau login Tradovate) → adopté à la volée.
    if (!client) return this.adoptLogin(token, sub);
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
    const quotes = this.quotes();
    // P&L latent par position : (dernier − prix moyen) × net × valeur du point.
    const withPnl = <T extends { symbol: string; netPos: number; netPrice?: number }>(ps: T[]): Array<T & { unrealized?: number }> =>
      ps.map((p) => {
        const q = quotes[p.symbol];
        const last = q?.last ?? (q?.bid && q?.ask ? (q.bid + q.ask) / 2 : undefined);
        if (last === undefined || !p.netPrice || !q?.valuePerPoint) return p;
        return { ...p, unrealized: Number(((last - p.netPrice) * p.netPos * q.valuePerPoint).toFixed(2)) };
      });
    let groupPnl = 0;
    let pnlKnown = false;
    return {
      mode: "sync" as const,
      environment: this.cfg.environment,
      dryRun: this.cfg.dryRun,
      locked: this.locked,
      relay: {
        enabled: this.relayEnabled,
        count: this.relayStats.count,
        lastSeenAt: this.relayStats.lastSeenAt || null,
        lastDelayMs: this.relayStats.lastDelayMs ?? null,
        extensionSeenAt: this.relayStats.extensionSeenAt || null,
        guard: this.guardMode,
        guardCaught: this.guardStats.caught,
        guardLastAt: this.guardStats.lastAt || null,
      },
      license: this.gate?.status() ?? null,
      connected,
      total: accounts.length,
      accounts: accounts.map((a, i) => {
        const working = a.accountId ? a.client.workingOrders(a.accountId) : [];
        const positions = withPnl(named(allPos[i]!));
        let pnl: number | undefined;
        for (const p of positions) if (p.unrealized !== undefined) { pnl = (pnl ?? 0) + p.unrealized; groupPnl += p.unrealized; pnlKnown = true; }
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
          positions,
          unrealized: pnl,
          workingOrders: working.length,
          exits: exitsByAccount.get(a.key) ?? 0,
          pendingBrackets: [...this.pendingBrackets.values()].filter((p) => p.account === a).length,
          desync: desyncBySpec.get(a.spec) ?? [],
        };
      }),
      groupUnrealized: pnlKnown ? Number(groupPnl.toFixed(2)) : null,
      journal: this.journal?.state() ?? null,
      quotes,
      marketData: { connected: !!this.md?.isAlive, symbols: this.md?.subscribedSymbols ?? [] },
      incidents: this.listIncidents(),
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
    await this.md?.stop();
    await Promise.all([...this.clients.values()].map((c) => c.stop()));
  }
}
