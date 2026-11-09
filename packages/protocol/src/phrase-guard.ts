import { wordlist } from '@scure/bip39/wordlists/english.js'

// Losing the recovery phrase loses the account, so anything that might carry one off the
// device checks for it first: a cast or profile edit about to be signed, an approval pasted
// into the app, and a key request pasted into the vault.

const WORDS = new Set(wordlist)
/** Every BIP-39 word is unique by its first four letters, which is how metal backups store them. */
const PREFIXES = new Set(wordlist.map(w => w.slice(0, 4)))

const WINDOW = 12
// Ordinary English reaches 10 list words in 12 (measured over 200k words of these docs).
const HITS = 11

/**
 * Whether text holds what looks like a recovery phrase, or nearly all of one: eleven or more
 * BIP-39 words (or their four-letter prefixes) within any twelve words in a row, whatever
 * separates them. Eleven of twelve words leave only about a hundred candidates, so a
 * near-complete phrase is as dangerous as a whole one, and one misspelled word mustn't hide
 * it. It is a guard against accidents, not a guarantee: ten words in prose pass.
 */
export const looksLikePhrase = (text: string): boolean => {
  const hits: boolean[] = []
  let inWindow = 0
  for (const word of text.normalize('NFKD').toLowerCase().split(/[^a-z]+/)) {
    if (!word) continue
    const hit = WORDS.has(word) || (word.length === 4 && PREFIXES.has(word))
    hits.push(hit)
    if (hit) inWindow++
    if (hits.length > WINDOW && hits[hits.length - 1 - WINDOW]) inWindow--
    if (inWindow >= HITS) return true
  }
  return false
}
