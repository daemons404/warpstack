import { ed25519 } from '@noble/curves/ed25519.js'
import { equalBytes, toHex } from './bytes.ts'
import { FARCASTER_MAINNET, MESSAGE_LIMITS, messageHash } from './messages.ts'
import { readFields } from './proto.ts'
import { err, ok, type Result } from './result.ts'

// Worker-side validation of a signed message before it reaches the network:
// the envelope's structure, the hash over `data_bytes`, the Ed25519 signature (strict,
// as Snapchain verifies it), and the top of `MessageData`. Whether the signer is a live key
// for the FID is the node's check.

export type VerifiedMessage = {
  type: number
  fid: number
  /** Farcaster time. */
  timestamp: number
  hash: `0x${string}`
  signer: Uint8Array
  dataBytes: Uint8Array
}

/** The largest envelope accepted: data plus hash, signature, signer and framing. */
export const MAX_ENVELOPE_BYTES = MESSAGE_LIMITS.dataBytes + 256

export const verifyMessage = (bytes: Uint8Array): Result<VerifiedMessage, string> => {
  if (bytes.length > MAX_ENVELOPE_BYTES) return err('message too large')
  let hash: Uint8Array | undefined, signature: Uint8Array | undefined, signer: Uint8Array | undefined, dataBytes: Uint8Array | undefined
  let hashScheme = 0, signatureScheme = 0
  try {
    for (const f of readFields(bytes)) {
      if (f.wire === 2 && f.field === 2 && !hash) hash = f.value
      else if (f.wire === 0 && f.field === 3) hashScheme = f.value
      else if (f.wire === 2 && f.field === 4 && !signature) signature = f.value
      else if (f.wire === 0 && f.field === 5) signatureScheme = f.value
      else if (f.wire === 2 && f.field === 6 && !signer) signer = f.value
      else if (f.wire === 2 && f.field === 7 && !dataBytes) dataBytes = f.value
      else return err('unexpected envelope field')
    }
  } catch {
    return err('malformed envelope')
  }
  if (!hash || !signature || !signer || !dataBytes?.length) return err('incomplete envelope')
  if (hashScheme !== 1 || signatureScheme !== 1) return err('unsupported scheme')
  if (dataBytes.length > MESSAGE_LIMITS.dataBytes) return err('message too large')
  if (!equalBytes(hash, messageHash(dataBytes))) return err('hash mismatch')
  if (signer.length !== 32 || signature.length !== 64) return err('bad signer or signature length')
  let valid: boolean
  try {
    valid = ed25519.verify(signature, hash, signer, { zip215: false })
  } catch {
    valid = false
  }
  if (!valid) return err('bad signature')

  let type = 0, fid = 0, timestamp = 0, network = 0
  try {
    for (const f of readFields(dataBytes)) {
      if (f.wire !== 0) continue
      if (f.field === 1) type = f.value
      else if (f.field === 2) fid = f.value
      else if (f.field === 3) timestamp = f.value
      else if (f.field === 4) network = f.value
    }
  } catch {
    return err('malformed message data')
  }
  if (network !== FARCASTER_MAINNET) return err('not a mainnet message')
  if (!type || !fid || !timestamp) return err('incomplete message data')
  return ok({ type, fid, timestamp, hash: toHex(hash), signer: Uint8Array.from(signer), dataBytes: Uint8Array.from(dataBytes) })
}
