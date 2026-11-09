import type { Timestamp } from '@warpstack/protocol'
import type { Clock } from '../ports.ts'

export const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) as Timestamp }
