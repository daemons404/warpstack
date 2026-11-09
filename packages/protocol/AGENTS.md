# protocol (sealed core)

Branded domain types (`Fid`, `CastHash`, `Fname`, `ChannelKey`, `EventId`, `ShardIndex`, `Timestamp`), their parsers, `Result`, and Farcaster time. Since M1.5:

- `messages.ts` and `proto.ts`: `MessageData` builders for the types an app key signs, BLAKE3 message hashes and the `Message` envelope. Encodings match `@farcaster/core` byte for byte (`messages.test.ts`).
- `gasless.ts`: the FIP-272 EIP-712 digests (`KeyAdd`, `KeyRemove`, `SignedKeyRequest`) and the metadata ABI encoding, with typehashes pinned to Snapchain's and digests matched against viem (`gasless.test.ts`).
- `key-policy.ts`: the app key's posting scopes, its 30-day TTL and the key fingerprint. The phone's Rust vault holds the same constants.
- `verify.ts`: Worker-side envelope and signature checks.
- `session.ts` (M2): the session challenge preimage (`warpstack-session-v1`, a u16be length-prefixed origin, a 32-byte nonce), the origin rules, and `verifySession`. The phone's Rust core builds the same bytes.
- `phrase-guard.ts`: `looksLikePhrase`, checked wherever text could carry a recovery phrase off the device.

- This package is in the sealed core: a human approves every change, and reference vectors in protected directories can't be rewritten by an agent.
- Pure TypeScript: no Node, React Native or Workers APIs, no ambient time or randomness. Dependencies are `@noble/*` and `@scure/bip39` (its wordlist) only; `@farcaster/core` and viem are test-only references.
- Parsers return `Result`; they never throw on bad input.
