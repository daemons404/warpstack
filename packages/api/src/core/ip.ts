// Rate-limit keys per caller. An IPv4 address is one caller. An
// IPv6 host is commonly given a whole /64 and can pick any address in it, so IPv6 callers
// are counted by their /64; otherwise rotating addresses would reset every limit.

const hextets = (ip: string): string[] | null => {
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) is two hextets; only the first four matter here.
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0 || (halves.length === 1 && head.length !== 8 && !head.at(-1)?.includes('.'))) return null
  const all = [...head, ...Array<string>(fill).fill('0'), ...tail]
  return all.every(h => /^[0-9a-f]{1,4}$/.test(h) || h.includes('.')) ? all : null
}

/** The key a caller is counted under: the address for IPv4, its /64 for IPv6. */
export const callerKey = (ip: string): string => {
  const a = ip.trim().toLowerCase().replace(/%.*$/, '')
  if (!a.includes(':')) return a
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a)
  if (mapped) return mapped[1]!
  const h = hextets(a)
  if (!h) return a
  return `${h.slice(0, 4).map(x => parseInt(x, 16).toString(16)).join(':')}::/64`
}
