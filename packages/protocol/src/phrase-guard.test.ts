/// <reference types="node" />
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { looksLikePhrase } from './phrase-guard.ts'

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
const words = PHRASE.split(' ')

describe('looksLikePhrase', () => {
  it('spots a phrase however it was written down', () => {
    for (const text of [
      'test test test test test test test test test test test junk',
      PHRASE.toUpperCase(),
      words.map((w, i) => `${i + 1}. ${w}`).join('\n'),
      `my words: ${words.join(', ')}!`,
      words.join(','), words.join('-'), words.join('_'), words.join('/'), words.join(' | '),
      JSON.stringify(words),
      words.map(w => `• ${w}`).join('\n'),
      words.join(' 🔑 '),
      words.join('\u200b'),
      words.map(w => w.slice(0, 4)).join(' '),
      `https://${words.join('-')}.example`,
      `${words.slice(0, 6).join(' ')}\n\n${words.slice(6).join(' ')}`,
    ]) expect(looksLikePhrase(text), text).toBe(true)
  })

  it('spots most of a phrase: eleven words, or one misspelled', () => {
    expect(looksLikePhrase(words.slice(0, 11).join(' '))).toBe(true)
    expect(looksLikePhrase([...words.slice(0, 5), 'abtsrct', ...words.slice(6)].join(' '))).toBe(true)
  })

  it('leaves ordinary text alone', () => {
    expect(looksLikePhrase('warpstack-key-request:v1:eyJvcCI6ImFkZCJ9')).toBe(false)
    expect(looksLikePhrase('gm gm gm')).toBe(false)
    expect(looksLikePhrase(words.slice(0, 10).join(' '))).toBe(false)
  })

  it('raises no false alarm anywhere in the docs', () => {
    // Every Markdown file in the repository, whatever the checkout holds.
    const skip = new Set(['node_modules', '.git', 'target', 'dist', 'ios', 'android', '.expo', '.wrangler'])
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e: Dirent) =>
      e.isDirectory() ? (skip.has(e.name) ? [] : walk(join(dir, e.name))) : e.name.endsWith('.md') ? [join(dir, e.name)] : [])
    const files = walk(join(import.meta.dirname, '..', '..', '..'))
    expect(files.length).toBeGreaterThan(8)
    for (const f of files) expect(looksLikePhrase(readFileSync(f, 'utf8')), f).toBe(false)
  })
})
