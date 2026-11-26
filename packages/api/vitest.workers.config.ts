import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// The Miniflare suite: the Worker and real D1 semantics, locally. `pnpm test:workers`.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(join(import.meta.dirname, 'migrations'))
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: { TEST_MIGRATIONS: migrations },
        // No network: every outbound request gets a 503, which the adapters read as unavailable.
        outboundService: () => new Response('no network in tests', { status: 503 }),
      },
    })],
    test: {
      include: ['test/workers/**/*.workers.test.ts'],
      setupFiles: ['test/workers/setup.ts'],
    },
  }
})
