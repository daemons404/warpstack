import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// The Miniflare suite: the Worker and real D1 semantics, locally. `pnpm test:workers`.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(join(import.meta.dirname, 'migrations'))
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    })],
    test: {
      include: ['test/workers/**/*.workers.test.ts'],
      setupFiles: ['test/workers/setup.ts'],
    },
  }
})
