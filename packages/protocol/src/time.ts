import type { Timestamp } from './brands.ts'

/** Farcaster time counts seconds from 2021-01-01T00:00:00Z. */
export const FARCASTER_EPOCH = 1_609_459_200

export const fromFarcasterTime = (t: number): Timestamp => (t + FARCASTER_EPOCH) as Timestamp
export const toFarcasterTime = (t: Timestamp): number => t - FARCASTER_EPOCH
