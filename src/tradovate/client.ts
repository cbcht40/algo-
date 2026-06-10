import WebSocket from "ws";
import { logger, type Logger } from "../logger";
import {
  acquireAccessToken,
  deviceIdFor,
  renewAccessToken,
  REST_BASE,
  WS_URL,
} from "./auth";
import {
  buildRequestFrame,
  HEARTBEAT_FRAME,
  parseFrame,
  type ServerMessage,
} from "./ws";
import type {
  Account,
  Contract,
  Environment,
  PropsEvent,
  TokenResponse,
} from "./types";

export interface ClientOptions {
  label: string;
  environment: Environment;
  appId: string;
  appVersion: string;
  // "token mode": reuse an access token (e.g. from a logged-in web session).
  // When set, no API key is needed — we bootstrap/renew straight from the token.
  accessToken?: string;
  // "apikey mode": mint a token from credentials + an API key (cid/sec).
  name?: string;
  password?: string;
  cid?: number;
  sec?: string;
  // Optional host overrides (if your web session talks to a non-default host).
  restBase?: string;
  wsUrl?: string;
}

interface Pending {
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
  endpoint: string;
  timer: NodeJS.Timeout;
}

const HEARTBEAT_MS = 2_500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

type EntityHandler = (ev: PropsEvent) => void;
type StatusHandler = (status: "connected" | "disconnected" | "ready") => void;

/**
 * One authenticated, self-healing connection to a single Tradovate login.
 * A login can expose several trading accounts; `accounts` lists them after
 * the initial sync. Orders are placed over the already-open websocket for the
 * lowest possible latency.
 */
export class TradovateClient {
  readonly label: string;
  readonly env: Environment;
  userId = 0;
  accounts: Account[] = [];

  private opts: ClientOptions;
  private log: Logger;
  private restBase: string;
  private wsUrl: string;
  private ws?: WebSocket;
  private token?: TokenResponse;

  private reqId = 0;
  private pending = new Map<number, Pending>();
  private heartbeatTimer?: NodeJS.Timeout;
  private renewTimer?: NodeJS.Timeout;
  private backoff = 1_000;
  private closing = false;
  private authorized = false;

