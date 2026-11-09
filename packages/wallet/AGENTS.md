# wallet (sealed core)

The identity vault and the app key stores. A human approves every change here, and to the vectors the tests hold.

The phone's **transient vault and app key** (M1.6):

- `native/rust` is the core, exposed to Swift through uniffi. It turns the phrase into one gasless `KeyAdd` (with its `SignedKeyRequest`) for this phone's own key, given its public key, with scopes and TTL fixed in Rust, or one `KeyRemove`. It checks every app key signature against its purpose by decoding the `MessageData` bytes it signs. Session challenges (M2, `app_key_sign_session`) are the one non-message signature: Rust builds `"warpstack-session-v1" ‖ u16be(len) ‖ origin ‖ nonce` itself from an origin it checks and a 32-byte nonce, matching `protocol/src/session.ts`. Only `app_key_sign` and `app_key_public_key` see the app key's seed.
- `native/ios` is the Expo module: the seed lives in one Keychain item (this device only, only while a passcode is set), with a second one, `next`, only while a renewal's replacement key waits for the vault. Each record is wrapped with a Secure Enclave P-256 key (ECIES, X9.63 SHA-256, AES-GCM) that never leaves the chip; the Simulator makes the same key in software, and records from before wrapping are wrapped when first read. The sheet is native, and JavaScript gets public keys and signatures, never the seed or the phrase. The phrase is typed a word at a time into key-input boxes that store nothing: each keystroke goes to Rust's `PhraseBuffer` (`rust/src/phrase.rs`), which holds the words in wiped buffers, answers each word's length and BIP-39 status, and is what `approve_key_add` and `approve_key_remove` read. No function takes the phrase as bytes from Swift.
- `src/native/` wraps the module for `client`.
- `vectors/native.json` holds the reference vectors. `src/native/vectors.test.ts` rebuilds them from viem, `@farcaster/core` and noble, and `native/rust/tests/vectors.rs` checks the Rust core signs the same bytes. Run the Rust tests with `pnpm --filter @warpstack/wallet test:native`; `build:ios` builds the XCFramework (needs Xcode).

Browsers have no key store: they stay read-only until they can be linked from the phone.

Rules:

- Nothing here may sign an IdRegistry transfer, a recovery change, or arbitrary typed data. Adding a signable operation is a design change: propose it first.
- Lint is a tripwire, not a sandbox: it bans network globals, `process`, `node:*`, `fs`, sockets and `child_process` in the TypeScript of `wallet` and `protocol`.
- Renewal adds before it forgets: `create` while a key is registered makes its replacement in `next`, for the same FID only; the current key keeps signing; `activate` writes the new key over the current one in one update, then drops `next`. `clear` of the current key drops both.
- The key store never loses a key it can't read: a locked Keychain or a record from a newer app version is an error, not an empty store; only an item with no readable record is replaced (by a new sign-in) or removed (by `clear`). Writes replace the item in one `SecItemUpdate`, never delete-then-add. Records carry a format number `v`.
- Native code trusts nothing JavaScript passes: hex is `0x` plus hex digits only, keys are compared as bytes, and numbers are range-checked before conversion, never trapped on.
- Zeroing is best-effort. Rust wipes its buffers, but the one-character string iOS hands over per keystroke, a pasted phrase as the pasteboard gives it, uniffi's transfer buffers and library-internal copies (BIP-39 derivation) can't be wiped.
- Dependencies need a human's approval. The TypeScript has none beyond `protocol`. In Rust: alloy (`alloy-primitives`, `alloy-sol-types`, `alloy-signer`, `alloy-signer-local` with its BIP-39/32 support), `ed25519-dalek`, `blake3`, `zeroize` and `uniffi`, pinned exactly in `Cargo.toml`, with every locked crate at least 7 days old when added, and one pinned toolchain (`rust-toolchain.toml`).
- The Rust core does no I/O: no files, network, clock or randomness. The Swift layer supplies the time and the seed.
- CI checks the Rust core on every change to it: `cargo fmt --check`, clippy with `-D warnings`, the tests and vectors, and `cargo deny check` against `native/rust/deny.toml` (advisories, licenses, no network or async crates, crates.io only). `.github/workflows/swift.yml` builds the module and the app for the Simulator on macOS.
- The vault always builds from source on the builder's machine; no prebuilt library is published. The npm package ships the Rust source, the Swift, `vectors/` (the Rust tests read them) and `build-ios.sh`, installed as the `warpstack-vault-build` command. Set `CARGO_TARGET_DIR` outside `node_modules` to keep builds incremental across reinstalls. Never add the XCFramework or `ios/Generated` to `files`.
- `build-ios.sh` remaps every local path (`--remap-path-prefix`), so the library holds no path from the machine that built it and two builds of one commit match byte for byte.
