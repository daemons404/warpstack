# app-core

The composition root: config parsed with Zod, the providers (`AppProviders`), typed links (`routes`) and route-param parsers (`params`). It renders nothing and never imports `ui`. Canonical URLs are FID-based; `/{username}` is an alias.
