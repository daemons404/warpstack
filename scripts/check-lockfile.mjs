#!/usr/bin/env node
// Checks the packages a change adds to pnpm-lock.yaml (overview, Keeping long-term maintenance
// safe). `pnpm install --frozen-lockfile` installs what the lockfile says without applying
// `minimumReleaseAge`, so a PR could add a version published an hour ago. This fails when:
//
// - a package version new to the lockfile was published to npm less than 7 days ago;
// - any package resolves to something other than the npm registry with an integrity hash
//   (a git URL or a tarball from another host).
//
// Usage: node scripts/check-lockfile.mjs <base pnpm-lock.yaml> <head pnpm-lock.yaml>
// No dependencies: it reads the lockfile's `packages:` section line by line.
import { readFileSync } from 'node:fs'

const MIN_AGE_DAYS = 7
const REGISTRY = 'https://registry.npmjs.org'

/** `name@version` → its resolution line, from the lockfile's `packages:` section. */
const packagesOf = path => {
  const out = new Map()
  let inPackages = false
  let current = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (/^\S/.test(line)) { inPackages = line.startsWith('packages:'); current = null; continue }
    if (!inPackages) continue
    const key = /^ {2}'?([^'\s][^']*?)'?:\s*$/.exec(line)
    if (key) { current = key[1]; out.set(current, ''); continue }
    const res = /^ {4}resolution:\s*(.*)$/.exec(line)
    if (res && current) out.set(current, res[1])
  }
  return out
}

/** `@scope/name@1.2.3` → ['@scope/name', '1.2.3'] */
const split = key => {
  const at = key.lastIndexOf('@')
  return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, '']
}

const [basePath, headPath] = process.argv.slice(2)
if (!basePath || !headPath) {
  console.error('usage: check-lockfile.mjs <base lockfile> <head lockfile>')
  process.exit(2)
}

const base = packagesOf(basePath)
const head = packagesOf(headPath)
const problems = []

for (const [key, resolution] of head) {
  if (!/^\{integrity: sha512-[A-Za-z0-9+/=]+\}$/.test(resolution)) problems.push(`${key}: resolves to ${resolution || 'nothing'}, not the npm registry with an integrity hash`)
}

const added = [...head.keys()].filter(k => !base.has(k))
const cutoff = Date.now() - MIN_AGE_DAYS * 86_400_000
const times = new Map()
for (const key of added) {
  const [name, version] = split(key)
  if (!times.has(name)) {
    const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, { headers: { accept: 'application/json' } })
    times.set(name, res.ok ? (await res.json()).time ?? {} : null)
  }
  const published = times.get(name)?.[version]
  if (!published) problems.push(`${key}: no publish time on the npm registry`)
  else if (Date.parse(published) > cutoff) problems.push(`${key}: published ${published}, less than ${MIN_AGE_DAYS} days ago`)
}

console.log(`${added.length} package version(s) new to the lockfile, ${head.size} in all`)
if (problems.length) {
  console.error(problems.map(p => `  ✗ ${p}`).join('\n'))
  process.exit(1)
}
