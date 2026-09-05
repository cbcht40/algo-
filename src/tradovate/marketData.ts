// Flux de marché Tradovate (cotations) — un websocket dédié (md-demo / md), protocole
// identique au socket de trading (o/h/a, authorize, trames `endpoint\nid\n\nbody`).
//
//   md/subscribeQuote {symbol}  → événements e:"md" d.quotes[] {contractId, entries:{Bid,Offer,Trade,…}}
//   md/unsubscribeQuote {symbol}
//
// Le token de session (mdAccessToken ou accessToken) est fourni par un `tokenProvider` :
// à chaque (re)connexion on prend le plus frais. Reconnexion auto avec backoff.
import WebSocket from "ws";
import { logger } from "../logger";
import { buildRequestFrame, HEARTBEAT_FRAME, parseFrame, type ServerMessage } from "./ws";
import type { Environment } from "./types";

export const MD_URL: Record<Environment, string> = {
  demo: "wss://md-demo.tradovateapi.com/v1/websocket",
  live: "wss://md.tradovateapi.com/v1/websocket",
};

export interface Quote {
  symbol: string;
  contractId?: number;
  last?: number;
  bid?: number;
  ask?: number;
  high?: number;
  low?: number;
  open?: number;
  settle?: number;
  volume?: number;
  /** horodatage de la dernière mise à jour (ms). */
  ts: number;
}

interface Sub { symbol: string; contractId?: number; active: boolean }

/** Bougie (temps en secondes UTC, comme attendu par Lightweight Charts). */
export interface Bar { time: number; open: number; high: number; low: number; close: number; volume: number }

interface ChartSub {
  key: string;
  symbol: string;
  tf: number; // minutes
  count: number;
  ids: Set<number>; // historicalId / realtimeId renvoyés par md/getChart
  bars: Map<number, Bar>;
  eoh: boolean;
  active: boolean;
}

const MAX_BARS = 800;

/** Barre Tradovate → Bar (null si illisible). */
export function toBar(raw: any): Bar | null {
  const t = Date.parse(String(raw?.timestamp || ""));
  if (!Number.isFinite(t) || typeof raw?.open !== "number" || typeof raw?.close !== "number") return null;
  return {
    time: Math.floor(t / 1000),
    open: raw.open,
    high: typeof raw.high === "number" ? raw.high : Math.max(raw.open, raw.close),
    low: typeof raw.low === "number" ? raw.low : Math.min(raw.open, raw.close),
    close: raw.close,
    volume: (Number(raw.upVolume) || 0) + (Number(raw.downVolume) || 0),
  };
}

export const chartKey = (symbol: string, tf: number): string => `${symbol.toUpperCase()}|${tf}`;

const HEARTBEAT_MS = 2_500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

