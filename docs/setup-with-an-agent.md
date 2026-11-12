# Set up Warpstack with an agent

Give this page to a coding agent (Claude Code, Codex, Cursor or another) with a message like:

> Set up a Warpstack app for me by following
> https://github.com/daemons404/warpstack/blob/main/docs/setup-with-an-agent.md

The rest of this page is written to the agent.

---

You're setting up a Warpstack app for the person you're working with: a Farcaster client for
iPhone and the web, and its own server on their Cloudflare account. Work through the steps in
order, tell them what you're doing as you go, and stop where a step needs them.

## Rules

- **Ask; don't decide for them.** Names, who can use the server, and what gets set up are
  theirs to choose. If an answer is missing, ask again rather than using a default.
- **Never ask for, read or handle a recovery phrase.** It's typed only into the phone app's own
  screen. If they offer it to you, tell them not to.
- **Never print, copy or open `.env.deploy`.** It holds their Cloudflare token. They create it
  themselves; you only check that it exists.
- **Don't expose their machine.** No tunnels, and nothing listening beyond `localhost`, unless
  they ask for it.
- **Keep the server private** (only the Farcaster accounts they list) unless they explicitly
  ask for a public one.

## Step 1: ask everything first

Before running anything, ask these together, in one message, and wait for the answers:

1. **What should the app be called?** It's the name on the home screen: up to 30 characters.
2. **What folder should it go in?** Suggest one based on the name, like `~/code/my-app`.
3. **What iOS bundle ID?** It looks like `com.yourname.myapp`: two or more parts separated by
   dots, each starting with a letter, letters and digits only. It must be one they're happy to
   keep; suggest one from their name and the app's.
4. **What's your Farcaster username?** You'll look up their FID from it.
5. **Who should be able to use the server?** Only them (the default), a few people (ask for
   their usernames too), or anyone (a public client; not recommended for a personal server).
6. **Do you have a Cloudflare account?** If not, they'll make one during setup: about ten
   minutes in a browser, which only they can do. It needs Workers Paid, $5 a month.
7. **Do you want the iPhone app now?** It needs a Mac with Xcode, an Apple ID and an iPhone with
   a cable. Without them, they can start with the server and the web app (read-only) and add
   the phone later.

Look up each FID from a username, and confirm it with them before using it:

```sh
curl -s "https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=<username>"
```

The `fid` field is the FID.

## Step 2: check the tools

- **Node 22 or later** (`node --version`) and **pnpm 10** (`pnpm --version`). If pnpm is
  missing, ask before installing it (`corepack enable pnpm` or `npm install -g pnpm`).
- **For the iPhone app only:** Xcode (`xcodebuild -version`) and Rust (`rustup --version`). If
  Rust is missing, ask before installing it from https://rustup.rs. If Xcode is missing, they
  install it from the App Store and open it once; that's theirs to do.

## Step 3: create the app

With their answers:

```sh
pnpm create warpstack-app <folder> --name "<app name>" --bundle-id <bundle ID>
```

Then read the new project's `AGENTS.md` before changing anything in it.

## Step 4: run it on this machine

No Cloudflare account needed. In the app's folder, create `.dev.vars` from
`.dev.vars.example`:

- `CURSOR_MAC_KEY` and `SESSION_MAC_KEY`: a new key each, from `openssl rand -hex 32`. Write
  them straight into the file; don't print them.
- `ALLOWED_FIDS`: the FIDs from step 1, separated by commas.
- Leave `CANONICAL_ORIGIN` as `http://localhost:8787`.

Then run `pnpm dev`, wait until it's ready, and tell them to open http://localhost:8787. It
fills in recent casts over a minute or two. Images are off locally: avatars show initials.

## Step 5: their own server

1. If they have no Cloudflare setup yet, walk them through **Part 1 of the app's `SETUP.md`**,
   one step at a time. It needs them in a browser: sign-up, payment, the API token.
2. They create `.env.deploy` in the app's folder themselves, with the token and account ID, as
   `SETUP.md` step 7 says. Check only that it has both lines, without showing values:
   `grep -c '^CLOUDFLARE_' .env.deploy` should print `2`.
   Ask whether they want to post videos too. It's optional and billed by Cloudflare per minute
   stored and watched: if yes, they follow `SETUP.md` step 8 themselves, which adds a second,
   Stream-only token to `.env.deploy`. Check it the same way: `grep -c '^STREAM_API_TOKEN=' .env.deploy`.
3. Deploy, with the FIDs from step 1:

   ```sh
   pnpm run deploy --fid <FID>[,<FID>...]
   ```

   It prints each step and ends with the server's address. If it stops, its message says why;
   most often it's a permission missing from the token. Running it again is always safe.

## Step 6: the iPhone app

Only if they said yes in step 1.

1. They sign in to Xcode with their Apple ID (Xcode → Settings → Accounts), plug in the iPhone,
   and turn on Developer Mode on it (Settings → Privacy & Security → Developer Mode).
2. In the app's folder:

   ```sh
   EXPO_PUBLIC_API_URL=<the server's address from step 5> pnpm run ios:release
   ```

   The first build compiles the vault from source: several minutes.
3. If Expo says no signing team is set, they open `ios/*.xcworkspace` in Xcode, choose the app
   target → Signing & Capabilities → Team → their Apple ID, and you run the command again.
4. With a free Apple ID, they trust the developer on the phone the first time (Settings →
   General → VPN & Device Management) and rebuild every 7 days.
5. They sign in on the phone by typing their recovery phrase into the app's own screen. Remind
   them it never leaves the phone, and an agent never needs it.

## Finish

Summarize the result: the app's folder, the server's address, and who can use it. Then how to update: `pnpm run deploy` again after a change, and the iPhone rebuild every
7 days with a free Apple ID. Point them to the app's `SETUP.md` and `AGENTS.md` for later.
