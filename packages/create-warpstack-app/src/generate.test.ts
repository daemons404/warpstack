// Builds the template from apps/app and generates an app from it, offline and without
// installing anything. scripts/rehearse-create.sh goes further: it installs the generated app
// from packed tarballs and builds it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { checkBundleId, checkSlug, generate, slugify, tarballPackage } from './generate.ts'

const work = mkdtempSync(join(tmpdir(), 'create-warpstack-app-'))
const template = join(work, 'template')
const script = fileURLToPath(new URL('../scripts/build-template.mjs', import.meta.url))

beforeAll(() => {
  execFileSync(process.execPath, [script, template], { stdio: 'pipe' })
}, 30_000)
afterAll(() => rmSync(work, { recursive: true, force: true }))

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(f => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
const text = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8')

describe('the template', () => {
  it('is standalone: nothing points into the monorepo', () => {
    for (const file of walk(template)) {
      const t = readFileSync(file, 'utf8')
      for (const bad of ['../../', 'workspace:', 'catalog:', 'apps/app']) expect(t, file).not.toContain(bad)
    }
  })

  it('carries no secrets and only the placeholder database ID', () => {
    const files = walk(template).map(f => f.slice(template.length + 1))
    expect(files.filter(f => /(^|\/)(\.dev\.vars|\.env\.deploy|\.env)$/.test(f))).toEqual([])
    expect(files.some(f => f.startsWith('node_modules') || f.startsWith('dist/') || f.startsWith('ios/'))).toBe(false)
    expect(text(template, 'wrangler.jsonc')).toContain('"database_id": "00000000-0000-0000-0000-000000000000"')
  })

  it('pins every dependency to the exact version the repo tested', () => {
    const pkg = JSON.parse(text(template, 'package.json')) as { dependencies: Record<string, string> }
    for (const [name, spec] of Object.entries(pkg.dependencies)) expect(spec, name).toMatch(/^\d+\.\d+\.\d+/)
    expect(Object.keys(pkg.dependencies)).toContain('@warpstack/api')
  })
})

describe('generate', () => {
  const dir = join(work, 'my-app')
  const tarballs = { '@warpstack/api': '/t/warpstack-api-0.0.0.tgz', '@warpstack/protocol': '/t/warpstack-protocol-0.0.0.tgz' }

  it('names the app, its Worker, database and bucket', () => {
    const r = generate({ template, dir, name: 'My App', slug: 'my-app', bundleId: 'com.example.myapp', tarballs })
    expect(r).toEqual({ ok: true, value: dir })
    const app = JSON.parse(text(dir, 'app.json')) as { expo: Record<string, unknown> & { ios: { bundleIdentifier: string } } }
    expect(app.expo).toMatchObject({ name: 'My App', slug: 'my-app', scheme: 'my-app' })
    expect(app.expo.ios.bundleIdentifier).toBe('com.example.myapp')
    expect(text(dir, 'wrangler.jsonc')).toContain('"name": "my-app"')
    expect(text(dir, 'wrangler.jsonc')).toContain('"database_name": "my-app-index"')
    expect(text(dir, 'wrangler.media.jsonc')).toContain('"name": "my-app-media"')
    expect(text(dir, 'SETUP.md')).toContain('my-app.<subdomain>')
    expect(existsSync(join(dir, '.gitignore'))).toBe(true)
    expect(existsSync(join(dir, 'gitignore'))).toBe(false)
  })

  it('installs @warpstack packages from tarballs when asked', () => {
    const pkg = JSON.parse(text(dir, 'package.json')) as { name: string; dependencies: Record<string, string>; pnpm?: unknown }
    expect(pkg.name).toBe('my-app')
    expect(pkg.dependencies['@warpstack/api']).toBe('file:/t/warpstack-api-0.0.0.tgz')
    // In pnpm-workspace.yaml, beside the template's own overrides, which package.json's would replace.
    expect(pkg.pnpm).toBeUndefined()
    const workspace = text(dir, 'pnpm-workspace.yaml')
    expect(workspace).toContain('"@warpstack/protocol": "file:/t/warpstack-protocol-0.0.0.tgz"')
    expect(workspace).toContain('node-forge: 1.4.2')
  })

  it('refuses a folder that has files, and bad names', () => {
    expect(generate({ template, dir, name: 'X', slug: 'my-app', bundleId: 'com.example.x' }).ok).toBe(false)
    const fresh = join(work, 'other')
    expect(generate({ template, dir: fresh, name: 'X', slug: 'Bad Name', bundleId: 'com.example.x' }).ok).toBe(false)
    expect(generate({ template, dir: fresh, name: 'X', slug: 'ok', bundleId: 'nodots' }).ok).toBe(false)
    expect(generate({ template, dir: fresh, name: 'Say "hi"', slug: 'ok', bundleId: 'com.example.x' }).ok).toBe(false)
  })
})

describe('names', () => {
  it('slugifies folder names into Worker names', () => {
    expect(slugify('My Cool App!')).toBe('my-cool-app')
    expect(slugify('42-things')).toBe('things')
    expect(checkSlug('my-app')).toBeNull()
    expect(checkSlug('-x')).not.toBeNull()
    expect(checkBundleId('com.example.my-app')).not.toBeNull()
  })

  it('reads package names from pnpm pack tarballs', () => {
    expect(tarballPackage('/x/warpstack-app-core-0.0.0.tgz')).toBe('@warpstack/app-core')
    expect(tarballPackage('warpstack-api-1.2.3-beta.1.tgz')).toBe('@warpstack/api')
    expect(tarballPackage('other-1.0.0.tgz')).toBeNull()
  })
})
