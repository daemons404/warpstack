import type { EventId } from './brands.ts'

/** Event IDs are `(block_height << 14) | seq`. Multiplication keeps them exact past 2^31. */
const SEQ_BITS = 2 ** 14

export const eventIdOf = (blockHeight: number, seq = 0): EventId => (blockHeight * SEQ_BITS + seq) as EventId
export const blockHeightOf = (id: EventId): number => Math.floor(id / SEQ_BITS)
