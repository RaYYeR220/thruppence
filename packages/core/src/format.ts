import type { Nano } from './types'

const NANO = 1_000_000_000n

export function toBig(n: Nano | bigint): bigint {
  return typeof n === 'bigint' ? n : BigInt(n)
}

function groupThousands(int: bigint): string {
  return int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Human amount in GRAM. Two decimals at most (rounded down) unless the
 * amount is below 0.01, in which case the significant digits are kept.
 * 25e9 → "25", 5e8 → "0.5", 1_250_750_000_000 → "1,250.75".
 */
export function formatGram(nano: Nano | bigint): string {
  const v = toBig(nano)
  const neg = v < 0n
  const abs = neg ? -v : v
  const int = abs / NANO
  const frac = abs % NANO
  let fracStr = frac.toString().padStart(9, '0')
  if (int === 0n && frac > 0n && frac < 10_000_000n) {
    fracStr = fracStr.replace(/0+$/, '')
  } else {
    fracStr = fracStr.slice(0, 2).replace(/0+$/, '')
  }
  const s = groupThousands(int) + (fracStr ? '.' + fracStr : '')
  return neg ? '-' + s : s
}

/** "25", "0.5", "1,250.75", "12,5" → nano string. Returns null for anything that is not a positive number. */
export function parseGram(text: string): Nano | null {
  const t = text.trim().replace(/,(?=\d{3}(\D|$))/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,9})?$/.test(t)) return null
  const [i, f = ''] = t.split('.')
  const v = BigInt(i) * NANO + BigInt(f.padEnd(9, '0'))
  return v > 0n ? v.toString() : null
}

/** "UQAb…f3a2" */
export function shortAddr(addr: string, head = 4, tail = 4): string {
  if (addr.length <= head + tail + 1) return addr
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`
}

export function seconds(ms: number): string {
  return (ms / 1000).toFixed(1) + ' s'
}
