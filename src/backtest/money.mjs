export const SCALE = 1_000_000_000n
export function fixed(value, decimals = 9) {
  const s = String(value).trim()
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error('Nombre décimal invalide')
  const negative = s.startsWith('-')
  const [whole, fraction = ''] = s.replace(/^-/, '').split('.')
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new Error('Précision excessive')
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0'))) * (negative ? -1n : 1n)
}
export function rounded(n, d) { return (n < 0n ? -1n : 1n) * ((n < 0n ? -n : n) + d / 2n) / d }
export const priceNumber = p => Number(p) / 1e9
export const centsNumber = p => Number(p) / 100
export const jsonState = value => JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? { $int: v.toString() } : v)
export const parseState = value => JSON.parse(value, (_key, v) => v && typeof v === 'object' && Object.keys(v).length === 1 && typeof v.$int === 'string' ? BigInt(v.$int) : v)
export function integer(value, min = 1, max = 10000) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Nombre entier requis (${min}–${max})`)
  return n
}