export class MarketDataClient {
  private env: Environment;
  private tokenProvider: () => string | undefined;
  private log = logger("md");
  private ws?: WebSocket;
  private reqId = 0;
  private pending = new Map<number, { resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private backoff = 1_000;
  private closing = false;
  private authorized = false;
  private subs = new Map<string, Sub>();
  private charts = new Map<string, ChartSub>();
  private quotes = new Map<string, Quote>();
  private byContract = new Map<number, string>();
  private lastMessageAt = 0;

  constructor(opts: { env: Environment; tokenProvider: () => string | undefined }) {
    this.env = opts.env;
    this.tokenProvider = opts.tokenProvider;
  }

  get isAlive(): boolean {
    return this.authorized && this.ws?.readyState === WebSocket.OPEN;
  }
  get environment(): Environment {
    return this.env;
  }
  get subscribedSymbols(): string[] {
    return [...this.subs.keys()];
  }

  async start(): Promise<void> {
    this.closing = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.rejectAll(new Error("md stopped"));
    try { this.ws?.close(); } catch { /* ignore */ }
  }

  quote(symbol: string): Quote | undefined {
    return this.quotes.get(symbol.toUpperCase());
  }
  allQuotes(): Record<string, Quote> {
    const out: Record<string, Quote> = {};
    for (const [k, v] of this.quotes) out[k] = v;
    return out;
  }

  /** S'abonne (idempotent). `contractId` sert à router les événements (ils ne portent que l'id). */
  subscribe(symbol: string, contractId?: number): void {
    const sym = symbol.toUpperCase();
    if (contractId) this.byContract.set(contractId, sym);
    const existing = this.subs.get(sym);
    if (existing) { if (contractId) existing.contractId = contractId; if (existing.active) return; }
    else this.subs.set(sym, { symbol: sym, contractId, active: false });
    if (!this.isAlive) return;
    void this.sendSubscribe(sym);
  }

  unsubscribe(symbol: string): void {
    const sym = symbol.toUpperCase();
    const s = this.subs.get(sym);
    if (!s) return;
    this.subs.delete(sym);
    this.quotes.delete(sym);
    if (s.active && this.isAlive) this.request("md/unsubscribeQuote", { symbol: sym }).catch(() => undefined);
  }

  // --- bougies (md/getChart) -------------------------------------------------------

  /** Abonnement aux bougies `tf` minutes d'un symbole (historique + temps réel). Idempotent. */
  subscribeChart(symbol: string, tf: number, count = 300): void {
    const key = chartKey(symbol, tf);
    let sub = this.charts.get(key);
    if (!sub) {
      sub = { key, symbol: symbol.toUpperCase(), tf, count, ids: new Set(), bars: new Map(), eoh: false, active: false };
      this.charts.set(key, sub);
    }
    if (sub.active || !this.isAlive) return;
    void this.sendChart(sub);
  }

  unsubscribeChart(symbol: string, tf: number): void {
    const key = chartKey(symbol, tf);
    const sub = this.charts.get(key);
    if (!sub) return;
    this.charts.delete(key);
    if (this.isAlive) for (const id of sub.ids) this.request("md/cancelChart", { subscriptionId: id }).catch(() => undefined);
  }

  /** Bougies triées (les plus anciennes d'abord). */
  bars(symbol: string, tf: number): Bar[] {
    const sub = this.charts.get(chartKey(symbol, tf));
    if (!sub) return [];
    return [...sub.bars.values()].sort((a, b) => a.time - b.time);
  }
  chartInfo(symbol: string, tf: number): { active: boolean; eoh: boolean; count: number } | null {
    const sub = this.charts.get(chartKey(symbol, tf));
    return sub ? { active: sub.active, eoh: sub.eoh, count: sub.bars.size } : null;
  }
  get chartKeys(): string[] {
    return [...this.charts.keys()];
  }

  private async sendChart(sub: ChartSub): Promise<void> {
    if (sub.active) return;
    sub.active = true; // évite une double demande pendant l'aller-retour
    try {
      const m = await this.request("md/getChart", {
        symbol: sub.symbol,
        chartDescription: { underlyingType: "MinuteBar", elementSize: sub.tf, elementSizeUnit: "UnderlyingUnits", withHistogram: false },
        timeRange: { asMuchAsElements: sub.count },
      });
      const d = (m.d ?? {}) as Record<string, any>;
      for (const id of [d.historicalId, d.realtimeId]) if (Number(id)) sub.ids.add(Number(id));
      this.log.debug(`bougies ${sub.symbol} ${sub.tf}m : abonnement #${[...sub.ids].join("/")}`);
    } catch (err) {
      sub.active = false;
      this.log.warn(`bougies ${sub.symbol} ${sub.tf}m refusées : ${String((err as Error)?.message || err)}`);
    }
  }

  private applyChart(d: any): void {
    const charts = d?.charts;
    if (!Array.isArray(charts)) return;
    for (const c of charts) {
      const id = Number(c?.id);
      const sub = [...this.charts.values()].find((s) => s.ids.has(id));
      if (!sub) continue;
      if (c.eoh) sub.eoh = true;
      if (Array.isArray(c.bars)) {
        for (const raw of c.bars) {
          const b = toBar(raw);
          if (b) sub.bars.set(b.time, b);
        }
        if (sub.bars.size > MAX_BARS) {
          const times = [...sub.bars.keys()].sort((a, b) => a - b);
          for (const t of times.slice(0, sub.bars.size - MAX_BARS)) sub.bars.delete(t);
        }
      }
    }
  }

  private async sendSubscribe(sym: string): Promise<void> {
    const s = this.subs.get(sym);
    if (!s) return;
    try {
      const m = await this.request("md/subscribeQuote", { symbol: sym });
      s.active = true;
      const d = m.d as Record<string, any> | undefined;
      // Certaines réponses renvoient le contrat ; sinon on mappe au premier événement.
      const cid = Number(d?.contractId || d?.contract?.id) || undefined;
      if (cid) { s.contractId = cid; this.byContract.set(cid, sym); }
      this.log.debug(`abonné ${sym}`);
    } catch (err) {
      this.log.warn(`abonnement ${sym} refusé : ${String((err as Error)?.message || err)}`);
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const token = this.tokenProvider();
      if (!token) { reject(new Error("no md token")); return; }
      const ws = new WebSocket(MD_URL[this.env]);
      this.ws = ws;
      let opened = false;
      ws.on("message", (raw: WebSocket.RawData) => {
        this.lastMessageAt = Date.now();
        let frame;
        try { frame = parseFrame(raw.toString()); } catch { return; }
        if (frame.type === "o") {
          this.send("authorize", token)
            .then(async (m) => {
              if (m.s && m.s >= 400) throw new Error(`authorize md → ${m.s}`);
              this.authorized = true;
              this.backoff = 1_000;
              this.startHeartbeat();
              for (const s of this.subs.values()) { s.active = false; await this.sendSubscribe(s.symbol); }
              for (const c of this.charts.values()) { c.active = false; c.ids.clear(); await this.sendChart(c); }
              this.log.info(`Flux de marché connecté (${this.env}) · ${this.subs.size} abonnement(s) · ${this.charts.size} graphique(s)`);
              if (!opened) { opened = true; resolve(); }
            })
            .catch((err) => { this.log.warn(`md : ${String(err?.message || err)}`); if (!opened) reject(err); ws.close(); });
          return;
        }
        if (frame.type === "h") return;
        if (frame.type === "c") return;
        for (const msg of frame.messages) this.dispatch(msg);
      });
      ws.on("error", (err) => { if (!opened) reject(err); });
      ws.on("close", () => {
        this.authorized = false;
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.rejectAll(new Error("md socket closed"));
        for (const s of this.subs.values()) s.active = false;
        for (const c of this.charts.values()) { c.active = false; c.ids.clear(); }
        if (!this.closing) this.scheduleReconnect();
      });
    });
  }

