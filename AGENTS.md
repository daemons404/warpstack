# Warpstack

Warpstack is a set of simple, feature-complete building blocks for Farcaster clients. Users hold their own keys, Snapchain is the database, and Cloudflare runs everything.

## Before you change anything

1. Read `docs/architecture.md`: the 15 principles, how the packages fit, and what isn't built yet.
2. Read `docs/security.md` before touching keys, sessions, writes, the fetchers or CI.
3. Read the `AGENTS.md` of the package you are touching. The code and its tests are the source of truth; the docs describe them.

## Rules that decide

- When principles conflict, the order is: user safety, then user ownership, then running cost, then convenience.
- The sealed core is `packages/protocol`, `packages/wallet` (with its reference vectors) and `packages/api/src/adapters/fetchers`. Changes there need a human's approval.
- Anything listed under "Not built yet" in `docs/architecture.md` is out of scope unless the task says otherwise.
- If the docs and the code disagree, or something you need is missing, say so and propose a fix rather than guessing.

## Working in the code

- `pnpm check` runs typecheck, lint and tests in seconds with no network or secrets. Run it before every commit.
- `pnpm dev` exports the Expo app for the web and runs the Worker locally on Miniflare against the public Snapchain node, with no Cloudflare account (copy `apps/app/.dev.vars.example` to `.dev.vars` first). Images are off there: avatars are initials and image embeds are links. `pnpm dev:remote` adds images through the remote Images binding and needs a Cloudflare login. Local hosting must never depend on a Cloudflare account. `pnpm web` runs Expo's dev server for the web; `pnpm --filter @warpstack/app ios` builds the phone app.
- `pnpm check` also runs the Miniflare suite (`pnpm test:workers`), which runs the Worker against real D1 semantics locally.
- In an Amp orb, `.agents/setup` installs dependencies and writes a local `.dev.vars`, and `amp orb services ensure` runs `pnpm dev` behind a portal (`.amp/services.yaml`).
- Tests check behavior through public interfaces, and each must fail on a plausible bug: property tests, the ingestion simulation, reference vectors, or one regression test per real bug. Don't add a test per function. `pnpm sim` runs the ingestion simulation over 2,000 seeds (`SIM_RUNS` for more); a failure prints a seed and path that replay it (`SIM_SEED`, `SIM_PATH`), and the fix keeps that case passing.
- Packages are TypeScript source with no build step; Wrangler and Vite bundle them.
- The design rules are lint rules: no `Date.now`, `Math.random` or `crypto.randomUUID` in core code; `core/` never imports `adapters/`; no `fetch` outside the fetchers and fixed-host adapters; `app-core` never imports `ui`. Don't disable a rule to get past it; fix the boundary.
- New dependencies are installed only once they are 7 days old (`minimumReleaseAge` in `pnpm-workspace.yaml`).
- Each package has its own `AGENTS.md`: read it before changing that package.

## CI and the supply chain

- `.github/workflows/check.yml` runs `pnpm check` and the web build on every PR, plus `scripts/check-lockfile.mjs` (packages new to the lockfile must be 7 days old and come from npm with an integrity hash) and `scripts/lint-workflows.sh` (actionlint and zizmor). `rust.yml` and `swift.yml` run when the wallet changes.
- Workflows run on `pull_request`, never `pull_request_target`; the token is read-only; actions are pinned to a full commit with the version in a comment, and any new one must be at least 7 days old. Lint rules can't be switched off inside a file (`noInlineConfig`).
- This repository is public, and development happens in it. `scripts/scan-leaks.sh` fails on anything that must not be committed (local paths, private links, keys, real deployment IDs, private files), ignoring gitignored files; CI runs it. What reaches npm is each package's `files` list, scanned again by `scripts/publish-npm.sh`.
- `scripts/repo-settings.sh` holds this repository's settings (branch rules, Actions permissions, security features). It changes nothing without `--apply`.
