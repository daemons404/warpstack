# api

The Cloudflare backend: one Hono Worker serving the contract through oRPC, per-shard ingestion Durable Objects folding Snapchain events into D1, and the read service.

- `src/core/` is the functional core (the fold, presenters, cursors, rows): pure, no adapters, no ambient time. `src/adapters/` holds port implementations. `src/reads.ts` and `src/ingest.ts` orchestrate them.
- Every port has an in-memory fake: `FakeSnapchain`, and the `Sql` port on `node:sqlite` with the same migrations (`test/sqlite.ts`).
- Ingestion applies each page exactly once: the cursor update and the page's rows commit in one batch, guarded by `cursor_guard`. The fold follows the node's outcome (merges add, `deletedMessages`, prunes and revokes subtract exact hashes). Counts are raw deltas, clamped by readers, so results don't depend on page boundaries.
- Migrations in `migrations/` are additive only.
- Never call `fetch` on a user-supplied URL here: that's the fetchers' job. `src/adapters/fetchers/` is sealed core (the restricted transport, image checks and link previews): a human approves every change there, and lint lets only it and the fixed-host adapters call `fetch`.
- The Worker holds no key that can act as a user.
- All Snapchain access goes through `snapchainOf(config.snapchain)`: one `HttpSnapchain`, or a `PooledSnapchain` when `SNAPCHAIN_URL` lists several nodes (failover on `unavailable`, a breaker per node, writes to two). The Worker and both Durable Objects read the same config, so settings live there, not in `createApp` options.
- `RETENTION_DAYS` (default 28, at most 90) sets how long the index keeps casts: the daily prune and the coverage reads both use it.
