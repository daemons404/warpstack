import { createApp } from './app.ts'
import type { Env } from './env.ts'
import { scheduled } from './scheduled.ts'

export { IngestionObject } from './ingestion.ts'
export { UserObject } from './user-object.ts'
export { createApp } from './app.ts'
export type { Env } from './env.ts'

const app = createApp()

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>
