# contract

The API as one file of routes (`src/contract.ts`), each declared as facts with `read()` from `define.ts`: `path` under `/api/`, `auth`, `fresh`, `cost`, `module`, `paged`. Method, Cache-Control, staleTime, the rate-limit class and the base errors are derived. `define.ts` is the only file that touches oRPC's contract API.

- Schemas stay in the wire dialect: plain JSON with brands; no `.transform`, `.refine` (except `utf8`), `.default` or `.catch`. Display-only enums and unions are open (`openEnum`, `openUnion`); security-relevant ones are closed. A test walks every route's JSON Schema.
- Images are `MediaKey`s, never URLs. Lists are `page(T)` with `next: more | end | horizon` and `rev`. Casts can be tombstones (`CastOrTombstone`).
- The contract only grows: inputs may only widen and outputs may only narrow. An incompatible change is a new route.
- Brands come from `protocol`; the patterns in `codecs.ts` must agree with its parsers (tested).
- `src/__snapshots__/openapi.json` is the whole contract as OpenAPI, checked by a snapshot test. A diff there is a contract change: review it, accept it with `vitest -u`, and bump `CONTRACT_VERSION` (minor for an addition, major for anything an older client would mis-read).
