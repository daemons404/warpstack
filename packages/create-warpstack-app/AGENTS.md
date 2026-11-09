# create-warpstack-app

The generator: `pnpm create warpstack-app my-app` makes a standalone copy of `apps/app` whose
building blocks come from npm. `apps/app` is the only source of the template.

- `scripts/build-template.mjs` copies an allowlist of `apps/app` into `template/` (git ignores
  it; `pnpm run build` and `prepack` make it). It points monorepo paths into `node_modules`,
  pins every dependency to the exact version in `pnpm-lock.yaml`, puts the placeholder in
  `database_id`, and fails if anything of the monorepo or any secret is left. When `apps/app`
  changes shape, update its replacements; never loosen its final checks.
- `src/generate.ts` names a copy of the template (app name, Worker, database, bucket, bundle
  ID). `src/index.ts` is the CLI: it asks only in a terminal, takes flags otherwise, prints
  plain lines and ends with what to run next. No dependencies beyond Node.
- `pnpm test` builds the template and generates an app offline. `sh scripts/rehearse-create.sh`
  (from the repo root) packs every package, generates an app outside the repo from the
  tarballs, installs it, and typechecks, builds and dry-runs it; `--ios` adds the vault build.
  Run it after changing `apps/app`, a package's exports or this generator.
