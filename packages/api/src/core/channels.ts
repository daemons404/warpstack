// A channel's casts carry its parent URL. The registry names one URL per channel, but
// clients have posted under both the old and the current host, so a channel feed reads all
// of them; with no registry entry at all, the feed still works from the key alone.
const HOSTS = ['https://farcaster.xyz/~/channel/', 'https://warpcast.com/~/channel/']

export const channelUrls = (key: string, registryUrl?: string | null): string[] =>
  [...new Set([...(registryUrl ? [registryUrl] : []), ...HOSTS.map(h => h + key)])]

/** The key in a channel URL on either host, so a cast under the other host still names its channel. */
export const channelKeyOfUrl = (url: string): string | undefined => {
  for (const h of HOSTS) if (url.startsWith(h)) return url.slice(h.length)
  return undefined
}
