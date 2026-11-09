# Security

Warpstack handles Farcaster keys and recovery phrases. Please report anything that could let
someone act as a user, read their private data, or run code on a server or phone.

## Reporting

Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this
repository. Please don't open a pull request or post about it publicly.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get
an answer within 7 days. Once a fix ships, the advisory credits you unless you'd rather it
didn't.

## Scope

The most sensitive parts, where a report is most welcome:

- The vault and key stores (`packages/wallet`), including the native iOS module and the Rust
  core: anything that leaks a phrase or a key, or signs something other than what the sheet
  showed.
- Message encoding and signing (`packages/protocol`).
- Sessions and access control in the Worker (`packages/api/src/sessions.ts`,
  `user-object.ts`, `front.ts`).
- The fetchers and image pipeline (`packages/api/src/adapters/fetchers`, `media.ts`):
  server-side request forgery, or content that runs as a page.

Out of scope: the public Snapchain node and other services Warpstack talks to, and attacks
that need an unlocked phone in hand.

## Supported versions

Only the latest release gets fixes.
