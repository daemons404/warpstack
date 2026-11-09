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
- Packages are TypeScript source with no build step; Wrangler and Vite bundle them.
- The design rules are lint rules: no `Date.now`, `Math.random` or `crypto.randomUUID` in core code; `core/` never imports `adapters/`; no `fetch` outside the fetchers and fixed-host adapters; `app-core` never imports `ui`. Don't disable a rule to get past it; fix the boundary.
- New dependencies are installed only once they are 7 days old (`minimumReleaseAge` in `pnpm-workspace.yaml`).
- Each package has its own `AGENTS.md`: read it before changing that package.

## CI and the supply chain

- `.github/workflows/check.yml` runs `pnpm check` and the web build on every PR, plus `scripts/check-lockfile.mjs` (packages new to the lockfile must be 7 days old and come from npm with an integrity hash) and `scripts/lint-workflows.sh` (actionlint and zizmor). `rust.yml` and `swift.yml` run when the wallet changes.
- Workflows run on `pull_request`, never `pull_request_target`; the token is read-only; actions are pinned to a full commit with the version in a comment, and any new one must be at least 7 days old. Lint rules can't be switched off inside a file (`noInlineConfig`).
- `scripts/scan-leaks.sh` fails on anything that must not be published (local paths, private links, keys, real deployment IDs, private files); CI runs it. `scripts/export-release.sh` copies the publishable paths, an allowlist, from a commit into the release repository's checkout and scans the result; with `--check` it changes nothing and fails if the release repository's `main` differs from what a commit publishes. The release repository is never edited by hand.
- `scripts/repo-settings.sh` holds the release repository's settings (branch rules, Actions permissions, security features). It changes nothing without `--apply`.
