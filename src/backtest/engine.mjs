// Complete simulated fill ledger only. Never imports broker positions or routes real orders.
import { SCALE, fixed, rounded, priceNumber, centsNumber, integer, jsonState, parseState } from './money.mjs'
export const ENGINE_VERSION = 1
export class ReplayEngine {
  constructor({ instrument, capital = '50000', commission, slippageTicks, costsConfirmed }) {
    if (!instrument?.verified || !instrument?.symbol || !instrument?.currency) throw new Error('Caractéristiques du contrat non vérifiées')
    if (!costsConfirmed || commission == null || slippageTicks == null) throw new Error('Confirme les frais et le glissement')
    this.instrument = { ...instrument }
    this.tick = fixed(instrument.tickSize)
    this.pointCents = fixed(instrument.pointValue, 2)
    this.capital = fixed(capital, 2)
    this.commission = fixed(commission, 2)
    if (this.tick <= 0n || this.pointCents <= 0n || this.capital <= 0n || this.capital > 100_000_000_000n || this.commission < 0n || this.commission > 100000n) throw new Error('Capital ou frais invalides')
    this.slippageTicks = integer(slippageTicks, 0, 1000)
    this.version = ENGINE_VERSION
    this.sequence = 0; this.nextId = 1; this.clock = '0'; this.market = null
    this.orders = []; this.fills = []; this.lots = []; this.trades = []; this.commands = []
    this.gross = 0n; this.fees = 0n; this.realizedNet = 0n
    this.currentTrade = null; this.peakEquity = this.capital; this.maxDrawdown = 0n; this.maxDrawdownPct = 0
    this.equity = []; this.lastError = null
  }
  get quantity() { return this.lots.reduce((n, l) => n + l.side * l.quantity, 0) }
  get pending() { return this.orders.filter(o => o.status === 'working' || o.status === 'triggered') }
  price(value) {
    const p = fixed(value)
    if (p % this.tick) throw new Error(`Le prix doit respecter le tick de ${this.instrument.tickSize}`)
    return p
  }
  command(c) {
    if (!c?.commandId || typeof c.commandId !== 'string' || c.commandId.length > 100) throw new Error('Identifiant de commande requis')
    const existing = this.commands.find(x => x.commandId === c.commandId)
    if (existing) return existing.result
    if (this.commands.length >= 20000) throw new Error('Limite de commandes atteinte pour cette session')
    let result
    if (c.type === 'place') result = this.place(c)
    else if (c.type === 'cancel') {
      const order = this.pending.find(o => o.id === c.orderId)
      if (!order) throw new Error('Ordre déjà exécuté ou annulé')
      order.status = 'cancelled'; result = order.id
    } else if (c.type === 'modify') {
      const order = this.pending.find(o => o.id === c.orderId)
      if (!order || order.kind === 'market' || order.status === 'triggered') throw new Error('Cet ordre ne peut plus être déplacé')
      order.price = this.price(c.price); order.after = this.sequence
      const quote = order.side > 0 ? this.market?.ask : this.market?.bid
      order.aggressiveUntil = quote && (order.side > 0 ? BigInt(quote.price) <= order.price : BigInt(quote.price) >= order.price) ? this.sequence + 1 : null
      result = order.id
    } else if (c.type === 'flatten') {
      if (!this.quantity) throw new Error('Aucune position ouverte')
      this.pending.forEach(o => { o.status = 'cancelled' })
      result = this.place({ side: this.quantity > 0 ? 'sell' : 'buy', quantity: Math.abs(this.quantity), kind: 'market', reduceOnly: true })
    } else throw new Error('Commande inconnue')
    this.commands.push({ ...c, at: this.clock, after: this.sequence, result })
    return result
  }
  place(c, protective = false) {
    if (!this.market?.valid && !protective) throw new Error('Attends une cotation valide pour placer un ordre')
    if (!['buy', 'sell'].includes(c.side) || !['market', 'limit', 'stop'].includes(c.kind)) throw new Error('Type d’ordre invalide')
    if (this.pending.length >= 100) throw new Error('Trop d’ordres en attente')
    const quantity = integer(c.quantity)
    const side = c.side === 'buy' ? 1 : -1
    if (c.reduceOnly && (!this.quantity || Math.sign(this.quantity) === side)) throw new Error('Cette sortie ne réduit aucune position')
    const order = { id: `o${this.nextId++}`, kind: c.kind, side, quantity, remaining: quantity,
      price: c.kind === 'market' ? null : this.price(c.price), after: this.sequence,
      status: 'working', reduceOnly: !!c.reduceOnly, protective,
      stopTicks: c.stopTicks ? integer(c.stopTicks, 1, 100000) : null,
      targetTicks: c.targetTicks ? integer(c.targetTicks, 1, 100000) : null }
    this.orders.push(order)
    const quote = side > 0 ? this.market?.ask : this.market?.bid
    order.aggressiveUntil = order.kind === 'limit' && quote && (side > 0 ? BigInt(quote.price) <= order.price : BigInt(quote.price) >= order.price) ? this.sequence + 1 : null
    return order.id
  }
  advance(event) {
    const ts = BigInt(event.ts)
    if (ts < BigInt(this.clock)) throw new Error('Événement hors ordre : replay suspendu')
    this.clock = ts.toString(); this.sequence++
    this.market = event
    if (!event.valid || event.gap) { this.lastError = event.reason || 'Données de marché indisponibles'; return }
    this.lastError = null
    const liquidity = { 1: event.ask?.size || 0, '-1': event.bid?.size || 0 }
    // Working orders existed BEFORE this atomic market event. Protective orders created
    // by a fill cannot execute inside that same event, even at identical timestamps.
    for (const order of [...this.pending]) {
      if (!['working', 'triggered'].includes(order.status)) continue
      if (order.after >= this.sequence) continue
      if (order.reduceOnly && (!this.quantity || Math.sign(this.quantity) === order.side)) { order.status = 'cancelled'; continue }
      const quote = order.side > 0 ? event.ask : event.bid
      if (!quote || quote.price == null) continue
      const qPrice = BigInt(quote.price)
      if (order.kind === 'stop' && order.status === 'working') {
        if ((event.trades || []).some(t => order.side > 0 ? BigInt(t.price) >= order.price : BigInt(t.price) <= order.price)) {
          order.status = 'triggered'; order.after = this.sequence
          // Once a stop triggers, the target must not execute while waiting for a quote.
          if (order.protective) this.pending.filter(o => o.protective && o.id !== order.id).forEach(o => { o.status = 'cancelled' })
        }
        continue
      }
      if (order.kind === 'market' || order.status === 'triggered' || (order.kind === 'limit' && order.aggressiveUntil === this.sequence && (order.side > 0 ? qPrice <= order.price : qPrice >= order.price))) {
        let p = qPrice + BigInt(order.side * this.slippageTicks) * this.tick
        if (order.kind === 'limit') p = order.side > 0 ? (p > order.price ? order.price : p) : (p < order.price ? order.price : p)
        const q = Math.min(order.remaining, liquidity[order.side], order.reduceOnly ? Math.abs(this.quantity) : Infinity)
        if (q > 0) { liquidity[order.side] -= q; this.fill(order, q, p) }
      }
    }
    // Conservative passive fill: crossing transaction, not merely a touched quote.
    // Each observed contract can supply at most one simulated contract across orders.
    for (const trade of event.trades || []) {
      let volume = trade.size
      for (const order of [...this.pending]) {
        if (order.status !== 'working') continue
        if (volume <= 0) break
        if (order.kind !== 'limit' || order.after >= this.sequence) continue
        if (!(order.side > 0 ? BigInt(trade.price) < order.price : BigInt(trade.price) > order.price)) continue
        if (order.reduceOnly && (!this.quantity || Math.sign(this.quantity) === order.side)) { order.status = 'cancelled'; continue }
        const q = Math.min(volume, order.remaining, order.reduceOnly ? Math.abs(this.quantity) : Infinity)
        if (q > 0) { volume -= q; this.fill(order, q, order.price) }
      }
    }
    this.mark()
  }
  fill(order, quantity, price) {
    const fee = this.commission * BigInt(quantity)
    this.fees += fee
    const fill = { id: `f${this.nextId++}`, orderId: order.id, at: this.clock, sequence: this.sequence,
      side: order.side, quantity, price, fee, gross: 0n, net: 0n, closed: 0, opened: 0 }
    let remaining = quantity
    while (remaining && this.lots.length && this.lots[0].side !== order.side) {
      const lot = this.lots[0], n = Math.min(remaining, lot.quantity)
      const gross = rounded((price - lot.price) * BigInt(lot.side * n) * this.pointCents, SCALE)
      const net = gross - this.commission * BigInt(n * 2)
      this.gross += gross; this.realizedNet += net
      this.currentTrade.gross += gross; this.currentTrade.exitFees += this.commission * BigInt(n)
      fill.gross += gross; fill.net += net; fill.closed += n
      lot.quantity -= n; remaining -= n
      if (!lot.quantity) this.lots.shift()
      if (!this.lots.length) {
        const t = this.currentTrade
        this.trades.push({ ...t, exit: this.clock, net: t.gross - t.entryFees - t.exitFees,
          r: t.riskKnown && t.risk > 0n ? Number(t.gross - t.entryFees - t.exitFees) / Number(t.risk) : null })
        this.currentTrade = null
        this.pending.filter(o => o.protective).forEach(o => { o.status = 'cancelled' })
      }
    }
    if (remaining) {
      if (order.reduceOnly) throw new Error('Invariant : une sortie ne peut pas ouvrir une position')
      if (!this.currentTrade) this.currentTrade = { id: `t${this.nextId++}`, entry: this.clock, side: order.side, contracts: 0, gross: 0n, entryFees: 0n, exitFees: 0n, risk: 0n, riskKnown: true }
      this.currentTrade.contracts += remaining
      this.currentTrade.entryFees += this.commission * BigInt(remaining)
      if (order.stopTicks) this.currentTrade.risk += rounded(BigInt(order.stopTicks * remaining) * this.tick * this.pointCents, SCALE)
      else this.currentTrade.riskKnown = false
      this.lots.push({ quantity: remaining, side: order.side, price })
      fill.opened = remaining
      if (order.stopTicks || order.targetTicks) {
        this.pending.filter(o => o.protective).forEach(o => { o.status = 'cancelled' })
        const exitSide = order.side > 0 ? 'sell' : 'buy'
        if (order.stopTicks) this.place({ kind: 'stop', side: exitSide, quantity: Math.abs(this.quantity), reduceOnly: true,
          price: priceNumber(price - BigInt(order.side * order.stopTicks) * this.tick).toFixed(9) }, true)
        if (order.targetTicks) this.place({ kind: 'limit', side: exitSide, quantity: Math.abs(this.quantity), reduceOnly: true,
          price: priceNumber(price + BigInt(order.side * order.targetTicks) * this.tick).toFixed(9) }, true)
      }
    }
    order.remaining -= quantity
    if (!order.remaining) order.status = 'filled'
    this.pending.filter(o => o.protective).forEach(o => { o.quantity = o.remaining = Math.abs(this.quantity) })
    this.fills.push(fill)
  }
  valuation() {
    const mark = this.quantity > 0 ? this.market?.bid : this.market?.ask
    let unrealized = 0n
    if (this.quantity && (!this.market?.valid || !mark)) return { unrealized: null, equity: null }
    for (const l of this.lots) unrealized += rounded((BigInt(mark.price) - l.price) * BigInt(l.side * l.quantity) * this.pointCents, SCALE)
    const equity = this.capital + this.gross - this.fees + unrealized
    return { unrealized, equity }
  }
  mark() {
    const { equity } = this.valuation()
    if (equity === null) return
    if (equity > this.peakEquity) this.peakEquity = equity
    const dd = this.peakEquity - equity
    if (dd > this.maxDrawdown) this.maxDrawdown = dd
    if (this.peakEquity > 0n) this.maxDrawdownPct = Math.max(this.maxDrawdownPct, Number(dd) / Number(this.peakEquity) * 100)
    const time = Math.floor(Number(BigInt(this.clock) / 1_000_000_000n) / 60) * 60
    const point = { time, value: centsNumber(equity) }
    if (this.equity.at(-1)?.time === time) this.equity[this.equity.length - 1] = point
    else this.equity.push(point)
    if (this.equity.length > 5000) this.equity = this.equity.filter((_v, i) => i % 2 === 0 || i === this.equity.length - 1)
  }
  snapshot() {
    const { unrealized, equity } = this.valuation()
    const winners = this.trades.filter(t => t.net > 0n), losers = this.trades.filter(t => t.net < 0n)
    const sum = rows => rows.reduce((n, t) => n + t.net, 0n)
    const gains = sum(winners), losses = -sum(losers)
    const money = v => v === null ? null : centsNumber(v)
    const orderView = o => ({ ...o, price: o.price === null ? null : priceNumber(o.price) })
    const openFees = this.commission * BigInt(Math.abs(this.quantity))
    return { version: this.version, sequence: this.sequence, clock: this.clock, instrument: this.instrument, error: this.lastError,
      settings: { capital: money(this.capital), commission: money(this.commission), slippageTicks: this.slippageTicks },
      position: { quantity: this.quantity, averagePrice: this.quantity ? priceNumber(this.lots.reduce((p, l) => p + l.price * BigInt(l.quantity), 0n) / BigInt(Math.abs(this.quantity))) : null,
        unrealized: money(unrealized), unrealizedNet: unrealized === null ? null : money(unrealized - openFees) },
      orders: this.pending.map(orderView),
      fillsTotal: this.fills.length,
      fills: this.fills.slice(-500).map(f => ({ ...f, price: priceNumber(f.price), fee: money(f.fee), gross: money(f.gross), net: money(f.net) })),
      trades: this.trades.map(t => ({ ...t, gross: money(t.gross), entryFees: money(t.entryFees), exitFees: money(t.exitFees), net: money(t.net), risk: t.riskKnown ? money(t.risk) : null })),
      stats: { capital: money(this.capital), gross: money(this.gross), fees: money(this.fees), realizedNet: money(this.realizedNet),
        cash: money(this.capital + this.gross - this.fees), equity: money(equity), drawdown: money(this.maxDrawdown), drawdownPct: this.maxDrawdownPct,
        count: this.trades.length, winners: winners.length, losers: losers.length,
        winRate: this.trades.length ? winners.length / this.trades.length * 100 : null,
        profitFactor: losses ? Number(gains) / Number(losses) : gains ? 'infinity' : null,
        averageWin: winners.length ? money(gains) / winners.length : null, averageLoss: losers.length ? -money(losses) / losers.length : null,
        expectancy: this.trades.length ? money(sum(this.trades)) / this.trades.length : null },
      equity: this.equity,
    }
  }
  serialize() { return jsonState(this) }
  static restore(text) {
    const data = parseState(text)
    if (data.version !== ENGINE_VERSION) throw new Error('Version de session non prise en charge')
    return Object.assign(Object.create(ReplayEngine.prototype), data)
  }
}
