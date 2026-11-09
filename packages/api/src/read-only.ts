import { err } from '@warpstack/protocol'
import type { Snapchain } from './ports.ts'

/**
 * The emergency switch: lazy upstream reads fail fast with a typed error, and everything
 * indexed or cached keeps working. Ingestion isn't stopped; the governors are what cut its
 * writes.
 */
export const readOnlySnapchain = (inner: Snapchain): Snapchain => {
  const off = async () => err({ kind: 'unavailable' as const, detail: 'the deployment is read-only' })
  return {
    events: (...a) => inner.events(...a),
    heads: () => inner.heads(),
    castById: off, castsByFid: off, castsByParent: off, reactionsByCast: off,
    linksByFid: off, linksByTarget: off, userData: off, verifications: off, storageLimits: off, fidByUsername: off,
    castsByMention: off, reactionsByFid: off, signers: off, custodyOf: off, submitMessage: off,
  }
}
