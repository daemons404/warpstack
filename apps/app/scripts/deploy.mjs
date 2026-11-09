// `pnpm run deploy`: puts this Warpstack on your own Cloudflare account, or updates it.
// Safe to run again: it creates only what's missing, never rotates a key that exists, and
// prints each step. Written to be run by a person or an agent (see SETUP.md).
//
//   pnpm run deploy --fid 1234           first deploy: who may use it (your FID)
//   pnpm run deploy                      later: update code, keep everything else
//   pnpm run deploy --no-media           without images, even if R2 is on
//
// Images are optional: when R2 isn't enabled on the account, the deploy goes ahead without
// them (avatars are initials, images are links) and says how to add them later.
//   pnpm run deploy --public             anyone may read and sign in (an open client)
//   pnpm run deploy --private            back to private: only the listed FIDs
//
// Needs .env.deploy, next to this app's package.json, with CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createInterface } from 'node:readline/promises'

const APP = new URL('..', import.meta.url).pathname
/** The config the deploy runs: wrangler.jsonc plus this account's database ID. Git ignores it. */
const DEPLOY_CONFIG = 'wrangler.deploy.jsonc'
/** A path in this app as the person can type it from where they ran the command. */
const here = p => relative(process.env.INIT_CWD ?? process.cwd(), join(APP, p)) || '.'
const say = m => console.log(m)
const step = m => console.log(`\n▸ ${m}`)
/** Stops the deploy with a message; the temporary secrets folder is still removed. */
class Stop extends Error {}
const fail = m => {
  throw new Stop(m)
}

// Arguments

const args = process.argv.slice(2)
const flag = name => args.includes(`--${name}`)
const option = name => {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return undefined
  return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1]
}
let media = !flag('no-media')
const open = flag('public')
const close = flag('private')
let fids = option('fid')
const backfillHours = option('backfill-hours') ?? '2'
const early = m => {
  console.error(`\n✘ ${m}`)
  process.exit(1)
}
if (fids !== undefined && !/^[0-9]{1,12}(,[0-9]{1,12})*$/.test(fids.replace(/\s/g, ''))) early('--fid takes FIDs separated by commas, e.g. --fid 1234 or --fid 1234,42')
fids = fids?.replace(/\s/g, '')
if (open && close) early('--public and --private: pick one')

// Credentials: from .env.deploy, never printed.

const envFile = join(APP, '.env.deploy')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
if (!TOKEN || !ACCOUNT) {
  early(`Put your Cloudflare API token and account ID in ${here('.env.deploy')}:

    CLOUDFLARE_API_TOKEN=...
    CLOUDFLARE_ACCOUNT_ID=...

  SETUP.md says how to make the token and where the account ID is.`)
}

const cf = async (path, init = {}) => {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}${path}`, {
    ...init, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok && body.success !== false, body }
}

const wrangler = (argv, opts = {}) => {
  const r = spawnSync('pnpm', ['exec', 'wrangler', ...argv], { cwd: APP, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !opts.allowFail) {
    const out = `${r.stdout}\n${r.stderr}`.split('\n').filter(l => l.trim()).slice(-12).join('\n')
    fail(`wrangler ${argv.slice(0, 3).join(' ')} failed:\n${out}`)
  }
  return r
}
const wranglerJson = (argv, opts) => {
  const r = wrangler(argv, opts)
  if (r.status !== 0) return null
  try {
    return JSON.parse(r.stdout.slice(r.stdout.search(/[[{]/)))
  } catch {
    return null
  }
}

/** JSON with comments, as wrangler reads it: comments are dropped outside strings. */
const readJsonc = file => {
  const src = readFileSync(join(APP, file), 'utf8')
  let out = ''
  for (let i = 0, str = false; i < src.length; i++) {
    const c = src[i]
    if (str) {
      out += c
      if (c === '\\') out += src[++i]
      else if (c === '"') str = false
    } else if (c === '"') {
      str = true
      out += c
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1
    } else {
      out += c
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * The names of a Worker's secrets, or an empty set if the Worker doesn't exist yet. Any other
 * failure stops the deploy: treating an unreadable list as empty would make new keys, which
 * signs everyone out and breaks every image link.
 */
const secretsOf = async script => {
  const r = await cf(`/workers/scripts/${script}/secrets`).catch(e => ({ status: 0, ok: false, body: { errors: [{ message: String(e) }] } }))
  if (r.ok && Array.isArray(r.body.result)) return new Set(r.body.result.map(s => s.name))
  if (r.status === 404) return new Set()
  fail(`Couldn't read the secrets of ${script}, so nothing was changed (${JSON.stringify(r.body.errors ?? r.body).slice(0, 200)}). Run this again in a minute.`)
}
const deleteSecret = async (script, name) => {
  const r = await cf(`/workers/scripts/${script}/secrets/${name}`, { method: 'DELETE' }).catch(() => ({ ok: false }))
  return r.ok
}
const hex32 = () => randomBytes(32).toString('hex')

