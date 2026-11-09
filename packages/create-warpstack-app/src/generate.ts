// Turns the template into a named app in a new folder. No prompts and no installs here: the
// CLI (index.ts) asks the questions and runs pnpm.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export type AppOptions = {
  /** The template folder, as build-template.mjs writes it. */
  template: string
  /** The new app's folder. It must not exist, or be empty. */
  dir: string
  /** The display name, as on the home screen. */
  name: string
  /** Names the Worker, its database and its image bucket, and the package. */
  slug: string
  /** The iOS bundle ID and Android package. */
  bundleId: string
  /** Packed @warpstack tarballs by package name, to install instead of the registry's. */
  tarballs?: Record<string, string>
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const SLUG = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/
const BUNDLE_ID = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)+$/

/** A slug from a folder or display name: lowercase letters, digits and dashes. */
export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40).replace(/-+$/, '')

export const checkSlug = (slug: string): string | null =>
  SLUG.test(slug) ? null : 'The name must start with a letter and use only lowercase letters, digits and dashes (at most 40). It names your Worker, so it appears in your server\'s address.'

export const checkBundleId = (id: string): string | null =>
  BUNDLE_ID.test(id) ? null : 'A bundle ID looks like com.example.myapp: two or more parts separated by dots, each starting with a letter, letters and digits only.'

export const checkName = (name: string): string | null =>
  name.trim().length > 0 && name.length <= 30 && !/["\\\n]/.test(name) ? null : 'The app name needs 1 to 30 characters, without quotes or backslashes.'

/** `@warpstack/api` for `warpstack-api-0.1.0.tgz`, as `pnpm pack` names it. */
export const tarballPackage = (file: string): string | null => {
  const m = /^warpstack-([a-z-]+?)-\d+\.\d+\.\d+.*\.tgz$/.exec(basename(file))
  return m ? `@warpstack/${m[1]}` : null
}

const swap = (text: string, from: string, to: string, file: string, count = 1): string => {
  const n = text.split(from).length - 1
  if (n !== count) throw new Error(`${file}: expected ${count} of ${JSON.stringify(from)}, found ${n}`)
  return text.split(from).join(to)
}

type Json = Record<string, unknown>
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8')) as Json
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
const edit = (file: string, f: (text: string) => string) => writeFileSync(file, f(readFileSync(file, 'utf8')))

export const generate = (o: AppOptions): Result<string> => {
  for (const problem of [checkName(o.name), checkSlug(o.slug), checkBundleId(o.bundleId)]) {
    if (problem) return { ok: false, error: problem }
  }
  if (!existsSync(join(o.template, 'package.json'))) return { ok: false, error: `No template at ${o.template}. Run \`pnpm run build\` in create-warpstack-app first.` }
  if (existsSync(o.dir) && readdirSync(o.dir).length > 0) return { ok: false, error: `${o.dir} already exists and isn't empty. Choose another folder.` }

  try {
    cpSync(o.template, o.dir, { recursive: true })
    renameSync(join(o.dir, 'gitignore'), join(o.dir, '.gitignore'))

    const pkg = readJson(join(o.dir, 'package.json'))
    pkg.name = o.slug
    if (o.tarballs) {
      const deps = pkg.dependencies as Record<string, string>
      for (const [name, file] of Object.entries(o.tarballs)) {
        if (name in deps) deps[name] = `file:${file}`
      }
    }
    writeJson(join(o.dir, 'package.json'), pkg)
    if (o.tarballs) {
      // The packages depend on each other, so every one is pinned to its tarball. These join the
      // template's own overrides in pnpm-workspace.yaml: overrides in package.json would replace
      // them.
      const lines = Object.entries(o.tarballs).map(([n, f]) => `  ${JSON.stringify(n)}: ${JSON.stringify(`file:${f}`)}`)
      edit(join(o.dir, 'pnpm-workspace.yaml'), t => swap(t, '\noverrides:\n', `\noverrides:\n${lines.join('\n')}\n`, 'pnpm-workspace.yaml'))
    }

    const appJson = readJson(join(o.dir, 'app.json'))
    const expo = appJson.expo as Json
    Object.assign(expo, { name: o.name, slug: o.slug, scheme: o.slug })
    ;(expo.ios as Json).bundleIdentifier = o.bundleId
    ;(expo.android as Json).package = o.bundleId
    writeJson(join(o.dir, 'app.json'), appJson)

    edit(join(o.dir, 'wrangler.jsonc'), t => {
      t = swap(t, '"name": "warpstack"', `"name": "${o.slug}"`, 'wrangler.jsonc')
      t = swap(t, '"database_name": "warpstack-index"', `"database_name": "${o.slug}-index"`, 'wrangler.jsonc')
      return swap(t, '"bucket_name": "warpstack-media"', `"bucket_name": "${o.slug}-media"`, 'wrangler.jsonc')
    })
    edit(join(o.dir, 'wrangler.media.jsonc'), t => {
      t = swap(t, '"name": "warpstack-media"', `"name": "${o.slug}-media"`, 'wrangler.media.jsonc')
      return swap(t, '"bucket_name": "warpstack-media"', `"bucket_name": "${o.slug}-media"`, 'wrangler.media.jsonc')
    })
    edit(join(o.dir, 'SETUP.md'), t => t.split('warpstack.<subdomain>').join(`${o.slug}.<subdomain>`))
    edit(join(o.dir, 'README.md'), t => swap(t, '# Your Warpstack app', `# ${o.name}`, 'README.md'))
  } catch (e) {
    return { ok: false, error: `The template didn't match what the generator expects (${(e as Error).message}). This is a bug in create-warpstack-app.` }
  }
  return { ok: true, value: o.dir }
}
