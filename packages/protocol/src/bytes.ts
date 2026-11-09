// Hex and byte helpers. Hex is always lowercase with a 0x prefix, as Snapchain's HTTP API
// returns it and as branded hashes are stored.

export const toHex = (b: Uint8Array): `0x${string}` => {
  let s = '0x'
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s as `0x${string}`
}

/** Bytes from 0x-prefixed hex of exactly `length` bytes when given; `null` for anything else. */
export const fromHex = (s: unknown, length?: number): Uint8Array | null => {
  if (typeof s !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(s)) return null
  const n = (s.length - 2) / 2
  if (length !== undefined && n !== length) return null
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = parseInt(s.slice(2 + i * 2, 4 + i * 2), 16)
  return out
}

export const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export const toBase64Url = (b: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    const chars = [n >> 18, (n >> 12) & 63, (n >> 6) & 63, n & 63].map(c => B64URL[c])
    out += chars.slice(0, b.length - i >= 3 ? 4 : b.length - i + 1).join('')
  }
  return out
}

/** Unpadded base64url only; `null` for anything else. */
export const fromBase64Url = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null
  const out: number[] = []
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4)
    const n = [...chunk].reduce((acc, ch, j) => acc | (B64URL.indexOf(ch) << (18 - 6 * j)), 0)
    out.push((n >> 16) & 255)
    if (chunk.length > 2) out.push((n >> 8) & 255)
    if (chunk.length > 3) out.push(n & 255)
  }
  return Uint8Array.from(out)
}
