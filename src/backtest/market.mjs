import { priceNumber } from './money.mjs'
const UNDEF = 9223372036854775807n
const lowerBound = (a, p) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < p) lo = m + 1; else hi = m } return lo }

// Databento MBO: T and F never mutate resting orders. C is the actual reduction.
// See https://databento.com/docs/examples/order-book/order-tracking
export class MboMarket {
  constructor() {
    this.orders = new Map(); this.levels = { A: new Map(), B: new Map() }; this.prices = { A: [], B: [] }
    this.initialized = false; this.valid = false; this.corrupt = false; this.reason = 'Instantané du carnet en cours'
    this.trades = []; this.clock = 0n; this.last = null; this.bars = []; this.footprints = new Map(); this.badTimestamp = false
  }
  level(side, price, delta) {
    const levels = this.levels[side], prices = this.prices[side]
    const value = (levels.get(price) || 0) + delta
    if (value < 0) { this.corrupt = true; this.reason = 'Quantité de carnet incohérente'; return }
    if (value === 0) { levels.delete(price); const i = lowerBound(prices, price); if (prices[i] === price) prices.splice(i, 1) }
    else { if (!levels.has(price)) prices.splice(lowerBound(prices, price), 0, price); levels.set(price, value) }
  }
  remove(id) {
    const order = this.orders.get(id)
    if (order) { this.level(order.side, order.price, -order.size); this.orders.delete(id) }
  }
  apply(r) {
    const { action, side, size, flags } = r
    const price = BigInt(r.price), id = String(r.orderId)
    if (!(flags & 32) && ((flags & 8) || BigInt(r.ts) < this.clock)) this.badTimestamp = true
    this.clock = BigInt(r.ts) > this.clock ? BigInt(r.ts) : this.clock
    if (action === 'R') {
      this.orders.clear(); this.levels.A.clear(); this.levels.B.clear(); this.prices = { A: [], B: [] }
      this.initialized = true; this.corrupt = false; this.valid = false; this.trades = []
    } else if (action === 'T') {
      if (!(flags & 32) && price !== UNDEF && size > 0) this.trades.push({ price: price.toString(), size, side: side === 'B' ? 'buy' : side === 'A' ? 'sell' : 'unknown', ts: r.ts })
    } else if (['A', 'C', 'M'].includes(action)) {
      if (!['A', 'B'].includes(side)) { this.corrupt = true; this.reason = 'Sens du carnet invalide' }
      else if (action === 'C') {
        const old = this.orders.get(id)
        if (!old || size > old.size || old.side !== side || old.price !== price) { this.corrupt = true; this.reason = 'Historique du carnet incomplet' }
        else { this.level(side, old.price, -size); old.size -= size; if (!old.size) this.orders.delete(id) }
      } else {
        if (flags & 64) { for (const [key, o] of this.orders) if (o.side === side) this.orders.delete(key); this.levels[side].clear(); this.prices[side] = [] }
        const old = this.orders.get(id)
        if (action === 'A' && old) { this.corrupt = true; this.reason = 'Ordre de carnet dupliqué' }
        this.remove(id)
        if (price !== UNDEF && size > 0) { this.orders.set(id, { side, price, size }); this.level(side, price, size) }
      }
    }
    if (flags & 4) { this.corrupt = true; this.reason = 'Trou de données signalé par Databento : nouveau carnet requis' }
    if (!(flags & 128)) return null
    const bid = this.best('B'), ask = this.best('A')
    this.valid = this.initialized && !this.corrupt && !this.badTimestamp && !!bid && !!ask && BigInt(bid.price) < BigInt(ask.price)
    if (this.valid) this.reason = null
    else if (!this.corrupt) this.reason = this.badTimestamp ? 'Horodatage de réception incertain : opérations suspendues' : 'Carnet vide, croisé ou en reconstruction'
    const event = { ts: this.clock.toString(), bid, ask, valid: this.valid, gap: this.corrupt || this.badTimestamp, reason: this.reason, trades: this.trades }
    this.trades = []; this.badTimestamp = false
    for (const trade of event.trades) this.recordTrade(trade, this.clock)
    return event
  }
  best(side) {
    const p = side === 'B' ? this.prices.B.at(-1) : this.prices.A[0]
    return p === undefined ? null : { price: p.toString(), size: this.levels[side].get(p) }
  }
  recordTrade(trade, clock) {
    const time = Math.floor(Number(clock / 1_000_000_000n) / 15) * 15
    const p = priceNumber(trade.price)
    this.last = p
    let bar = this.bars.at(-1)
    if (bar?.time !== time) { bar = { time, open: p, high: p, low: p, close: p, volume: 0 }; this.bars.push(bar) }
    bar.high = Math.max(bar.high, p); bar.low = Math.min(bar.low, p); bar.close = p; bar.volume += trade.size
    // Retain raw footprint for the last hour; older candles remain available.
    let levels = this.footprints.get(time)
    if (!levels) { levels = new Map(); this.footprints.set(time, levels) }
    const row = levels.get(trade.price) || { price: p, buy: 0, sell: 0, unknown: 0 }
    row[trade.side] += trade.size; levels.set(trade.price, row)
    if (this.footprints.size > 240) this.footprints.delete(this.footprints.keys().next().value)
    if (this.bars.length > 60000) this.bars.splice(0, 1000)
  }
  view(seconds = 60) {
    const bars = []
    for (const b of this.bars) {
      const time = Math.floor(b.time / seconds) * seconds, prior = bars.at(-1)
      if (prior?.time === time) { prior.high = Math.max(prior.high, b.high); prior.low = Math.min(prior.low, b.low); prior.close = b.close; prior.volume += b.volume }
      else bars.push({ ...b, time })
    }
    const bucket = Math.floor(Number(this.clock / 1_000_000_000n) / seconds) * seconds
    const fp = new Map()
    for (const [time, levels] of this.footprints) if (time >= bucket) for (const [p, row] of levels) {
      const sum = fp.get(p) || { price: row.price, buy: 0, sell: 0, unknown: 0 }
      sum.buy += row.buy; sum.sell += row.sell; sum.unknown += row.unknown; fp.set(p, sum)
    }
    const depth = side => (side === 'B' ? this.prices.B.slice(-20).reverse() : this.prices.A.slice(0, 20)).map(p => ({ price: priceNumber(p), size: this.levels[side].get(p) }))
    return { valid: this.valid, reason: this.reason, last: this.last, clock: this.clock.toString(), bars: bars.slice(-1600),
      footprint: [...fp.values()].sort((a, b) => b.price - a.price).slice(0, 250), footprintComplete: seconds <= 3600 && fp.size <= 250,
      bids: this.valid ? depth('B') : [], asks: this.valid ? depth('A') : [] }
  }
}
