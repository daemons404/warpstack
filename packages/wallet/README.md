# @warpstack/wallet

Warpstack's phone vault: the recovery phrase in Rust, the app key in the Keychain wrapped by the Secure Enclave. Built from source on your machine.

Part of Warpstack's **sealed core**: every change is approved by a human and tested against independent reference vectors.

**Use it alone for:** Signing on iOS from any Expo app. The vault is built from source on your Mac: `warpstack-vault-build` (needs Xcode and Rust).

Part of [Warpstack](https://github.com/daemons404/warpstack), simple, feature-complete building blocks for Farcaster clients:
users hold their own keys, Snapchain is the database, and Cloudflare runs everything. Start a
complete app with `pnpm create warpstack-app my-app`. See the
[architecture](https://github.com/daemons404/warpstack/blob/main/docs/architecture.md) and
[security](https://github.com/daemons404/warpstack/blob/main/docs/security.md) docs.

**Early and changing fast:** not independently audited; use at your own risk. Breaking changes are likely before 1.0.

MIT licensed.
