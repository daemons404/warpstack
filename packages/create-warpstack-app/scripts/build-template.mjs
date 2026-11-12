// Builds the generator's template from apps/app, so the app in this repo stays the one source.
// It copies an allowlist of the app's files and makes them standalone: paths into the monorepo
// point into node_modules instead, `workspace:` and `catalog:` become real versions, and the
// local database ID becomes the placeholder. Then it checks nothing of the monorepo is left and
// fails if anything is.
//
//   node scripts/build-template.mjs [out]      default: ./template, next to this script's folder
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const app = join(root, 'apps/app')
const out = resolve(process.argv[2] ?? fileURLToPath(new URL('../template', import.meta.url)))

const fail = m => {
  console.error(`build-template: ${m}`)
  process.exit(1)
}
const read = p => readFileSync(p, 'utf8')
/** Replaces `from` with `to`, and fails unless `from` occurs exactly `count` times. */
const swap = (text, from, to, file, count = 1) => {
  const n = text.split(from).length - 1
  if (n !== count) fail(`${file}: expected ${count} of ${JSON.stringify(from)}, found ${n}. Update this script.`)
  return text.split(from).join(to)
}

// What a generated app is made of. Everything else in apps/app (local secrets, build output,
// the native project, Wrangler's state) stays behind.
const COPY = ['app', 'assets', 'src', 'scripts', 'public', 'app.json', 'package.json', 'tsconfig.json', 'tsconfig.worker.json',
  'wrangler.jsonc', 'wrangler.media.jsonc', '.dev.vars.example', 'SETUP.md', 'AGENTS.md']

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const f of COPY) {
  if (!existsSync(join(app, f))) fail(`apps/app/${f} is missing`)
  cpSync(join(app, f), join(out, f), { recursive: true })
}

