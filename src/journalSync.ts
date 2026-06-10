// Journal sync. The Copieur pulls the fills it can see (with its always-fresh
// Tradovate token) and pushes the resulting trades into the user's Let-Trade Journal
// (/api/copier-sync — Edge-gated + deduplicated). Two entry points:
//   - startJournalSync(): periodic background sync (last N days, all accounts).
//   - listAccounts()/importRange(): on-demand import driven by the website button,
//     exposed through the Copieur's local dashboard server.
import { logger } from "./logger";
import type { CopierEngine } from "./copier/engine";

const log = logger("journal-sync");
const SYNC_URL = process.env.JOURNAL_SYNC_URL || "https://let-tradejournal.com/api/copier-sync";
const WINDOW_DAYS = Number(process.env.JOURNAL_SYNC_DAYS) || 14;

// $ per point — same table as api/tradovate.js on the web side.
const MULTIPLIERS: Record<string, number> = {
  ES: 50, MES: 5, NQ: 20, MNQ: 2, RTY: 50, M2K: 10,
  YM: 5, MYM: 0.5, CL: 1000, QM: 500, GC: 100, MGC: 10,
  SI: 5000, ZN: 1000, ZB: 1000, ZT: 2000, ZF: 1000,
  ZC: 50, ZW: 50, ZS: 50, ZL: 600, ZM: 100,
  NG: 10000, HO: 42000, RB: 42000,
  "6E": 125000, "6B": 62500, "6J": 12500000, "6A": 100000, "6C": 100000,
  BTC: 5, MBT: 0.1, ETH: 50, MET: 0.1,
  HE: 400, LE: 400, GF: 500,
};
function getMultiplier(sym: string): number {
  const base = sym.replace(/[FGHJKMNQUVXZ]\d{2,4}$/, "").toUpperCase();
  return MULTIPLIERS[base] ?? 1;
}

interface Fill {
  accountId?: number;
  contractId: number;
  timestamp: string;
  action: string; // "Buy" | "Sell"
  qty: number;
  price: number;
}

interface SyncTrade {
  symbol: string;
  direction: "Long" | "Short";
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  initialEntry: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  pnl: number;
  commission: number;
  partials: number;
  notes: string;
  broker: string;
  importedAt: string;
  stopPrice: null;
  rr: null;
}

// FIFO position matching — same algorithm as api/tradovate.js groupFillsToTrades.
function groupFillsToTrades(fills: Fill[], symbolMap: Record<number, string>, broker: string): SyncTrade[] {
  const sorted = [...fills].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const positions: Record<string, { isBuy: boolean; qty: number; price: number; timestamp: string }[]> = {};
  const trades: SyncTrade[] = [];

  for (const fill of sorted) {
    const symbol = symbolMap[fill.contractId] || `#${fill.contractId}`;
    if (!positions[symbol]) positions[symbol] = [];
    const pos = positions[symbol];
    const isBuy = fill.action === "Buy";

    const netQty = pos.reduce((s, p) => s + (p.isBuy ? p.qty : -p.qty), 0);
    const isClosing = (netQty > 0 && !isBuy) || (netQty < 0 && isBuy);

    if (!isClosing) {
      pos.push({ isBuy, qty: fill.qty, price: fill.price, timestamp: fill.timestamp });
    } else {
      let remaining = fill.qty;
      while (remaining > 0 && pos.length > 0) {
        const open = pos[0]!;
        const matched = Math.min(remaining, open.qty);
        const direction: "Long" | "Short" = open.isBuy ? "Long" : "Short";
        const mult = getMultiplier(symbol);
        const diff = direction === "Long" ? fill.price - open.price : open.price - fill.price;
        const grossPnl = parseFloat((diff * matched * mult).toFixed(2));
        trades.push({
          symbol,
          direction,
          entryDate: open.timestamp,
          exitDate: fill.timestamp,
          entryPrice: open.price,
          initialEntry: open.price,
          exitPrice: fill.price,
          quantity: matched,
          grossPnl,
          pnl: grossPnl,
          commission: 0,
          partials: 1,
          notes: "",
          broker,
          importedAt: new Date().toISOString(),
          stopPrice: null,
          rr: null,
        });
        remaining -= matched;
        open.qty -= matched;
        if (open.qty <= 0) pos.shift();
      }
      if (remaining > 0) pos.push({ isBuy, qty: remaining, price: fill.price, timestamp: fill.timestamp });
    }
  }
  return trades;
}

export interface AccountInfo {
  id: number;
  name: string;
}

/** Authenticated accounts across all logins — feeds the website's account picker. */
export function listAccounts(engine: CopierEngine): AccountInfo[] {
  const out: AccountInfo[] = [];
  const seen = new Set<number>();
  for (const client of engine.allClients()) {
    if (!client.isAuthenticated) continue;
    for (const acct of client.accounts) {
      if (seen.has(acct.id)) continue;
      seen.add(acct.id);
      out.push({ id: acct.id, name: acct.name });
    }
  }
  return out;
}

