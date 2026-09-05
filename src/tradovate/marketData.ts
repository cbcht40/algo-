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
              this.log.info(`Flux de marché connecté (${this.env}) · ${this.subs.size} abonnement(s)`);
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
