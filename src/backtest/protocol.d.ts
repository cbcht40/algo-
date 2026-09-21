/** Backtesting v1. No real order routing capability exists in this protocol. */
export interface Instrument { symbol: string; root: string; tickSize: string | null; pointValue: string | null; currency: string | null; timezone: string; verified: boolean }
export interface MarketEvent { ts: string; valid: boolean; reason?: string; gap?: boolean; bid: { price: string; size: number } | null; ask: { price: string; size: number } | null; trades: Array<{ price: string; size: number; side: 'buy' | 'sell' | 'unknown' }> }
export interface DatasetManifest { version: 1; id: string; name: string; source: 'databento' | 'rithmic'; start: string; end: string; bytes: number; schema: string; instruments: Instrument[]; capabilities: { trades: boolean; depth: boolean; aggressor: boolean }; fingerprint: string }
export interface ReplaySettings { capital: string; commission: string; slippageTicks: number; costsConfirmed: true }
export interface ReplayCommand { commandId: string; type: 'place' | 'cancel' | 'modify' | 'flatten'; kind?: 'market' | 'limit' | 'stop'; side?: 'buy' | 'sell'; quantity?: number; price?: string; orderId?: string; reduceOnly?: boolean; stopTicks?: number; targetTicks?: number }
