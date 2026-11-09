# @warpstack/api

The Warpstack server as a Cloudflare Worker: follows Snapchain into a D1 cast index, serves the contract, keeps each user's private state in a Durable Object, and fetches untrusted links and images through restricted fetchers. Holds no key that can act as a user.

**Use it alone for:** A backend for any Farcaster client. Runs locally on Miniflare with no Cloudflare account.

Part of [Warpstack](https://github.com/daemons404/warpstack), simple, feature-complete building blocks for Farcaster clients:
users hold their own keys, Snapchain is the database, and Cloudflare runs everything. Start a
complete app with `pnpm create warpstack-app my-app`. See the
[architecture](https://github.com/daemons404/warpstack/blob/main/docs/architecture.md) and
[security](https://github.com/daemons404/warpstack/blob/main/docs/security.md) docs.

**Early and changing fast:** not independently audited; use at your own risk. Breaking changes are likely before 1.0.

MIT licensed.
