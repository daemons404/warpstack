# Security and sovereignty

Warpstack's promise is that you own your account and your client. No company can sign as you,
switch you off or read your keys, including the person who runs your server. This page explains
the choices behind that promise, what each part is trusted with, and where the limits are. It
describes the code as it is today. To report a vulnerability, see [`SECURITY.md`](../SECURITY.md).

## The short version

- **Your keys stay on your phone.** The server holds no key that can post, follow or change
  your account.
- **Your server is yours.** It runs on your own Cloudflare account, or on your laptop with no
  account at all. Snapchain, Farcaster's own network, is the database.
- **The dangerous code is small and guarded.** The parts where a bug could cost someone their
  account are the sealed core: a human approves every change there.

## Keys

A Farcaster account has two kinds of key, and Warpstack keeps them apart.

| Key | What it can do | Where it lives | When it's used |
| --- | --- | --- | --- |
| **Recovery phrase** (custody) | Everything: add and remove keys, transfer the account | Nowhere. You type it, it signs, it's wiped | Once per sign-in, and to remove a key |
| **App key** (Ed25519) | Post, reply, like, recast, follow. Nothing else | The phone's Keychain, wrapped by the Secure Enclave | Every action, and to open a server session |

The app key is registered with only the posting scopes it needs and expires 30 days after its
last use: every signed message pushes the expiry forward, so a key in use never lapses. After a
month without posting, the app offers to renew it in the three days before it expires. Losing the phone or the app key
never costs the account: the phrase can remove the key from any other app.

## Why the vault is on the phone

A recovery phrase is the whole account, so where it's typed matters most. A phone gives three
things a browser or a server can't:

- **A native screen JavaScript can't read.** The phrase is typed into a native sheet, one word
  per box. Each keystroke goes straight into Rust. The app's JavaScript never sees the phrase,
  so a compromised app bundle can't steal it.
- **Hardware-backed storage.** The app key's seed sits in the Keychain, this device only, and
  only while the phone has a passcode. Each record is also encrypted to a P-256 key inside the
  Secure Enclave, which never leaves the chip. The Enclave can't hold an Ed25519 key, so it
  wraps one instead.
- **Code signing.** The phone runs a signed build. The web has no equivalent, which is why
  browsers are read-only until they can be linked from the phone.

The vault is **transient**: the phrase is used once to register the app key, then wiped. It's
also wiped on cancel and when the app leaves the foreground. There is no way to reveal it.

## Why Rust

Everything that touches the phrase or signs is in Rust, called from Swift through uniffi:

- **Memory you can wipe.** The phrase lives in preallocated buffers that are zeroed after use.
  JavaScript and Swift strings can't be reliably wiped.
- **One audited signing library.** The Rust core is built on alloy, a widely used Ethereum
  library, rather than hand-written cryptography.
- **No I/O.** The vault makes no network calls and has no async runtime; `cargo-deny` keeps
  networking crates out of its dependency tree.
- **Decode, don't trust.** Before signing a post, Rust decodes the exact bytes it will sign and
  checks the message type is a posting type and the FID is the stored one. The scopes and
  expiry of a new key are constants in Rust, not inputs from JavaScript.
- **Reproducible.** Dependencies and the toolchain are pinned exactly, and the build strips
  local paths, so the same source builds the same library byte for byte.

## What can go wrong, and what it can do

**A compromised app bundle** (malicious JavaScript in the app) can post as you, as any posting
key can, and can open the sign-in or remove-key sheet, which names what it's about to do. It
can't see the phrase, read the app key's seed, get a signature for a different key, scope or
expiry, or touch account ownership.

**A hostile or compromised server** is still trusted for what you see, but not for what you do.

