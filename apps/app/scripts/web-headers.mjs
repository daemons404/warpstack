// Adds the media origin to the web app's Content-Security-Policy, after `expo export`.
// The policy allows images only from the page's own origin and the deployment's media origin,
// which differs per deployment, so it's filled in at build time from MEDIA_ORIGIN.
import { readFileSync, writeFileSync } from 'node:fs'

const file = new URL('../dist/_headers', import.meta.url)
const raw = process.env.MEDIA_ORIGIN?.trim()
if (!raw) {
  console.log('web-headers: MEDIA_ORIGIN unset; images stay off on the web')
  process.exit(0)
}
let origin
try {
  const u = new URL(raw)
  if (u.protocol !== 'https:' || u.origin !== raw) throw new Error()
  origin = u.origin
} catch {
  console.error(`web-headers: MEDIA_ORIGIN must be an https origin with no path, got ${JSON.stringify(raw)}`)
  process.exit(1)
}
const before = readFileSync(file, 'utf8')
const after = before.replace("img-src 'self' data:;", `img-src 'self' data: ${origin};`)
if (after === before) {
  console.error("web-headers: no `img-src 'self' data:;` in dist/_headers to extend")
  process.exit(1)
}
writeFileSync(file, after)
console.log(`web-headers: images allowed from ${origin}`)
