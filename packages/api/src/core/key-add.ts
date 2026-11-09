import { readFields } from '@warpstack/protocol'

// The request FID a `KEY_ADD` names: the app that asked for the key, from the body's
// SignedKeyRequestMetadata (`abi.encode` of a tuple whose first word after the offset is the
// request FID). Read before relaying, so a private deployment with an app FID can refuse other
// apps' keys without asking the node; the node still checks the metadata's signature.

const KEY_ADD_BODY = 19
const METADATA = 6

export const keyAddRequestFid = (dataBytes: Uint8Array): number | null => {
  try {
    const body = readFields(dataBytes).find(f => f.field === KEY_ADD_BODY && f.wire === 2)
    if (!body || body.wire !== 2) return null
    const meta = readFields(body.value).find(f => f.field === METADATA && f.wire === 2)
    if (!meta || meta.wire !== 2 || meta.value.length < 64) return null
    const word = meta.value.subarray(32, 64)
    // A FID fits well inside a safe integer; anything with high bytes set isn't one.
    if (word.subarray(0, 25).some(b => b !== 0)) return null
    let n = 0
    for (const b of word.subarray(25)) n = n * 256 + b
    return n > 0 ? n : null
  } catch {
    return null
  }
}
