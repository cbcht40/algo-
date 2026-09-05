// Lien avec Let-Trade Journal (le site) — deux services, authentifiés par la clé Edge :
//   • synchronisation immédiate : une position vient d'être clôturée → on demande au
//     journal de tirer les trades Tradovate tout de suite (au lieu du cron 15 min) ;
//   • avis IA : à chaque prise de position, une note /100 + raisons, calculée par le
//     journal à partir de tout l'historique du trader et de ses dernières analyses.
import { logger } from "./logger";

const log = logger("journal");

export interface ScoreRequest {
  symbol: string;
  action: "Buy" | "Sell";
  qty: number;
  orderType?: string;
  price?: number;
  stopTicks?: number;
  targetTicks?: number;
  tickSize?: number;
  accounts: number;
  source: string;
  ts: number;
}

export interface ScoreResult {
  ts: number;
  entry: ScoreRequest;
  score?: number;
  verdict?: "go" | "caution" | "avoid";
  headline?: string;
  reasons?: string[];
  warning?: string | null;
  error?: string;
  ms?: number;
  context?: Record<string, unknown>;
}

export interface SyncState {
  at: number;
  inserted: number;
  updated: number;
  error?: string;
  hint?: string;
  covered: string[];
  connections: Array<{ label?: string; inserted?: number; updated?: number; error?: string; skipped?: boolean }>;
  trigger: "auto" | "manual";
}

const SYNC_DEBOUNCE_MS = 8_000;

export class JournalLink {
  private key?: string;
  private baseUrl: string;
  private syncTimer?: NodeJS.Timeout;
  private syncing = false;
  private pendingReason = "";
  private lastSync?: SyncState;
  private lastScore?: ScoreResult;
  private scoring = false;
  private history: ScoreResult[] = [];
  private onScore?: (r: ScoreResult) => void;
  private onSync?: (s: SyncState) => void;

  constructor(opts: { key?: string; baseUrl?: string; onScore?: (r: ScoreResult) => void; onSync?: (s: SyncState) => void }) {
    this.key = opts.key?.trim() || undefined;
    const verify = process.env.COPIER_VERIFY_URL || "https://let-tradejournal.com/api/copier-verify";
    this.baseUrl = (opts.baseUrl || process.env.COPIER_JOURNAL_URL || new URL(verify).origin).replace(/\/$/, "");
    this.onScore = opts.onScore;
    this.onSync = opts.onSync;
  }

  get enabled(): boolean {
    return !!this.key;
  }

  /** Une position vient de se fermer sur un compte → synchro du journal dans 8 s (regroupe
   *  les clôtures quasi simultanées de plusieurs comptes en une seule demande). */
  positionClosed(reason = ""): void {
    if (!this.key) return;
    this.pendingReason = reason;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { this.syncTimer = undefined; void this.syncNow(false, "auto"); }, SYNC_DEBOUNCE_MS);
  }

  async syncNow(force = false, trigger: "auto" | "manual" = "manual"): Promise<SyncState> {
    const base: SyncState = { at: Date.now(), inserted: 0, updated: 0, covered: [], connections: [], trigger };
    if (!this.key) return { ...base, error: "aucune clé de licence" };
    if (this.syncing) return this.lastSync ?? { ...base, error: "déjà en cours" };
    this.syncing = true;
    try {
      const r = await fetch(`${this.baseUrl}/api/copier-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: this.key, force }),
        signal: AbortSignal.timeout(90_000),
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, any>;
      const st: SyncState = {
        ...base,
        inserted: Number(d.inserted) || 0,
        updated: Number(d.updated) || 0,
        covered: Array.isArray(d.covered) ? d.covered.map(String) : [],
        connections: Array.isArray(d.connections) ? d.connections : [],
        hint: d.hint,
        error: r.ok && d.ok !== false ? undefined : String(d.error || (d.connections || []).map((c: any) => c.error).filter(Boolean).join(" ; ") || `HTTP ${r.status}`),
      };
      this.lastSync = st;
      if (st.error) log.warn(`Journal : synchro ${trigger} → ${st.error}`);
      else log.info(`Journal : synchro ${trigger}${this.pendingReason ? ` (${this.pendingReason})` : ""} → ${st.inserted} trade(s) ajouté(s), ${st.updated} mis à jour${st.hint ? ` · ${st.hint}` : ""}`);
      this.pendingReason = "";
      this.onSync?.(st);
      return st;
    } catch (err) {
      const st: SyncState = { ...base, error: String((err as Error)?.message || err) };
      this.lastSync = st;
      log.warn(`Journal : synchro impossible — ${st.error}`);
      this.onSync?.(st);
      return st;
    } finally {
      this.syncing = false;
    }
  }

  /** Avis IA sur une entrée. Ne bloque jamais l'ordre (appelé APRÈS l'envoi). */
  async scoreEntry(req: ScoreRequest): Promise<ScoreResult | null> {
    if (!this.key) return null;
    if (this.scoring) { log.debug("Journal : avis IA déjà en cours — entrée ignorée"); return null; }
    this.scoring = true;
    const started = Date.now();
    try {
      const r = await fetch(`${this.baseUrl}/api/copier-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Fuseau de la machine du trader (le journal n'a pas cette info en base).
        body: JSON.stringify({ key: this.key, entry: req, utcOffset: -new Date().getTimezoneOffset() / 60 }),
        signal: AbortSignal.timeout(40_000),
      });
      const d = (await r.json().catch(() => ({}))) as Record<string, any>;
      const res: ScoreResult = r.ok && d.ok
        ? { ts: Date.now(), entry: req, score: d.score, verdict: d.verdict, headline: d.headline, reasons: d.reasons, warning: d.warning, ms: Date.now() - started, context: d.context }
        : { ts: Date.now(), entry: req, error: String(d.error || `HTTP ${r.status}`), ms: Date.now() - started };
      this.lastScore = res;
      this.history = [res, ...this.history].slice(0, 20);
      if (res.error) log.warn(`Avis IA indisponible : ${res.error}`);
      else log.info(`Avis IA ${res.score}/100 (${res.verdict}) — ${res.headline} [${res.ms} ms]`);
      this.onScore?.(res);
      return res;
    } catch (err) {
      const res: ScoreResult = { ts: Date.now(), entry: req, error: String((err as Error)?.message || err), ms: Date.now() - started };
      this.lastScore = res;
      log.warn(`Avis IA impossible — ${res.error}`);
      this.onScore?.(res);
      return res;
    } finally {
      this.scoring = false;
    }
  }

  state() {
    return {
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      syncing: this.syncing,
      pendingSync: !!this.syncTimer,
      lastSync: this.lastSync ?? null,
      scoring: this.scoring,
      lastScore: this.lastScore ?? null,
      scores: this.history.slice(0, 5),
    };
  }
}