  private dispatch(msg: ServerMessage): void {
    if (typeof msg.i === "number") {
      const p = this.pending.get(msg.i);
      if (p) { clearTimeout(p.timer); this.pending.delete(msg.i); p.resolve(msg); }
      return;
    }
    if (msg.e === "chart" && msg.d) { this.applyChart(msg.d); return; }
    if (msg.e !== "md" || !msg.d) return;
    const quotes = (msg.d as any).quotes;
    if (!Array.isArray(quotes)) return;
    for (const q of quotes) this.applyQuote(q);
  }

  private applyQuote(q: any): void {
    const cid = Number(q?.contractId) || 0;
    let sym = cid ? this.byContract.get(cid) : undefined;
    if (!sym) {
      // Un seul abonnement sans contractId connu → c'est lui.
      const unknown = [...this.subs.values()].filter((s) => !s.contractId);
      if (unknown.length === 1 && cid) { unknown[0]!.contractId = cid; this.byContract.set(cid, unknown[0]!.symbol); sym = unknown[0]!.symbol; }
    }
    if (!sym) return;
    const e = q?.entries ?? {};
    const num = (x: any) => (typeof x?.price === "number" ? x.price : typeof x?.size === "number" && x.price === undefined ? undefined : undefined);
    const prev = this.quotes.get(sym) ?? { symbol: sym, ts: 0 };
    const quote: Quote = {
      ...prev,
      symbol: sym,
      contractId: cid || prev.contractId,
      last: num(e.Trade) ?? prev.last,
      bid: num(e.Bid) ?? prev.bid,
      ask: num(e.Offer) ?? prev.ask,
      high: num(e.HighPrice) ?? prev.high,
      low: num(e.LowPrice) ?? prev.low,
      open: num(e.OpeningPrice) ?? prev.open,
      settle: num(e.SettlementPrice) ?? prev.settle,
      volume: typeof e.TotalTradeVolume?.size === "number" ? e.TotalTradeVolume.size : prev.volume,
      ts: Date.now(),
    };
    this.quotes.set(sym, quote);
  }

  private send(endpoint: string, body: string): Promise<ServerMessage> {
    const id = ++this.reqId;
    const frame = buildRequestFrame(endpoint, id, "", body);
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error(`md socket not open for ${endpoint}`));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`md timeout: ${endpoint}`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(frame);
    });
  }
  private async request(endpoint: string, body?: unknown): Promise<ServerMessage> {
    const m = await this.send(endpoint, body === undefined ? "" : JSON.stringify(body));
    if (m.s && m.s >= 400) throw new Error(`${endpoint} -> ${m.s}: ${JSON.stringify(m.d)}`);
    return m;
  }
  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(HEARTBEAT_FRAME); }, HEARTBEAT_MS);
  }
  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.closing) return;
      try { await this.connect(); } catch (err) { this.log.debug(`md reconnexion : ${String((err as Error)?.message || err)}`); this.scheduleReconnect(); }
    }, delay);
  }
}
