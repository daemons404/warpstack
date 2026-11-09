import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { toHex } from './bytes.ts'
import { parseSessionOrigin, sessionPreimage, verifySession } from './session.ts'

// Reference vectors (sealed core). The preimage below was built outside this code, byte by
// byte: the prefix, a big-endian u16 length, the origin, and the nonce 00..1f.

const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i)
const ORIGIN = 'https://test-warpstack.ngrok.io'
const PREIMAGE = '0x77617270737461636b2d73657373696f6e2d7631001f68747470733a2f2f746573742d77617270737461636b2e6e67726f6b2e696f000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const SEED = new Uint8Array(32).fill(7)
const KEY = ed25519.getPublicKey(SEED)

describe('session challenges', () => {
  it('build the pinned preimage', () => {
    const p = sessionPreimage(ORIGIN, NONCE)
    expect(p.ok && toHex(p.value)).toBe(PREIMAGE)
  })

  it('verify a strict signature for the same origin and nonce only', () => {
    const p = sessionPreimage(ORIGIN, NONCE)
    if (!p.ok) throw new Error(p.error)
    const sig = ed25519.sign(p.value, SEED)
    expect(verifySession(KEY, ORIGIN, NONCE, sig)).toBe(true)
    expect(verifySession(KEY, 'https://other.example', NONCE, sig)).toBe(false)
    expect(verifySession(KEY, ORIGIN, NONCE.map(x => x ^ 1), sig)).toBe(false)
    expect(verifySession(new Uint8Array(32).fill(1), ORIGIN, NONCE, sig)).toBe(false)
    expect(verifySession(KEY, ORIGIN, NONCE, sig.slice(0, 63))).toBe(false)
  })

  it('is never a 20-byte message hash', () => {
    const p = sessionPreimage('http://localhost', NONCE)
    expect(p.ok && p.value.length).toBe(20 + 2 + 16 + 32)
  })

  it('accepts https origins and local http only', () => {
    for (const o of ['https://warpstack.xyz', 'https://a.b-c.example:8443', 'http://localhost', 'http://localhost:8787', 'http://127.0.0.1:8787']) {
      expect(parseSessionOrigin(o).ok, o).toBe(true)
    }
    for (const o of [
      'http://warpstack.xyz', 'https://warpstack.xyz/', 'https://Warpstack.xyz', 'https://warpstack.xyz/path', 'https://user@warpstack.xyz',
      'https://-a.example', 'https://a..example', 'https://warpstack.xyz:0', 'https://warpstack.xyz:65536', 'http://192.168.1.2:8787',
      'http://localhost.evil.com', ` ${ORIGIN}`, `https://${'a'.repeat(250)}.xyz`, '', 42,
    ]) {
      expect(parseSessionOrigin(o).ok, String(o)).toBe(false)
    }
  })

  it('refuses a nonce of the wrong length', () => {
    expect(sessionPreimage(ORIGIN, new Uint8Array(31)).ok).toBe(false)
    expect(sessionPreimage(ORIGIN, new Uint8Array(33)).ok).toBe(false)
  })
})
