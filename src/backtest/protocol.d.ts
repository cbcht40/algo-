/** Backtesting v1. No real order routing capability exists in this protocol. */
export interface Instrument { symbol: string; root: string; tickSize: string | null; pointValue: string | null; currency: string | null; timezone: string; verified: boolean }
export interface MarketEvent { ts: string; valid: boolean; reason?: string; gap?: boolean; bid: { price: string; size: number } | null; ask: { price: string; size: number } | null; trades: Array<{ price: string; size: number; side: 'buy' | 'sell' | 'unknown' }> }
export interface DatasetManifest { version: 1; id: string; name: string; source: 'databento' | 'rithmic'; start: string; end: string; bytes: number; schema: string; instruments: Instrument[]; capabilities: { trades: boolean; depth: boolean; aggressor: boolean }; fingerprint: string }
export interface ReplaySettings { capital: string; commission: string; slippageTicks: number; costsConfirmed: true }
export interface ReplayCommand { commandId: string; type: 'place' | 'cancel' | 'modify' | 'flatten'; kind?: 'market' | 'limit' | 'stop'; side?: 'buy' | 'sell'; quantity?: number; price?: string; orderId?: string; reduceOnly?: boolean; stopTicks?: number; targetTicks?: number }
export type PlaybackSpeed = 1 | 2 | 5 | 10 | 30
export type IntervalSeconds = 15 | 30 | 60 | 120 | 180 | 300 | 600 | 900 | 1800 | 3600 | 14400 | 86400
export type ReplayControl = { type: 'play' | 'pause' | 'step' } | { type: 'nextBar'; seconds: IntervalSeconds } | { type: 'speed'; speed: PlaybackSpeed } | { type: 'notes'; notes: string } | { type: 'drawings'; drawings: Drawing[] }
export interface Drawing { id: string; type: 'line' | 'trend' | 'zone'; time1: number; price1: number; time2?: number; price2?: number }
export interface PairGrant { token: string; userId: string; expiresAt: number }
export interface ReplayPosition { quantity: number; averagePrice: number | null; unrealized: number | null; unrealizedNet: number | null }
export interface ReplayTrade { id: string; side: 1 | -1; entry: string; exit: string; contracts: number; gross: number; entryFees: number; exitFees: number; net: number; risk: number | null; r: number | null }
export interface ReplayStatistics {
  capital: number; gross: number; fees: number; realizedNet: number; cash: number; equity: number | null;
  drawdown: number; drawdownPct: number; count: number; winners: number; losers: number;
  winRate: number | null; profitFactor: number | 'infinity' | null; averageWin: number | null; averageLoss: number | null; expectancy: number | null;
}
/** Whitelisted cloud summary: excludes paths, credentials, raw ticks and real account IDs. */
export interface SessionResult {
  version: 1; id: string; name: string; source: 'databento' | 'rithmic'; symbol: string; currency: string;
  createdAt: string; updatedAt: string; status: 'paused' | 'finished'; start: string; clock: string;
  datasetFingerprint: string | null; attemptOf: string | null;
  settings: {capital: number; commission: number; slippageTicks: number}; stats: ReplayStatistics;
  position: ReplayPosition; trades: ReplayTrade[]; equity: Array<{time: number; value: number}>; notes: string;
}