// Versions: each @warpstack package's own, and for everything else the exact version this
// repo's lockfile tested. A newer Expo patch has crashed the app at launch before, so a
// generated app gets what the repo runs, not the newest match.
const locked = {}
let importer = null
let pkgName = null
for (const line of read(join(root, 'pnpm-lock.yaml')).split('\n')) {
  if (/^\S/.test(line)) importer = line.startsWith('importers:') ? '' : null
  if (importer === null) continue
  let m
  if ((m = /^ {2}(\S[^:]*):\s*$/.exec(line))) importer = m[1]
  else if ((m = /^ {6}'?([^':]+)'?:\s*$/.exec(line))) pkgName = m[1]
  else if ((m = /^ {8}version: (\S+)/.exec(line)) && pkgName) (locked[importer] ??= {})[pkgName] = m[1].replace(/\(.*$/, '')
}
const lockedVersion = (from, name) => {
  const v = locked[from]?.[name]
  if (!v || !/^\d/.test(v)) fail(`pnpm-lock.yaml has no version of ${name} for ${from || 'the root'}. Run pnpm install.`)
  return v
}
const warpstack = {}
for (const dir of readdirSync(join(root, 'packages'))) {
  const file = join(root, 'packages', dir, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(read(file))
  if (pkg.name?.startsWith('@warpstack/')) warpstack[pkg.name] = pkg.version
}

const pkg = JSON.parse(read(join(out, 'package.json')))
pkg.name = 'warpstack-app'
pkg.version = '0.1.0'
delete pkg.license
pkg.engines = { node: '>=22' }
for (const field of ['dependencies', 'devDependencies']) {
  for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
    if (spec.startsWith('workspace:')) {
      if (!warpstack[name]) fail(`package.json: ${name} isn't a package in this repo`)
      pkg[field][name] = warpstack[name]
    } else {
      pkg[field][name] = lockedVersion('apps/app', name)
    }
  }
}
// TypeScript comes from the repo's root; the app needs its own.
pkg.devDependencies.typescript = lockedVersion('.', 'typescript')
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

// TypeScript: the shared base config travels with the app.
cpSync(join(root, 'tsconfig.base.json'), join(out, 'tsconfig.base.json'))
for (const f of ['tsconfig.json', 'tsconfig.worker.json']) {
  writeFileSync(join(out, f), swap(read(join(out, f)), '"../../tsconfig.base.json"', '"./tsconfig.base.json"', f))
}

// Wrangler: the schema and the migrations come from installed packages, and the database ID is
// the placeholder `pnpm run deploy` fills in, whatever this checkout holds.
for (const f of ['wrangler.jsonc', 'wrangler.media.jsonc']) {
  let text = swap(read(join(out, f)), '"../../node_modules/wrangler/config-schema.json"', '"node_modules/wrangler/config-schema.json"', f)
  if (f === 'wrangler.jsonc') {
    text = swap(text, '"../../packages/api/migrations"', '"node_modules/@warpstack/api/migrations"', f)
    text = text.replace(/"database_id":\s*"[^"]*"/, '"database_id": "00000000-0000-0000-0000-000000000000"')
  }
  writeFileSync(join(out, f), text)
}

// Metro: a standalone project needs only Expo's defaults.
writeFileSync(join(out, 'metro.config.js'), `// Expo's Metro config.
const { getDefaultConfig } = require('expo/metro-config')

module.exports = getDefaultConfig(__dirname)
`)

// pnpm settings the repo has at its root: the 7-day release age, and install scripts only for
// the two packages that need them.
writeFileSync(join(out, 'pnpm-workspace.yaml'), `# Supply chain: a new dependency is installed only once it is 7 days old, and only these
# packages may run install scripts.
minimumReleaseAge: 10080
# Dependencies of dependencies resolve to what was published by the time the pinned versions
# were, so Expo's own packages match the SDK the app pins rather than its newest patches.
resolutionMode: time-based
minimumReleaseAgeExclude:
  - "@warpstack/*"
  # Pinned below to one exact version, already older than 7 days. Time-based resolution would
  # otherwise measure its age from when the pinned Expo was published and refuse it.
  - node-forge
  - undici
onlyBuiltDependencies:
  - esbuild
  - workerd
# Fixes inside Expo's build tools, within the ranges they accept (as in Warpstack's own repo).
overrides:
  node-forge: 1.4.2
  undici: 7.30.1
`)

// npm drops a package's .gitignore, so it travels as \`gitignore\` and the generator renames it.
writeFileSync(join(out, 'gitignore'), `node_modules/
dist/
.expo/
ios/
android/
*.tsbuildinfo

# Local secrets: never commit these.
.dev.vars
.env
.env.*
!.env.example

# Wrangler's local state and generated configs.
.wrangler/
wrangler.offline.jsonc
wrangler.deploy.jsonc
`)

writeFileSync(join(out, 'AGENTS.md'), `${read(join(out, 'AGENTS.md')).trimEnd()}

## Ask the person, don't decide

These choices belong to the person you're working for. Ask them; never pick a default:

- the app's name and iOS bundle ID (\`app.json\`);
- who may use the server: the FIDs in \`ALLOWED_FIDS\` or \`--fid\`, or \`ACCESS=public\` (only when
  they ask for it);
- anything that costs money, or needs their accounts: Cloudflare, Apple, npm.

Never ask for, read or handle a recovery phrase: it's typed only into the phone app's own screen.
Never open, print or copy \`.env.deploy\` (their Cloudflare token). You may write \`.dev.vars\`
with keys you generate, but never print its contents. Setting up from scratch:
https://github.com/daemons404/warpstack/blob/main/docs/setup-with-an-agent.md

## This project

This app was made with \`create-warpstack-app\`. The building blocks are npm packages
(\`@warpstack/*\`); this project holds only the app's routes, its Worker entry point and its
configuration.

- Change screens by editing or replacing the route files in \`app/\`. Never edit
  \`node_modules\`: update a package, or replace the screen.
- \`@warpstack/protocol\` and \`@warpstack/wallet\` are the sealed core: they sign for the user.
  Use them through their public APIs only.
- \`pnpm typecheck\` checks the app and the Worker. \`.dev.vars\` and \`.env.deploy\` hold secrets:
  never commit them.
- Setting up a server: SETUP.md. Building the iPhone app needs Xcode and Rust:
  \`pnpm run ios:release\` builds the vault from source, then the app.
`)

writeFileSync(join(out, 'README.md'), `# Your Warpstack app

A Farcaster client for iPhone and the web, and its own server on Cloudflare, built from
[Warpstack](https://github.com/daemons404/warpstack)'s building blocks. Your keys stay on your
phone; Snapchain is the database.

## Run it here

\`\`\`sh
cp .dev.vars.example .dev.vars
\`\`\`

Fill in \`.dev.vars\` (\`openssl rand -hex 32\` makes a key), then run \`pnpm dev\`: the server
and web app on localhost, with no Cloudflare account.

## Your own server

[SETUP.md](SETUP.md): about ten minutes in a browser, then \`pnpm run deploy --fid <your FID>\`.

## The iPhone app

Needs Xcode and Rust. The first build compiles the vault from source, which takes a few
minutes. Set \`CARGO_TARGET_DIR\` to a folder outside \`node_modules\` to keep later builds fast.

\`\`\`sh
EXPO_PUBLIC_API_URL=https://<your server> pnpm run ios:release
\`\`\`
`)

// Nothing of the monorepo may be left.
const walk = dir => readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
for (const file of walk(out)) {
  const rel = file.slice(out.length + 1)
  if (/(^|\/)(\.dev\.vars|\.env\.deploy|\.env)$/.test(rel)) fail(`${rel} must never be in the template`)
  const text = read(file)
  for (const bad of ['../../', 'workspace:', 'catalog:', 'apps/app', '--filter']) {
    if (text.includes(bad)) fail(`${rel} still has ${JSON.stringify(bad)}`)
  }
}
const ids = [...read(join(out, 'wrangler.jsonc')).matchAll(/"database_id":\s*"([^"]*)"/g)].map(m => m[1])
if (ids.length !== 1 || ids[0] !== '00000000-0000-0000-0000-000000000000') fail('wrangler.jsonc must hold only the placeholder database ID')

console.log(`build-template: wrote ${out}`)
