// Real-time journal sync. The Copieur already receives the master account's fills
// over the websocket (it uses them to mirror orders). We listen to that same stream,
// reconstruct completed trades (FIFO), and push them to the user's Let-Trade Journal
// (/api/copier-sync — Edge-gated + deduplicated). No history is fetched (Tradovate's
// REST exposes none); this captures trades AS THEY HAPPEN, going forward.
import { logger } from "./logger";
import type { CopierEngine } from "./copier/engine";

const log = logger("journal-sync");
const SYNC_URL = process.env.JOURNAL_SYNC_URL || "https://let-tradejournal.com/api/copier-sync";
const SETTLE_MS = Number(process.env.JOURNAL_SYNC_SETTLE_MS) || 8_000;

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
          symbol, direction,
          entryDate: open.timestamp, exitDate: fill.timestamp,
          entryPrice: open.price, initialEntry: open.price, exitPrice: fill.price,
          quantity: matched, grossPnl, pnl: grossPnl, commission: 0, partials: 1,
          notes: "", broker, importedAt: new Date().toISOString(), stopPrice: null, rr: null,
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

/**
 * Listen to the master account's live fills and journal completed trades in real
 * time. Returns a stop() function. No-op without a license or when JOURNAL_SYNC=off.
 */
export function startJournalSync(engine: CopierEngine, license: string): () => void {
  if (!license) {
    log.info("Synchro journal désactivée (pas de licence).");
    return () => {};
  }
  if (process.env.JOURNAL_SYNC === "off") {
    log.info("Synchro journal désactivée (JOURNAL_SYNC=off).");
    return () => {};
  }
  const master = engine.masterClientRef;
  if (!master) {
    log.warn("Synchro journal : pas de compte maître — désactivée.");
    return () => {};
  }

  const orderAccount = new Map<number, number>(); // orderId -> accountId
  const sessionFills = new Map<number, Fill & { orderId: number }>(); // fill id -> fill (all accounts)
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    // Attribute at flush time (the order events have arrived by now) and keep
    // only the master account's own fills.
    const masterId = engine.masterAccountIdRef;
    const list = [...sessionFills.values()].filter((f) => orderAccount.get(f.orderId) === masterId);
    if (!list.length) return;
    const symbolMap: Record<number, string> = {};
    for (const id of new Set(list.map((f) => f.contractId))) {
      symbolMap[id] = await master!.contractName(id);
    }
    const trades = groupFillsToTrades(list, symbolMap, `Tradovate · ${engine.masterLabelRef}`);
    if (!trades.length) return;
    const r = await pushTrades(license, trades);
    if (r.error) log.warn(`Synchro journal refusée : ${r.error}`);
    else log.info(`Journal (temps réel) : ${r.imported} nouveau(x), ${r.skipped} déjà présent(s) — ${trades.length} trade(s) reconstruits.`);
  }
  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, SETTLE_MS);
  }

  master.onEntity((ev) => {
    if (ev.entityType === "order") {
      const o = ev.entity as { id?: number; accountId?: number };
      if (typeof o.id === "number" && typeof o.accountId === "number") orderAccount.set(o.id, o.accountId);
      return;
    }
    if (ev.entityType !== "fill") return;
    const e = ev.entity as { id?: number; orderId?: number; contractId?: number; timestamp?: string; action?: string; qty?: number; price?: number };
    if (typeof e.id !== "number" || typeof e.orderId !== "number" || typeof e.contractId !== "number") return;
    if (typeof e.qty !== "number" || typeof e.price !== "number") return;
    sessionFills.set(e.id, {
      orderId: e.orderId,
      contractId: e.contractId,
      timestamp: e.timestamp ?? new Date().toISOString(),
      action: e.action ?? "Buy",
      qty: e.qty,
      price: e.price,
    });
    schedule();
  });

  log.info(`Synchro journal activée (temps réel — compte maître) → ${SYNC_URL}`);
  return () => { if (timer) clearTimeout(timer); };
}
