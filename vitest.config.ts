import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.{ts,tsx}', 'packages/*/test/**/*.test.{ts,tsx}'],
          exclude: ['**/*.workers.test.ts', '**/node_modules/**'],
          environment: 'node',
          // node:sqlite backs the in-memory index in `pnpm check`.
          execArgv: ['--experimental-sqlite', '--no-warnings'],
        },
      },
    ],
  },
})
