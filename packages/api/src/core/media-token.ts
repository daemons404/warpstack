import type { Mac } from '../ports.ts'

// Media tokens (private deployments): `{expiresAt}.{mac}`, appended to avatar and proxied
// image URLs as `?t=`. A token names no one, so the media origin learns only that some allowed
// user asked. Expiry is aligned to whole days, so every user's token is the same for a day and
// image URLs stay cacheable on the device; a token lasts between one and two days.

const DAY = 86_400
const data = (expiresAt: number) => `ws-media-v1|${expiresAt}`

export const makeMediaToken = async (mac: Mac, now: number): Promise<{ token: string; expiresAt: number }> => {
  const expiresAt = (Math.floor(now / DAY) + 2) * DAY
  return { token: `${expiresAt}.${await mac.sign(data(expiresAt))}`, expiresAt }
}

export const mediaTokenValid = async (mac: Mac, token: string | null, now: number): Promise<boolean> => {
  const m = /^([0-9]{1,12})\.([A-Za-z0-9_-]{16,64})$/.exec(token ?? '')
  if (!m) return false
  const expiresAt = Number(m[1])
  if (expiresAt <= now || expiresAt > now + 2 * DAY) return false
  return mac.verify(data(expiresAt), m[2]!)
}
