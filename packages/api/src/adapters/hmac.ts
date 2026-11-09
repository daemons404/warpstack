import type { Mac } from '../ports.ts'

const toB64Url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** HMAC-SHA-256, truncated to 128 bits, with a key from the deployment's secret. */
export class HmacMac implements Mac {
  private readonly key: Promise<CryptoKey>

  constructor(secret: string) {
    this.key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  }

  async sign(data: string): Promise<string> {
    const sig = await crypto.subtle.sign('HMAC', await this.key, new TextEncoder().encode(data))
    return toB64Url(sig.slice(0, 16))
  }

  async verify(data: string, mac: string): Promise<boolean> {
    const expected = await this.sign(data)
    // Constant-time comparison.
    if (expected.length !== mac.length) return false
    let diff = 0
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i)
    return diff === 0
  }
}
