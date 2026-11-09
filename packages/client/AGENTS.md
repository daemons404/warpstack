# client

The headless data layer: the typed API client (`createApi`, which parses every response with the contract's schemas), the entity store, cast-text segmentation and the React screen hooks in `client/react`.

- No React Native or DOM imports outside `src/react/`; another shell must be able to use the core.
- Screens get data only through the hooks here; they never call the API directly.
- Public routes carry no credential.
- Hooks return `Read<T>`, `ListState<T>` or `Action<I, O>`, and report every error as a `WarpError` from `toWarpError`. Their query keys come from the route helpers (`api.<route>.queryKey`, `queryOptions`, `infiniteOptions`); the account's own data adds the FID with `mine()`.
