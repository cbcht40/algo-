// Stable reference for common outright contracts. Never infer financial specs from prices.
// Other instruments require a Databento definition with an explicit monetary tick value.
// https://www.cmegroup.com/markets/equities/sp/e-mini-sandp500.contractSpecs.html
// https://www.cmegroup.com/markets/equities/nasdaq/e-mini-nasdaq-100.contractSpecs.html
const CME = {
  ES: ['0.25', '50'], MES: ['0.25', '5'], NQ: ['0.25', '20'], MNQ: ['0.25', '2'],
  RTY: ['0.10', '50'], M2K: ['0.10', '5'], YM: ['1', '5'], MYM: ['1', '0.50'],
  CL: ['0.01', '1000'], MCL: ['0.01', '100'], GC: ['0.10', '100'], MGC: ['0.10', '10'],
  SI: ['0.005', '5000'], HG: ['0.0005', '25000'], NG: ['0.001', '10000'],
  '6E': ['0.00005', '125000'], '6B': ['0.0001', '62500'], '6J': ['0.0000005', '12500000'],
}
export function instrumentSpec(symbol, definitions = {}) {
  const root = String(symbol).replace(/[FGHJKMNQUVXZ]\d{1,4}$/, '')
  const isOutright = root !== symbol && !symbol.includes('-')
  const custom = definitions[symbol]
  if (custom && isOutright) return { ...custom, symbol, root, verified: true }
  const known = isOutright && CME[root]
  return { symbol, root, tickSize: known?.[0] || null, pointValue: known?.[1] || null,
    currency: known ? 'USD' : null, timezone: 'America/Chicago', verified: !!known,
    specificationSource: known ? 'CME · contrat outright' : null, kind: isOutright ? 'future' : 'spread' }
}