const tmp = mkdtempSync(join(tmpdir(), 'warpstack-deploy-'))
const secretsFile = (name, values) => {
  const file = join(tmp, `${name}.env`)
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
  return file
}

const ask = async question => {
  if (!process.stdin.isTTY) return null
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

try {
  // 1. The token and the account's workers.dev subdomain.
  step('Checking your Cloudflare token')
  const sub = await cf('/workers/subdomain')
  if (sub.status === 401 || sub.status === 403) fail('Cloudflare refused the token. Check CLOUDFLARE_API_TOKEN and that it includes "Workers Scripts: Edit" for this account (SETUP.md, step 6).')
  if (!sub.ok || !sub.body.result?.subdomain) fail(`Couldn't read your workers.dev subdomain: ${JSON.stringify(sub.body.errors ?? sub.body).slice(0, 300)}`)
  const subdomain = sub.body.result.subdomain
  const apiConfig = readJsonc('wrangler.jsonc')
  const mediaConfig = readJsonc('wrangler.media.jsonc')
  const apiOrigin = `https://${apiConfig.name}.${subdomain}.workers.dev`
  const mediaOrigin = `https://${mediaConfig.name}.${subdomain}.workers.dev`
  say(`  Your app will be at ${apiOrigin}`)
  if (media) say(`  Images at ${mediaOrigin}`)
  say('  These names are public. To change the subdomain: dash.cloudflare.com → Workers & Pages → Account details → Subdomain.')

  // 2. Who may use it.
  const apiSecrets = await secretsOf(apiConfig.name)
  const mediaSecrets = await secretsOf(mediaConfig.name)
  const firstDeploy = !apiSecrets.has('CURSOR_MAC_KEY')
  const decided = apiSecrets.has('ALLOWED_FIDS') || apiSecrets.has('APP_FID') || apiSecrets.has('ACCESS')
  if (close && !fids && !apiSecrets.has('ALLOWED_FIDS') && !apiSecrets.has('APP_FID')) {
    fail('Going private needs the FIDs who may use it: run again with --private --fid <your FID>.')
  }
  if (!open && !fids && !decided) {
    step('Who may use this deployment?')
    say('  It is private: only the Farcaster accounts you list can sign in and read.')
    const answer = await ask('  Your FID (more than one: separate with commas): ')
    if (!answer || !/^[0-9]{1,12}(,[0-9]{1,12})*$/.test(answer.replace(/\s/g, ''))) {
      fail('Run again with --fid <your FID> (or --public for an open client). To look up the FID for a username: curl -s "https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=<username>"')
    }
    fids = answer.replace(/\s/g, '')
  }

  // The web app is built before anything on the account changes, so a failed build leaves the
  // deployment as it was.
  step('Building the app')
  const exp = spawnSync('pnpm', ['exec', 'expo', 'export', '-p', 'web', '--output-dir', 'dist'], { cwd: APP, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (exp.status !== 0) fail(`expo export failed:\n${exp.stderr.split('\n').slice(-12).join('\n')}`)
  say('  Built')

  // 3. The database.
  step('Database (D1)')
  const dbName = apiConfig.d1_databases[0].database_name
  let db = (wranglerJson(['d1', 'list', '--json']) ?? []).find(d => d.name === dbName)
  if (!db) {
    wrangler(['d1', 'create', dbName])
    db = (wranglerJson(['d1', 'list', '--json']) ?? []).find(d => d.name === dbName)
    if (!db) fail(`Created ${dbName} but can't find it in the list`)
    say(`  Created ${dbName}`)
  } else {
    say(`  Using ${dbName}`)
  }
  // The account's IDs go into a generated config that git ignores, never into wrangler.jsonc.
  const deployConfig = { ...apiConfig, d1_databases: [{ ...apiConfig.d1_databases[0], database_id: db.uuid }] }
  const writeDeployConfig = () => writeFileSync(join(APP, DEPLOY_CONFIG),
    `// Generated by scripts/deploy.mjs from wrangler.jsonc and your account; edit wrangler.jsonc instead.\n${JSON.stringify(deployConfig, null, 2)}\n`)
  writeDeployConfig()
  wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', DEPLOY_CONFIG])
  say('  Migrations applied')

  // 4. Images: the bucket and the media Worker.
  let mediaKey = null
  if (media) {
    step('Images (R2 and the media Worker)')
    const bucket = mediaConfig.r2_buckets[0].bucket_name
    // A network error or a 5xx is retried; it never turns images off by itself.
    let got
    for (let i = 0; i < 3; i++) {
      got = await cf(`/r2/buckets/${bucket}`).catch(e => ({ status: 0, ok: false, body: { errors: [{ message: String(e) }] } }))
      if (got.status !== 0 && got.status < 500) break
      await new Promise(r => setTimeout(r, 2_000 * (i + 1)))
    }
    const code = got.body.errors?.[0]?.code
    const hadImages = apiSecrets.has('MEDIA_ORIGIN')
    const off = why => {
      // A deployment that has images keeps them: only --no-media turns them off.
      if (hadImages) fail(`Images are on for this deployment, but ${why} Nothing was changed. Fix that and run again, or run with --no-media to turn images off.`)
      say(`  Images are off: ${why}`)
      say('  Avatars show initials and images show as links. To add images later: turn on R2 in the')
      say('  dashboard (Storage & databases → R2) and run this again.')
      media = false
    }
    if (code === 10042) {
      off("R2 isn't enabled on this Cloudflare account.")
    } else if (got.status === 404 || code === 10006) {
      const made = await cf('/r2/buckets', { method: 'POST', body: JSON.stringify({ name: bucket }) })
      if (made.ok) say(`  Created bucket ${bucket}`)
      else off(`couldn't create the R2 bucket (${JSON.stringify(made.body.errors).slice(0, 200)}).`)
    } else if (got.status === 0 || got.status >= 500) {
      off(`Cloudflare didn't answer about the R2 bucket (${JSON.stringify(got.body.errors).slice(0, 200)}).`)
    } else if (!got.ok) {
      off(`couldn't read the R2 bucket (${JSON.stringify(got.body.errors).slice(0, 200)}); the token needs "Workers R2 Storage: Edit".`)
    } else {
      say(`  Using bucket ${bucket}`)
    }
  }
  if (media) {
    // The key is shared by both Workers and can't be read back, so it's made only when one lacks it.
    const mediaValues = {}
    if (!open && !(apiSecrets.has('MEDIA_KEY') && mediaSecrets.has('MEDIA_KEY'))) {
      mediaKey = hex32()
      mediaValues.MEDIA_KEY = mediaKey
    }
    if (open) mediaValues.ACCESS = 'public'
    if (close && mediaSecrets.has('ACCESS') && !(await deleteSecret(mediaConfig.name, 'ACCESS'))) {
      fail(`Couldn't remove ACCESS from ${mediaConfig.name}; it is still public. Run this again.`)
    }
    const argv = ['deploy', '--config', 'wrangler.media.jsonc']
    if (Object.keys(mediaValues).length) argv.push('--secrets-file', secretsFile('media', mediaValues))
    wrangler(argv)
    say(`  Deployed ${mediaOrigin}`)
  }

  // 5. The API's settings. Keys are made once and never rotated here: a new SESSION_MAC_KEY
  // would sign everyone out, and a new CURSOR_MAC_KEY would break every open page.
  step('Settings and keys')
  const values = { CANONICAL_ORIGIN: apiOrigin }
  if (!apiSecrets.has('CURSOR_MAC_KEY')) values.CURSOR_MAC_KEY = hex32()
  if (!apiSecrets.has('SESSION_MAC_KEY')) values.SESSION_MAC_KEY = hex32()
  if (firstDeploy) values.INGEST_BACKFILL_HOURS = backfillHours
  if (fids) values.ALLOWED_FIDS = fids
  if (open) values.ACCESS = 'public'
  if (close && apiSecrets.has('ACCESS')) {
    if (!(await deleteSecret(apiConfig.name, 'ACCESS'))) fail(`Couldn't remove ACCESS from ${apiConfig.name}; it is still public. Run this again.`)
    say('  Removed ACCESS: private again')
  }
  if (media) values.MEDIA_ORIGIN = mediaOrigin
  // Images off on a deployment that had them: without MEDIA_ORIGIN the API stores and names none.
  if (!media && apiSecrets.has('MEDIA_ORIGIN')) {
    say((await deleteSecret(apiConfig.name, 'MEDIA_ORIGIN')) ? '  Removed MEDIA_ORIGIN: images are off' : '  Could not remove MEDIA_ORIGIN; images stay on until it is removed')
  }
  if (mediaKey) values.MEDIA_KEY = mediaKey
  say(`  Setting ${Object.keys(values).join(', ')} (values not shown)`)

  // 6. Build and deploy.
  step('Deploying the API')
  const headers = spawnSync('node', ['scripts/web-headers.mjs'], { cwd: APP, env: { ...process.env, MEDIA_ORIGIN: media ? mediaOrigin : '' }, encoding: 'utf8' })
  if (headers.status !== 0) fail(headers.stderr)
  // Without images, the API deploys without the R2 and Images bindings: an account without R2
  // can't bind a bucket, and the API then stores and names no images at all.
  if (!media) {
    delete deployConfig.r2_buckets
    delete deployConfig.images
    writeDeployConfig()
  }
  wrangler(['deploy', '--config', DEPLOY_CONFIG, '--secrets-file', secretsFile('api', values)])
  say(`  Deployed ${apiOrigin}`)

  // 7. Start ingestion. Any /api request starts it (the minute cron can take a while to
  // begin); progress is read from the database, since the status page needs a session.
  step('Starting ingestion')
  await fetch(`${apiOrigin}/api/meta`, { headers: { 'user-agent': 'warpstack-deploy' } }).catch(() => {})
  let ready = false
  for (let i = 0; i < 24 && !ready; i++) {
    await new Promise(r => setTimeout(r, 5_000))
    const rows = wranglerJson(['d1', 'execute', 'DB', '--remote', '--json', '--config', DEPLOY_CONFIG, '--command',
      'SELECT (SELECT count(*) FROM ingest_cursor) AS shards, (SELECT count(*) FROM casts) AS casts'], { allowFail: true })
    const r = rows?.[0]?.results?.[0]
    ready = (r?.shards ?? 0) >= 2
    if (ready) say(`  Running on both shards: ${r.casts} casts indexed so far`)
  }
  if (!ready) say('  Not moving yet. Run this again in a minute; it picks up where it left off.')

  step('Done')
  say(`  App:     ${apiOrigin}`)
  if (media) say(`  Images:  ${mediaOrigin}`)
  if (!media) say('  Images:  off (avatars are initials, images are links)')
  // What the deployment now has, not what was asked for.
  const isPublic = open || (!close && apiSecrets.has('ACCESS'))
  const who = fids ? `FIDs ${fids}` : apiSecrets.has('ALLOWED_FIDS') ? 'the FIDs already listed' : 'the app FID\'s keys'
  say(`  Access:  ${isPublic ? 'public (anyone)' : `private (${who})`}${!open && !close && !fids ? ', unchanged' : ''}`)
  if (isPublic && fids && !open) say('  It is still public: the list only matters once it is private. Run with --private to make it private.')
  const cd = here('.') === '.' ? '' : `cd ${here('.')} && `
  say(`\n  Point the phone app at it and build it:\n    ${cd}EXPO_PUBLIC_API_URL=${apiOrigin} pnpm run ios:release`)
} catch (e) {
  if (!(e instanceof Stop)) throw e
  console.error(`\n✘ ${e.message}`)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
