import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Decisions that a machine can check become lint rules (overview, Agents and tooling).
const banNondeterminism = {
  'no-restricted-properties': ['error',
    { object: 'Date', property: 'now', message: 'Time comes from the injected Clock in core code.' },
    { object: 'Math', property: 'random', message: 'Randomness comes from an injected Random in core code.' },
    { object: 'crypto', property: 'randomUUID', message: 'IDs come from an injected Ids port in core code.' },
  ],
}

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.wrangler/**', '**/.expo/**', 'videos/**', '**/*.snap'] },
  // No rule is switched off from inside a file: a change that needs an exception changes this
  // config, where CODEOWNERS sees it.
  { linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'ethers', message: 'viem is the only chain library (ADR 06).' },
          { name: 'redux', message: 'TanStack Query holds server data (ADR 20).' },
          { name: 'effect', message: 'Effect is not adopted (ADR 23).' },
          { name: 'yup', message: 'Zod 4 is the only schema library (ADR 07).' },
          { name: 'joi', message: 'Zod 4 is the only schema library (ADR 07).' },
        ],
      }],
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
  {
    // Functional core: pure domain logic, no adapters, no ambient time or randomness.
    files: ['packages/api/src/core/**/*.ts', 'packages/protocol/src/**/*.ts', 'packages/contract/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      ...banNondeterminism,
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/adapters/**', '../adapters/*'], message: 'core/ never imports adapters/: depend on a port instead.' }],
      }],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'No fetch in core; network access goes through a port.' }],
    },
  },
  {
    // Untrusted URLs are fetched only by the fetchers (sealed core). The Snapchain and
    // channel-registry adapters fetch fixed, operator-configured hosts.
    files: ['packages/api/src/**/*.ts'],
    ignores: ['packages/api/src/adapters/snapchain-http.ts', 'packages/api/src/adapters/channel-registry.ts', 'packages/api/src/adapters/fetchers/**'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Only the fetchers and fixed-host adapters may call fetch.' }],
    },
  },
  {
    // The sealed core's TypeScript never touches the network, the disk or the process: keys
    // live behind the native module, and protocol is pure.
    files: ['packages/wallet/src/**/*.ts', 'packages/protocol/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error',
        ...['fetch', 'WebSocket', 'XMLHttpRequest'].map(name => ({ name, message: 'The sealed core never uses the network.' })),
        { name: 'localStorage', message: 'Keys live only behind the native module.' },
        { name: 'process', message: 'The sealed core never reads the environment.' },
      ],
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['node:*', 'fs', 'net', 'http', 'https', 'child_process', 'dgram', 'tls', 'os', 'worker_threads'], message: 'The sealed core never touches the network or the disk.' }],
      }],
    },
  },
  {
    // The shells hold no logic another shell needs, and never talk to the API directly.
    files: ['packages/app-core/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}', 'apps/app/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Every network call goes through client.' }],
    },
  },
  {
    files: ['packages/app-core/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: '@warpstack/ui', message: 'app-core never imports ui: it wires providers and renders nothing.' }] }],
    },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Expo's Metro config is CommonJS, run by Node.
    files: ['**/metro.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: { require: 'readonly', module: 'writable', __dirname: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Build scripts, run by Node.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly', setTimeout: 'readonly' } },
  },
)
