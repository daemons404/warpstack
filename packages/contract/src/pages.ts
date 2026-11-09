import { z } from 'zod'
import { Rev, Timestamp } from './codecs.ts'
import { LIMITS } from './limits.ts'

/** Opaque to clients: MAC'd, bound to its route and parameters; passed back unchanged. */
export const Cursor = z.string().min(1).max(LIMITS.cursorBytes).brand<'Cursor'>()
export type Cursor = z.infer<typeof Cursor>

/** How a list ended. */
export const Next = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('more'), cursor: Cursor }),
  /** Nothing older exists. */
  z.object({ kind: z.literal('end') }),
  /** Older items exist, but this list doesn't serve them (the index's window); profiles do. */
  z.object({ kind: z.literal('horizon') }),
])
export type Next = z.infer<typeof Next>

export const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item).max(LIMITS.pageSize),
    next: Next,
    /** The index doesn't cover this list before this time: it restarted, or is still filling. */
    incompleteBefore: Timestamp.optional(),
    rev: Rev,
  })

export type Page<T> = { items: T[]; next: Next; incompleteBefore?: number; rev: Rev }
