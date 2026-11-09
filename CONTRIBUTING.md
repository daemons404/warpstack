# Contributing

Thanks for helping. Warpstack holds people's Farcaster keys, so it moves carefully: small,
reviewed changes that keep every test green.

**For now, issues are off and only collaborators can open pull requests.** One person maintains
Warpstack, and keeping the repository quiet keeps that sustainable. Fork it and build on it
freely; that's what it's for. Report security problems privately, as
[`SECURITY.md`](SECURITY.md) says. The rest of this page is for collaborators, and for when the
doors open.

## Before you start

- Read [`AGENTS.md`](AGENTS.md). It applies to people and agents alike, and to each package
  (every package has its own `AGENTS.md`).
- Read [`docs/architecture.md`](docs/architecture.md), and [`docs/security.md`](docs/security.md)
  if your change touches keys, sessions, writes or untrusted content.
- For anything larger than a fix, agree on the approach with the maintainer before you write
  it.

## The rules that matter most

- **Safety, then ownership, then cost, then convenience,** when they pull against each other.
- **The sealed core needs a maintainer's explicit approval:** `packages/protocol`,
  `packages/wallet` (including its reference vectors), and `packages/api/src/adapters/fetchers`.
  Changes there are welcome, but expect a slow, careful review.
- **No new dependency without a reason.** One library per job. A new package must be at least
  7 days old on npm (or crates.io), and CI checks it.
- **Lint rules are design rules.** They can't be switched off inside a file; if one is wrong,
  change it in `eslint.config.js` and say why.

## Making the change

```sh
pnpm install
pnpm check      # typecheck, lint and every test, offline, in under a minute
```

Run `pnpm check` before every commit. If you touch the Rust vault, also run
`pnpm --filter @warpstack/wallet test:native`.

Commits are small and say what changed for a user in the first line. Commits on `main` are
signed; GitHub signs squash merges for you.

## Agents

PRs written with an AI agent are welcome on the same terms as any other. A person opens the
PR, has read every line of it, and answers for it in review. Say in the PR that an agent wrote
it. Agents follow `AGENTS.md` like everyone else.

## License

Warpstack is MIT-licensed. By contributing, you agree that your contribution is licensed under
the MIT License too. There's nothing to sign.
