import { err, ok, type Result } from '@warpstack/protocol'

// Which URLs the server may fetch on someone else's say-so (sealed core; the restricted
// transport). Every URL is parsed with the WHATWG URL parser first, the same one
// fetch uses, which turns every IPv4 spelling (decimal 2130706433, octal 0177.0.0.1, hex
// 0x7f000001, short 127.1) into dotted form and brackets every IPv6 literal, so one check on
// the parsed host covers them all.
//
// A hostname that resolves to a private address can't be caught here: Workers can't pin DNS.
// That boundary is the Workers network itself, which doesn't route to private ranges (spike
// S1). These checks guard what that network can reach: our own services.

export type AddressPolicy = {
  /** Our own hostnames and their subdomains: the API, the media origin, the Snapchain nodes. */
  deny: readonly string[]
}

/** Never fetched: Cloudflare's shared Workers hosts, and names that only mean something inside a network. */
const ALWAYS_DENIED = ['workers.dev']
const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'arpa', 'lan', 'home', 'corp', 'intranet', 'invalid', 'test', 'example', 'onion']

const IPV4 = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/

const under = (host: string, name: string) => host === name || host.endsWith(`.${name}`)

/** The URL to fetch, or why it may not be fetched. */
export const checkUrl = (raw: string, policy: AddressPolicy): Result<URL, string> => {
  if (raw.length > 2_048) return err('URL too long')
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return err('not a URL')
  }
  if (u.protocol !== 'https:') return err('https only')
  if (u.port !== '' && u.port !== '443') return err('port 443 only')
  if (u.username || u.password) return err('credentials in the URL')
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') || host.includes(':')) return err('IP address')
  if (IPV4.test(host)) return err('IP address')
  if (!HOST.test(host)) return err('not a public hostname')
  // A last label of digits only is never a real TLD; the parser would have read it as IPv4.
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf('.') + 1))) return err('IP address')
  const tld = host.slice(host.lastIndexOf('.') + 1)
  if (INTERNAL_SUFFIXES.includes(tld)) return err('internal name')
  for (const d of [...ALWAYS_DENIED, ...policy.deny]) {
    const name = d.toLowerCase().replace(/\.$/, '')
    if (name && under(host, name)) return err('one of our own hosts')
  }
  u.hash = ''
  return ok(u)
}

/** The hostname of an origin or URL, for the deny list; null when there's none. */
export const hostOf = (urlOrOrigin: string | undefined): string | null => {
  if (!urlOrOrigin) return null
  try {
    return new URL(urlOrOrigin).hostname.toLowerCase()
  } catch {
    return null
  }
}
