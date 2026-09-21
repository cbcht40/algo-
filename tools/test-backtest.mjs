import test from 'node:test'
import assert from 'node:assert/strict'
import { ReplayEngine } from '../src/backtest/engine.mjs'
import { MboMarket } from '../src/backtest/market.mjs'
import { fixed, jsonState } from '../src/backtest/money.mjs'
import { instrumentSpec } from '../src/backtest/instruments.mjs'
const options = { instrument: instrumentSpec('ESM4'), capital: '50000', commission: '1.25', slippageTicks: 0, costsConfirmed: true }
const make = extra => new ReplayEngine({ ...options, ...extra })
let time = 1714568400000000000n, command = 0
const event = (bid, ask, price = null, size = 100, valid = true) => ({ ts: String(time += 1_000_000n), valid,
  bid: { price: String(fixed(bid)), size }, ask: { price: String(fixed(ask)), size },
  trades: price === null ? [] : [{ price: String(fixed(price)), size, side: 'buy' }] })
const place = (e, c) => e.command({ type: 'place', side: 'buy', kind: 'market', quantity: 1, ...c, commandId: `c${++command}` })
test('no fills at submission; long net, equity and fees reconcile', () => {
  const e = make(); e.advance(event(5000, 5000.25)); place(e, { quantity: 5 })
  assert.equal(e.fills.length, 0); e.advance(event(5000, 5000.25))
  assert.equal(e.quantity, 5); assert.equal(e.snapshot().stats.fees, 6.25)
  place(e, { side: 'sell', quantity: 2 }); e.advance(event(5001, 5001.25))
  assert.equal(e.snapshot().stats.realizedNet, 70); assert.equal(e.trades.length, 0)
  place(e, { side: 'sell', quantity: 3 }); e.advance(event(5002, 5002.25))
  assert.equal(e.snapshot().stats.realizedNet, 325); assert.equal(e.snapshot().stats.equity, 50325)
  assert.equal(e.snapshot().stats.fees, 12.5); assert.equal(e.trades.length, 1)
})
test('shorts, scaling in, partial closure and reversal keep a complete ledger', () => {
  const e = make(); e.advance(event(5000, 5000.25)); place(e, { side: 'sell', quantity: 2 }); e.advance(event(5000, 5000.25))
  place(e, { side: 'sell', quantity: 1 }); e.advance(event(5001, 5001.25))
  place(e, { side: 'buy', quantity: 4 }); e.advance(event(4998.75, 4999))
  assert.equal(e.quantity, 1); assert.equal(e.trades.length, 1)
  assert.equal(e.snapshot().trades[0].net, 192.5)
  assert.equal(e.snapshot().stats.cash, 50191.25)
  assert.equal(e.snapshot().position.averagePrice, 4999)
})
test('commission is charged once per fill and conserved for every partial partition', () => {
  for (let n = 1; n < 30; n++) {
    const e = make(); e.advance(event(5000, 5000.25)); place(e, { quantity: n }); e.advance(event(5000, 5000.25))
    for (let i = 0; i < n; i++) { place(e, { side: 'sell' }); e.advance(event(5001.25, 5001.5)) }
    assert.equal(e.snapshot().stats.realizedNet, n * 47.5)
    assert.equal(e.snapshot().stats.fees, n * 2.5)
    assert.equal(e.snapshot().stats.cash, e.snapshot().stats.equity)
  }
})
test('passive limits need a crossing trade and share the observed volume', () => {
  const e = make(); e.advance(event(5001, 5001.25))
  place(e, { kind: 'limit', quantity: 3, price: '5000' }); place(e, { kind: 'limit', quantity: 3, price: '5000' })
  e.advance(event(4999.50, 4999.75)); assert.equal(e.quantity, 0, 'A crossed quote alone cannot fill a resting order')
  e.advance(event(5001, 5001.25, 5000, 2)); assert.equal(e.quantity, 0)
  e.advance(event(5001, 5001.25, 4999.75, 2)); assert.equal(e.quantity, 2)
  assert.equal(e.pending.reduce((n, o) => n + o.remaining, 0), 4)
})
test('market limits never execute worse than their limit', () => {
  const e = make({ slippageTicks: 3 }); e.advance(event(5000, 5000.25)); place(e, { kind: 'limit', price: '5000.50' })
  e.advance(event(5000, 5000.25)); assert.equal(e.snapshot().fills[0].price, 5000.5)
})
test('stop trigger waits for the following quote, honors gaps, and cancels the target', () => {
  const e = make(); e.advance(event(5000, 5000.25)); place(e, { stopTicks: 4, targetTicks: 8 })
  e.advance(event(5000, 5000.25)); assert.equal(e.pending.length, 2)
  e.advance(event(4998.75, 4999, 4999)); assert.equal(e.quantity, 1)
  assert.equal(e.pending.length, 1)
  e.advance(event(4997, 4997.25)); assert.equal(e.quantity, 0)
  assert.equal(e.snapshot().trades[0].net, -165); assert.equal(e.pending.length, 0)
})
test('protective orders cannot execute in their creation event', () => {
  const e = make(); e.advance(event(5000, 5000.25)); place(e, { stopTicks: 1, targetTicks: 1 })
  e.advance(event(5000, 5000.25, 5001)); assert.equal(e.fills.length, 1)
})
test('reduce-only partial fills never reverse a position', () => {
  const e = make(); e.advance(event(5000, 5000.25)); place(e, { quantity: 3 }); e.advance(event(5000, 5000.25))
  place(e, { side: 'sell', quantity: 9, reduceOnly: true }); e.advance(event(5001, 5001.25, null, 2)); assert.equal(e.quantity, 1)
  e.advance(event(5001, 5001.25)); e.advance(event(5001, 5001.25)); assert.equal(e.quantity, 0); assert.equal(e.pending.length, 0)
})
test('a move to break-even after entry does not fabricate initial R', () => {
  const e = make(); e.advance(event(5000, 5000.25)); place(e, {}); e.advance(event(5000, 5000.25))
  place(e, { side: 'sell', kind: 'stop', price: '5000.25', reduceOnly: true }); e.advance(event(5000, 5000.25, 5000.25)); e.advance(event(5000.25, 5000.5))
  assert.equal(e.snapshot().trades[0].r, null)
})
test('serialization, idempotent commands, no future bars, and replay speed independent accounting', () => {
  const a = make(); a.advance(event(5000, 5000.25)); const c = { type: 'place', commandId: 'repeat', side: 'buy', kind: 'market', quantity: 1 }
  a.command(c); a.command(c); assert.equal(a.pending.length, 1)
  const b = ReplayEngine.restore(a.serialize())
  for (let i = 0; i < 20; i++) { const v = event(5000 + i / 4, 5000.25 + i / 4); a.advance(v); b.advance(v) }
  assert.equal(jsonState(a.snapshot()), jsonState(b.snapshot()))
})
test('invalid feed, unknown multiplier and fractional ticks fail closed', () => {
  assert.throws(() => make({ instrument: instrumentSpec('UNKNOWNZ6') }), /non vérifiées/)
  assert.throws(() => make({ costsConfirmed: false }), /Confirme/)
  const e = make(); e.advance(event(5000, 5000.25)); assert.throws(() => place(e, { kind: 'limit', price: '4999.91' }), /tick/)
  place(e, {}); e.advance(event(5000, 5000.25, null, 10, false)); assert.equal(e.fills.length, 0)
})
test('small FX ticks and negative futures prices retain precision', () => {
  const e = make({ instrument: instrumentSpec('6EZ6') }); e.advance(event('1.10000', '1.10005')); place(e, {}); e.advance(event('1.10000', '1.10005'))
  place(e, { side: 'sell' }); e.advance(event('1.10010', '1.10015')); assert.equal(e.snapshot().stats.realizedNet, 3.75)
  const cl = make({ instrument: instrumentSpec('CLM0') }); cl.advance(event('-10.01', '-10.00')); place(cl, {}); cl.advance(event('-10.01', '-10.00'))
  place(cl, { side: 'sell' }); cl.advance(event('-9.90', '-9.89')); assert.equal(cl.snapshot().stats.realizedNet, 97.5)
})
const r = (action, side, id, price, size, flags = 128) => ({ ts: String(time += 1000n), action, side, orderId: String(id), price: String(fixed(price)), size, flags })
test('MBO volume, cancels, resets, unknown aggressor and F_LAST follow the provider contract', () => {
  const m = new MboMarket()
  assert.equal(m.apply(r('R', 'N', 0, 0, 0, 0)), null)
  assert.equal(m.apply(r('A', 'B', 1, 5000, 5, 0)), null)
  assert.equal(m.apply(r('A', 'A', 2, 5000.25, 7)).valid, true)
  assert.equal(m.apply(r('T', 'N', 10, 5000.25, 2, 0)), null)
  assert.equal(m.apply(r('F', 'A', 2, 5000.25, 2)).trades.length, 1)
  assert.equal(m.best('A').size, 7)
  m.apply(r('C', 'A', 2, 5000.25, 2)); assert.equal(m.best('A').size, 5)
  const v = m.view(); assert.equal(v.bars[0].volume, 2); assert.equal(v.footprint[0].unknown, 2)
  m.apply(r('R', 'N', 0, 0, 0)); assert.equal(m.valid, false); assert.equal(m.view().asks.length, 0)
})
test('missing cancellations invalidate the book until a fresh reset', () => {
  const m = new MboMarket(); m.apply(r('R', 'N', 0, 0, 0)); m.apply(r('A', 'B', 1, 5000, 5)); m.apply(r('A', 'A', 2, 5000.25, 5))
  m.apply(r('C', 'A', 9, 5000.25, 1)); assert.equal(m.valid, false)
  m.apply(r('A', 'A', 3, 5001, 1)); assert.equal(m.valid, false)
})