| It can | It can't | Why |
| --- | --- | --- |
| Hide, reorder or invent casts; misreport counts | Post, like or follow as you | Every write is signed on the phone, and Snapchain checks the signature |
| Drop or invent notifications | Make a notification do anything | Notifications are display data |
| Serve the wrong image | Change the image a signed cast links to | The URL is inside the signed message |
| Misreport which keys you have | Add or remove a key | Key changes are signed by your phrase or the key itself |
| Point an action at the wrong target: show one cast under another cast's ID, or one person under another's FID, so your like, recast, reply, unfollow or delete lands on that one | Make you sign anything but the action you chose, as you | The phone signs the action you tapped for the ID the server gave it; it can't check that ID against what was on screen |
| Read what it stores for you: your sessions, notifications and history | Read your keys, phrase, drafts or followed channels | They never leave the phone |

**A stolen server session** lets someone read what the server shows you. It can't post: writes
need a signature from the app key. Sessions last 24 hours, are stored only as hashes, and end
when the key is removed.

## Running your own server

Your server is a Cloudflare Worker on your account. You're trusting Cloudflare to run it, and
you can move: the same code runs locally on Miniflare, and everything it stores is a cache it
can rebuild from Snapchain, except the per-user state listed above.

- **Private by default.** A deployment must say who may use it (`ALLOWED_FIDS`, or
  `ACCESS=public`). The Worker refuses to start otherwise. On a private deployment every read
  needs a session.
- **Not an open relay.** Writes need a session whose FID matches the message. The one exception
  is registering a key, which is signed by the account's recovery phrase.
- **Few secrets.** The server holds two MAC keys (for cursors and sessions) and optionally a
  media key. None of them can act as a user. The deploy never rotates them silently.
- **If your Cloudflare account is compromised,** an attacker controls what you see and can read
  the per-user state, as in the table above. They can't sign as you. Remove the deployment and
  your keys still work with any other Farcaster app.

## Untrusted content

Links and images in casts are chosen by whoever posted them. A phone never loads one directly,
so posting a link can't reveal your IP address or deliver an exploit:

- **One restricted fetcher** (sealed) fetches every attacker-chosen URL: https on port 443
  only, no IP literals or internal names, redirects checked one by one, a 3-second deadline, a
  byte cap, and nothing of ours sent along.
- **Every image is re-encoded** by Cloudflare before any phone sees it. Anything that doesn't
  come back as plain WebP is refused. Without Cloudflare's image service, images are off: links
  and initials only.
- **Images are served from a separate origin,** so they can't run in the API's context.
- **Uploads are treated the same way,** after the phone strips location and camera metadata.

## The sealed core

These paths are where a mistake could cost someone their account. A human approves every
change, and CODEOWNERS requires it:

- `packages/protocol`: message building, hashing and verification.
- `packages/wallet`: the Rust vault, the iOS key store, and the reference vectors.
- `packages/api/src/adapters/fetchers`: the restricted fetcher, image checks and link previews.

The sealed code is tested against reference vectors rebuilt from independent implementations
(viem, `@farcaster/core`, noble). The Rust core must sign identical bytes.

## The supply chain

- **Few dependencies, pinned.** One library per job. A new npm package or Rust crate must be at
  least 7 days old, which CI checks on every PR.
- **CI can't be turned against the repository.** Workflows run on `pull_request` with a
  read-only token and no secrets. Actions are pinned to a full commit. actionlint and zizmor
  check the workflows themselves.
- **Signed history.** Commits on `main` must be signed, and every change goes through a
  reviewed pull request.
- **Nothing private is published.** A leak scan in CI fails on local paths, keys, tokens and
  real deployment IDs.

## Known limits

- **No Face ID yet.** Typing the phrase is the authorization for a sign-in.
- **iOS only.** Browsers are read-only, and there is no Android vault yet.
- **Swift briefly holds keystrokes.** iOS hands each typed character to Swift as a string, and
  a pasted phrase passes through the pasteboard. Neither can be wiped. Paste empties the
  pasteboard afterwards.
- **Free Apple ID builds expire after 7 days,** so the app must be rebuilt each week.
- **Channel names and your followed channels** come from Farcaster's hosted API, because
  channels aren't on Snapchain yet.