// Fetch + FIFO-group fills in [sinceMs, untilMs] (optionally a single account).
async function collectTrades(
  engine: CopierEngine,
  opts: { sinceMs: number; untilMs?: number; accountId?: number },
): Promise<SyncTrade[]> {
  const untilMs = opts.untilMs ?? Date.now();
  const all: SyncTrade[] = [];

  for (const client of engine.allClients()) {
    if (!client.isAuthenticated) continue;
    let fills: Fill[];
    try {
      fills = (await client.restGet("/fill/list")) as Fill[];
    } catch (e) {
      log.warn(`Fills indisponibles : ${(e as Error).message}`);
      continue;
    }
    if (!Array.isArray(fills) || !fills.length) continue;

    const recent = fills.filter((f) => {
      if (!f.timestamp) return false;
      const t = new Date(f.timestamp).getTime();
      if (t < opts.sinceMs || t > untilMs) return false;
      if (opts.accountId != null && f.accountId !== opts.accountId) return false;
      return true;
    });
    if (!recent.length) continue;

    const ids = [...new Set(recent.map((f) => f.contractId))];
    const symbolMap: Record<number, string> = {};
    await Promise.all(
      ids.map(async (id) => {
        try {
          const c = (await client.restGet(`/contract/item?id=${id}`)) as { name?: string; symbol?: string };
          symbolMap[id] = c?.name || c?.symbol || `#${id}`;
        } catch {
          symbolMap[id] = `#${id}`;
        }
      }),
    );

    const accts = opts.accountId != null ? client.accounts.filter((a) => a.id === opts.accountId) : client.accounts;
    for (const acct of accts) {
      const af = recent.filter((f) => f.accountId === acct.id);
      if (!af.length) continue;
      all.push(...groupFillsToTrades(af, symbolMap, `Tradovate · ${acct.name}`));
    }
  }
  return all;
}

async function pushTrades(license: string, trades: SyncTrade[]): Promise<{ imported: number; skipped: number; error?: string }> {
  if (!trades.length) return { imported: 0, skipped: 0 };
  try {
    const r = await fetch(SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: license, trades }),
    });
    const j = (await r.json().catch(() => ({}))) as { inserted?: number; skipped?: number; error?: string };
    if (!r.ok) return { imported: 0, skipped: 0, error: j.error || `HTTP ${r.status}` };
    return { imported: j.inserted ?? 0, skipped: j.skipped ?? 0 };
  } catch (e) {
    return { imported: 0, skipped: 0, error: (e as Error).message };
  }
}

export interface SyncResult {
  imported: number;
  skipped: number;
  found: number;
  error?: string;
}

/** On-demand import (website button): fetch a window for one (or all) accounts and push. */
export async function importRange(
  engine: CopierEngine,
  license: string,
  opts: { accountId?: number; sinceMs: number; untilMs?: number },
): Promise<SyncResult> {
  if (!license) return { imported: 0, skipped: 0, found: 0, error: "licence manquante" };
  const trades = await collectTrades(engine, opts);
  const res = await pushTrades(license, trades);
  return { ...res, found: trades.length };
}

/** Periodic background sync (last N days, all authenticated accounts). */
export function startJournalSync(engine: CopierEngine, license: string): () => void {
  if (!license) {
    log.info("Synchro journal désactivée (pas de licence).");
    return () => {};
  }
  if (process.env.JOURNAL_SYNC === "off") {
    log.info("Synchro journal désactivée (JOURNAL_SYNC=off).");
    return () => {};
  }
  const intervalMs = Number(process.env.JOURNAL_SYNC_INTERVAL_MS) || 5 * 60_000;

  let busy = false;
  async function syncOnce(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const trades = await collectTrades(engine, { sinceMs: Date.now() - WINDOW_DAYS * 86_400_000 });
      if (!trades.length) {
        log.info("Synchro journal : rien de nouveau (comptes connectés sans trade récent).");
        return;
      }
      const r = await pushTrades(license, trades);
      if (r.error) log.warn(`Synchro journal refusée : ${r.error}`);
      else log.info(`Journal synchronisé : ${r.imported} nouveau(x), ${r.skipped} déjà présent(s).`);
    } catch (e) {
      log.warn(`Synchro journal : ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }

  log.info(`Synchro journal activée — toutes les ${Math.round(intervalMs / 60_000)} min → ${SYNC_URL}`);
  const t0 = setTimeout(() => void syncOnce(), 20_000); // let logins authenticate first
  const timer = setInterval(() => void syncOnce(), intervalMs);
  return () => {
    clearTimeout(t0);
    clearInterval(timer);
  };
}
