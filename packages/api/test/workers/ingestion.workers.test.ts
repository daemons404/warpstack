import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { IngestionObject } from '../../src/ingestion.ts'

const INGEST = (env as unknown as { INGEST: DurableObjectNamespace<IngestionObject> }).INGEST

describe('the ingestion Durable Object', () => {
  it('records an unreachable node and always schedules its next alarm', async () => {
    const stub = INGEST.get(INGEST.idFromName('shard-test'))
    await stub.ensure(1)
    // The first alarm fires at once; the test node doesn't exist, so it fails.
    let status = await stub.status()
    for (let i = 0; i < 50 && !status; i++) {
      await new Promise(r => setTimeout(r, 20))
      status = await stub.status()
    }
    expect(status?.last?.status).toBe('unreachable')
    expect(status?.errors).toBeGreaterThanOrEqual(1)
    // The handler caught the failure and set the next alarm, backing off to a minute.
    let alarm: number | null = null
    await runInDurableObject(stub, async (_o, state) => { alarm = await state.storage.getAlarm() })
    expect(alarm).not.toBeNull()
    expect(alarm! - Date.now()).toBeGreaterThan(50_000)
    // Running it early does the same again: one more recorded failure, and another alarm.
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect((await stub.status())?.errors).toBeGreaterThan(status!.errors)
  })

  it('refuses a shard that isn\'t a data shard', async () => {
    const stub = INGEST.get(INGEST.idFromName('shard-bad'))
    // Called inside the object, so the rejection is caught here rather than logged as a remote exception.
    await runInDurableObject(stub, async instance => {
      await expect(instance.ensure(0)).rejects.toThrow(/not a data shard/)
    })
  })
})
