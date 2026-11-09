#!/usr/bin/env node
// create-warpstack-app: a new Warpstack app, with its server, in a folder of its own.
//
//   pnpm create warpstack-app my-app
//   pnpm create warpstack-app my-app --name "My App" --bundle-id com.example.myapp --yes
//
// It asks for what's missing when a person runs it in a terminal. Without a terminal (an agent
// running it), it never guesses: it stops and lists the questions to ask the person, unless
// --yes says the defaults are fine. Its output is plain lines, ending in what to run next.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import { checkBundleId, checkName, checkSlug, generate, slugify, tarballPackage } from './generate.ts'

const HELP = `Usage: create-warpstack-app [folder] [options]

Creates a Warpstack app: a Farcaster client for iPhone and the web, and its own server.

Options:
  --name <name>          The app's name, as on the home screen (default: from the folder)
  --bundle-id <id>       The iOS bundle ID, like com.example.myapp
  --yes                  Use the defaults for anything not given (without a terminal,
                         the generator otherwise stops and lists what to ask)
  --no-install           Don't run pnpm install
  --tarballs <folder>    Install @warpstack packages from packed tarballs (for testing)
  --help                 Show this
`

const args = process.argv.slice(2)
const flag = (n: string) => args.includes(`--${n}`)
const option = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`)
  return i === -1 ? undefined : args[i + 1]
}
const valued = new Set(['--name', '--bundle-id', '--tarballs'])
const positional = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1] ?? ''))

const stop = (m: string): never => {
  console.error(`✘ ${m}`)
  process.exit(1)
}

if (flag('help')) {
  console.log(HELP)
  process.exit(0)
}
const known = new Set(['--name', '--bundle-id', '--yes', '--no-install', '--tarballs', '--help'])
const unknown = args.find(a => a.startsWith('--') && !known.has(a))
if (unknown) stop(`Unknown option ${unknown}.\n\n${HELP}`)

const interactive = process.stdin.isTTY && process.stdout.isTTY && !flag('yes')

// An agent runs this without a terminal. Rather than naming someone's app with defaults, stop
// and say what to ask them.
if (!interactive && !flag('yes')) {
  const missing = [
    positional[0] === undefined && '  - What folder should the app go in? (the first argument)',
    option('name') === undefined && '  - What should the app be called? It\'s the name on the home screen. (--name "My App")',
    option('bundle-id') === undefined && '  - What iOS bundle ID? Like com.yourname.myapp. (--bundle-id com.yourname.myapp)',
  ].filter(Boolean)
  if (missing.length > 0) {
    stop(`Some choices are missing, and they belong to the person you're setting this up for. Ask them:

${missing.join('\n')}

Then run it again with the answers, for example:
  pnpm create warpstack-app my-app --name "My App" --bundle-id com.yourname.myapp

Setting it up end to end: https://github.com/daemons404/warpstack/blob/main/docs/setup-with-an-agent.md
(Or pass --yes to use the defaults.)`)
  }
}
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null
/** Asks until `check` passes; without a terminal, takes the default or stops with the problem. */
const ask = async (question: string, fallback: string, check: (v: string) => string | null): Promise<string> => {
  if (!rl) {
    const problem = check(fallback)
    return problem ? stop(problem) : fallback
  }
  for (;;) {
    const answer = (await rl.question(`${question} (${fallback}): `)).trim() || fallback
    const problem = check(answer)
    if (!problem) return answer
    console.log(`  ${problem}`)
  }
}
const given = (value: string | undefined, check: (v: string) => string | null): string | undefined => {
  if (value === undefined) return undefined
  const problem = check(value)
  return problem ? stop(problem) : value
}

const folder = positional[0] ?? await ask('Folder for the app', 'my-warpstack', v => checkSlug(slugify(basename(v))))
const dir = resolve(folder)
const slug = slugify(basename(dir))
const slugProblem = checkSlug(slug)
if (slugProblem) stop(`${folder}: ${slugProblem}`)
const title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
const name = given(option('name'), checkName) ?? await ask('App name', title, checkName)
const bundleId = given(option('bundle-id'), checkBundleId) ?? await ask('iOS bundle ID', `com.example.${slug.replace(/-/g, '')}`, checkBundleId)
rl?.close()

let tarballs: Record<string, string> | undefined
const tarballDir = option('tarballs')
if (tarballDir) {
  const abs = resolve(tarballDir)
  tarballs = {}
  for (const f of readdirSync(abs)) {
    const pkg = tarballPackage(f)
    if (pkg) tarballs[pkg] = join(abs, f)
  }
  if (Object.keys(tarballs).length === 0) stop(`No @warpstack tarballs in ${abs}.`)
}

const template = fileURLToPath(new URL('../template', import.meta.url))
const made = generate({ template, dir, name, slug, bundleId, ...(tarballs ? { tarballs } : {}) })
if (!made.ok) stop(made.error)
const near = relative(process.cwd(), dir)
const shown = near === '' ? '.' : near.startsWith('..') ? dir : near
console.log(`✔ Created ${name} in ${shown}`)

let installed = false
if (!flag('no-install')) {
  console.log('▸ Installing with pnpm')
  const r = spawnSync('pnpm', ['install'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  installed = r.status === 0
  if (r.error) console.log('  pnpm isn\'t installed. Install it (`npm install -g pnpm`, or `corepack enable pnpm`), then run `pnpm install` in the app\'s folder.')
  else if (!installed) console.log('  pnpm install failed; the lines above say why. Run it again in the app\'s folder.')
}

console.log(`
Next:
  cd ${shown}${installed ? '' : '\n  pnpm install'}
  cp .dev.vars.example .dev.vars     then fill it in (openssl rand -hex 32 makes a key)
  pnpm dev                           your server and web app on localhost, no Cloudflare account

Your own server: SETUP.md (about ten minutes, then pnpm run deploy --fid <your FID>)
iPhone: needs Xcode and Rust; EXPO_PUBLIC_API_URL=<your server> pnpm run ios:release
Agents: read AGENTS.md first.`)
