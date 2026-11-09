import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventId } from '@warpstack/protocol'
import { parseEvents } from '../src/adapters/snapchain-http.ts'
import type { HubEvent } from '../src/core/snapchain-types.ts'

/** A recorded page of real `/v1/events` output from the public node, parsed like the adapter does. */
export const recordedPage = (name: string): { from: EventId; events: HubEvent[] } => {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', `${name}.json`), 'utf8'))
  return { from: raw.from as EventId, events: parseEvents(raw.events).events }
}
