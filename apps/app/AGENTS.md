# app

The Expo app: one codebase for the phone and the web (decided Oct 25, 2026). `app/` holds thin Expo Router route files over `@warpstack/ui` screens; `src/worker.ts` is the Cloudflare Worker that serves the API and the web export (`expo export -p web` into `dist/`) together, configured in `wrangler.jsonc`.

- `pnpm dev` exports the web build and runs the Worker locally; `pnpm web` runs Expo's dev server for the web against it; `pnpm ios` builds a development build.
- Route files parse params with `params.*` from `app-core` and render NotFound on failure. Links come from `routes.*`.
- Ops status is at `/_ops/status`.