  private entityHandlers = new Set<EntityHandler>();
  private statusHandlers = new Set<StatusHandler>();
  private contractCache = new Map<number, string>();

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.label = opts.label;
    this.env = opts.environment;
    this.restBase = opts.restBase ?? REST_BASE[opts.environment];
    this.wsUrl = opts.wsUrl ?? WS_URL[opts.environment];
    this.log = logger(opts.label);
  }

  onEntity(h: EntityHandler) {
    this.entityHandlers.add(h);
  }
  onStatus(h: StatusHandler) {
    this.statusHandlers.add(h);
  }

  /** Authenticate over REST, open the websocket, authorize it, then sync. */
  async start(): Promise<void> {
    await this.authenticate();
    await this.connectSocket();
  }

  private async authenticate(): Promise<void> {
    if (this.opts.accessToken !== undefined) {
      // Token mode: renew the (web-session) token to validate it and learn the
      // userId + expiry. Renew from the freshest token we hold.
      const seed = this.token?.accessToken ?? this.opts.accessToken;
      this.log.info("Validating session token…");
      this.token = await renewAccessToken(this.restBase, seed);
    } else {
      const deviceId = deviceIdFor(this.opts.name ?? this.opts.label);
      this.log.info("Authenticating with API key…");
      this.token = await acquireAccessToken(this.restBase, {
        name: this.opts.name!,
        password: this.opts.password!,
        appId: this.opts.appId,
        appVersion: this.opts.appVersion,
        cid: this.opts.cid!,
        sec: this.opts.sec!,
        deviceId,
      });
    }
    this.userId = this.token.userId;
    this.scheduleRenewal();
    this.log.info(`Authenticated as userId=${this.userId}.`);
  }

  private scheduleRenewal(): void {
    if (this.renewTimer) clearTimeout(this.renewTimer);
    if (!this.token?.expirationTime) return;
    const expiresIn = new Date(this.token.expirationTime).getTime() - Date.now();
    // Renew a few minutes early; never schedule a negative/zero delay.
    const delay = Math.max(30_000, expiresIn - 5 * 60_000);
    this.renewTimer = setTimeout(async () => {
      try {
        this.token = await renewAccessToken(this.restBase, this.token!.accessToken);
        this.log.debug("Access token renewed.");
        this.scheduleRenewal();
      } catch (err) {
        this.log.warn(`Token renewal failed, will re-auth on next reconnect: ${String(err)}`);
      }
    }, delay);
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.wsUrl;
      this.log.debug(`Opening websocket ${url}`);
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;

      ws.on("message", (raw: WebSocket.RawData) => {
        const text = raw.toString();
        // The server can pack several frames? In practice one frame per message.
        let frame;
        try {
          frame = parseFrame(text);
        } catch (err) {
          this.log.warn(`Bad frame: ${String(err)}`);
          return;
        }

        if (frame.type === "o") {
          // Open frame -> authorize this socket with our bearer token.
          this.authorizeSocket()
            .then(async () => {
              this.authorized = true;
              this.startHeartbeat();
              this.emitStatus("connected");
              await this.syncRequest();
              this.emitStatus("ready");
              if (!opened) {
                opened = true;
                this.backoff = 1_000;
                resolve();
              }
            })
            .catch((err) => {
              this.log.error(`Authorization failed: ${String(err)}`);
              if (!opened) reject(err);
              ws.close();
            });
          return;
        }

        if (frame.type === "h") return; // server heartbeat, nothing to do
        if (frame.type === "c") {
          this.log.warn(`Server close frame: ${JSON.stringify(frame.data)}`);
          return;
        }
        for (const msg of frame.messages) this.dispatch(msg);
      });

      ws.on("error", (err) => {
        this.log.warn(`Websocket error: ${String(err)}`);
        if (!opened) reject(err);
      });

      ws.on("close", () => {
        this.authorized = false;
        this.stopHeartbeat();
        this.emitStatus("disconnected");
        this.rejectAllPending(new Error("socket closed"));
        if (!this.closing) this.scheduleReconnect();
      });
    });
  }

  private async authorizeSocket(): Promise<void> {
    if (!this.token) throw new Error("no token");
    const msg = await this.send("authorize", this.token.accessToken);
    if (msg.s && msg.s >= 400) {
      throw new Error(`authorize rejected: status ${msg.s}`);
    }
  }

  /** Pull the full account/order/position snapshot and start the event stream. */
  private async syncRequest(): Promise<void> {
    const msg = await this.request("user/syncrequest", { users: [this.userId] });
    const d = msg.d ?? {};
    if (Array.isArray(d.accounts)) {
      this.accounts = d.accounts as Account[];
      this.log.info(
        `Sync complete — ${this.accounts.length} account(s): ` +
          this.accounts.map((a) => `${a.name}#${a.id}`).join(", "),
      );
    }
    // Replay the snapshot as entity events so engine logic has one code path.
    this.replaySnapshot(d);
  }

  private replaySnapshot(d: Record<string, any>): void {
    const buckets: Array<[string, string]> = [
      ["contracts", "contract"],
      ["accounts", "account"],
      ["positions", "position"],
      ["orders", "order"],
      ["orderVersions", "orderVersion"],
      ["fills", "fill"],
    ];
    for (const [key, entityType] of buckets) {
      const arr = d[key];
      if (!Array.isArray(arr)) continue;
      for (const entity of arr) {
        if (entityType === "contract" && entity?.id && entity?.name) {
          this.contractCache.set(entity.id, entity.name);
        }
        this.emitEntity({ entityType, eventType: "Snapshot", entity });
      }
    }
  }

  private dispatch(msg: ServerMessage): void {
    // Responses carry an `i` (request id). Events carry an `e` (channel).
    if (typeof msg.i === "number") {
      const p = this.pending.get(msg.i);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.i);
        p.resolve(msg);
      }
      return;
    }
    if (msg.e === "props" && msg.d) {
      this.emitEntity(msg.d as PropsEvent);
      return;
    }
    if (msg.e === "shutdown") {
      this.log.warn("Server requested shutdown of this socket.");
      return;
    }
    // Any other event channel (md, chart, clock…) — surface it so we notice if
    // order updates ever arrive somewhere we don't expect.
    if (msg.e) this.log.debug(`event channel=${msg.e} (not handled)`);
  }

  private emitEntity(ev: PropsEvent): void {
    for (const h of this.entityHandlers) {
      try {
        h(ev);
      } catch (err) {
        this.log.error(`entity handler threw: ${String(err)}`);
      }
    }
  }

  private emitStatus(status: "connected" | "disconnected" | "ready"): void {
    for (const h of this.statusHandlers) h(status);
  }

  // --- request/response over the socket -------------------------------------

  /** Low-level frame send with id correlation. `body` is sent verbatim. */
  private send(endpoint: string, body: string): Promise<ServerMessage> {
    const id = ++this.reqId;
    const frame = buildRequestFrame(endpoint, id, "", body);
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`socket not open for ${endpoint}`));
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${endpoint}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, endpoint, timer });
      this.ws.send(frame);
    });
  }

  /** JSON request helper used for normal endpoints (order/placeorder, etc.). */
  async request(endpoint: string, body?: unknown): Promise<ServerMessage> {
    const msg = await this.send(endpoint, body === undefined ? "" : JSON.stringify(body));
    if (msg.s && msg.s >= 400) {
      throw new Error(`${endpoint} -> status ${msg.s}: ${JSON.stringify(msg.d)}`);
    }
    return msg;
  }

  // --- contract name resolution (cached) ------------------------------------

  async contractName(contractId: number): Promise<string> {
    const cached = this.contractCache.get(contractId);
    if (cached) return cached;
    const msg = await this.sendQuery("contract/item", `id=${contractId}`);
    const name = (msg.d as Contract | undefined)?.name;
    if (name) this.contractCache.set(contractId, name);
    return name ?? String(contractId);
  }

  private sendQuery(endpoint: string, query: string): Promise<ServerMessage> {
    const id = ++this.reqId;
    const frame = buildRequestFrame(endpoint, id, query, "");
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`socket not open for ${endpoint}`));
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request timeout: ${endpoint}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, endpoint, timer });
      this.ws.send(frame);
    });
  }

  // --- heartbeat / reconnect ------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(HEARTBEAT_FRAME);
    }, HEARTBEAT_MS);
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect(): void {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.log.warn(`Reconnecting in ${Math.round(delay / 1000)}s…`);
    setTimeout(async () => {
      if (this.closing) return;
      try {
        // Token may have expired while we were down — re-auth defensively.
        if (!this.token || new Date(this.token.expirationTime).getTime() < Date.now() + 60_000) {
          await this.authenticate();
        }
        await this.connectSocket();
      } catch (err) {
        this.log.warn(`Reconnect failed: ${String(err)}`);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    this.closing = true;
    this.stopHeartbeat();
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.ws?.close();
  }

  get isReady(): boolean {
    return this.authorized && this.ws?.readyState === WebSocket.OPEN;
  }
}
