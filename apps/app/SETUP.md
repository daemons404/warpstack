# Setting up your Warpstack

Your own Farcaster server on your own Cloudflare account, for you and the people you choose.
About 10 minutes in a browser, then one command, which you can run yourself or hand to an agent.

**What it costs:** Cloudflare's Workers Paid plan, $5 a month. A personal deployment stays
within what the plan includes. Images are optional; with them, they use Cloudflare Images'
free allowance (5,000 a month), and past it new images show as links instead, never a bill.

**What's public:** your server's address (`warpstack.<subdomain>.workers.dev`) and any image
you post. Everything else needs you to be signed in: it's private by default, and only the
Farcaster accounts you list can use it.

## Part 1: you, in the browser

These need a person: Cloudflare asks for an email, a captcha and payment details.

### 1. Make a Cloudflare account

Sign up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and verify your email.

**The email you sign up with picks your default address.** Cloudflare names your
`workers.dev` subdomain after it (for example, `alice@…` gets `alice.workers.dev`), and that
name appears in your server's public address. Check it in step 2.

### 2. Check your subdomain

Open **Compute → Workers & Pages** in the left sidebar. The **Account details** panel on the
right shows your **Subdomain** and your **Account ID**.

- If the subdomain gives away something you'd rather keep private, click the pencil icon (or go
  to `dash.cloudflare.com/<account-id>/workers/subdomain`) and pick another. Do this before you
  deploy: changing it later changes your server's address.
- Copy the **Account ID**; step 6 needs it.

### 3. Add a payment method

**Billing** (in the account menu), then add a payment method: a card or PayPal. (Cloudflare documents paying
with USDC, but on a new account in November 2026 neither the billing page nor the plan checkout
offered it. If your checkout shows **Crypto**, it works with USDC on Base.)

Adding a card doesn't change your plan; that's the next step.

### 4. Subscribe to Workers Paid

**Compute → Workers plans → Workers Paid** ($5 a month).

A new account already has a **usage-based billing alert at $10**, under **Observability →
Alerts → Platform notifications**. Check it's there and change the amount if you like. There
is no hard spending cap on Cloudflare; the alert emails you.

### 5. Optional: turn on R2, for images

**Storage & databases → R2**, and turn it on. It's where your server keeps avatars and images,
and the free allowance covers a personal server. Cloudflare requires this one click even on
Workers Paid.

Without it, everything else works and images are simply off: avatars show initials and images
show as links. Turn it on any time later and run the deploy again to add them.

### 6. Make an API token for the deploy

**My Profile → API Tokens → Create Token → Create Custom Token.** Name it `warpstack-setup`.

Under **Permission policies**, leave the scope as **Entire Account** (the Worker doesn't exist
yet, so "Specified Workers" can't be used), then search for and tick:

| Search for | Permission | Tick |
|---|---|---|
| `workers scripts` | Workers Scripts | Edit |
| `d1` | D1 | Edit |
| `r2` | Workers R2 Storage | Edit |
| `account settings` | Account Settings | Read |
| `tail` | Workers Tail | Read |

No user permissions are needed (the account ID stands in for them). Set **TTL** to 30 days.
The review page calls Edit "Write"; that's the same thing.

**Create it, and copy only the token.** The page also shows an Access Key ID, a Secret Access
Key and an S3 endpoint, because the token includes R2. You don't need them: the server reaches
R2 directly. Treat them as secret and let them go.

### 7. Hand the token over

Create `.env.deploy` in the app's folder, next to this file (git ignores it), with:

```
CLOUDFLARE_API_TOKEN=<the token>
CLOUDFLARE_ACCOUNT_ID=<the account ID from step 2>
```

Don't paste the token into a chat, an issue or a commit.

### 8. Optional: video uploads

Videos from Farcaster play without this. It lets you and the people on your list post videos,
stored on your own Cloudflare Stream. Skip it, and the app simply has no video button.

Stream is billed separately from Workers, per minute of video stored and per minute watched,
including when people on other apps watch your videos. Check Cloudflare's Stream pricing first.
To keep it small, the server takes videos of up to 2 minutes, 10 a day per person and 50 a day
in all.

1. **Media → Stream**, and turn it on.
2. **My Profile → API Tokens → Create Token → Create Custom Token.** Name it `warpstack-video`.
   Scope: **Entire Account**. Permission: **Stream → Edit**, and nothing else. This token goes
   to your server, so it must not be able to do more than Stream.
3. Add it to `.env.deploy` on a line of its own:

   ```
   STREAM_API_TOKEN=<the video token>
   ```

The deploy checks it with Stream before using it. To turn video uploads off again:
`pnpm run deploy --no-video`.

## Part 2: the deploy

Run, from the project root:

```
pnpm run deploy --fid <your FID>
```

Or tell an agent: *"Follow the app's SETUP.md, Part 2. My FID is 1234."*

`--fid` says who may use the server: your FID, or several separated by commas. To look up
the FID for a username:

```
curl -s "https://snap.farcaster.xyz:3381/v1/userNameProofByName?name=<username>"
```

(It's `pnpm run deploy`, not `pnpm deploy`: that's a built-in pnpm command.)

It prints each step:

1. Checks the token and shows the address your server will have.
2. Creates the database and applies its migrations.
3. If R2 is on: creates the image bucket and deploys the image server, on its own address.
   If not, it says images are off and carries on.
4. Generates the server's secret keys. They go straight to Cloudflare and are never shown or
   written to your project.
5. Builds the app and deploys the server.
6. Starts reading the Farcaster network and waits until it's running (up to two minutes).

Run it again any time to update: it creates only what's missing and never replaces a key that
exists (a new session key would sign everyone out).

**Then build the phone app against your server**, from the app's folder, with the command the
deploy prints. It needs Xcode and Rust: the first build compiles the vault, which takes a few
minutes.

```
EXPO_PUBLIC_API_URL=https://warpstack.<subdomain>.workers.dev pnpm run ios:release
```

and sign in with your recovery phrase. Your posts are attributed to your own FID.

### Options

| | |
|---|---|
| `--fid 1234,42` | Who may use it. Run again with a new list to add or remove people; a removed FID is signed out at once. |
| `--public` | Anyone may read and sign in, like an open Farcaster client. Not recommended for a personal server. It stays public on later deploys until you run `--private`. |
| `--private` | Back to private after `--public`: only the listed FIDs (add `--fid` if there's no list yet). |
| `--no-media` | No images, even if R2 is on: avatars show initials and images show as links. |
| `--no-video` | Turn video uploads off (step 8). Videos from Farcaster still play. |
| `--backfill-hours 2` | How much recent history a new server reads first. |

### If something goes wrong

| It says | Do this |
|---|---|
| Cloudflare refused the token | Check `.env.deploy` and the permissions in step 6. |
| Images are off | That's fine. For images: step 5, then run it again. |
| Cloudflare Stream refused STREAM_API_TOKEN | The token needs Stream: Edit, and Stream must be on (step 8). Or remove the line to deploy without video. |
| `wrangler … failed` | The lines it prints say why; most often a missing permission. Run it again after fixing. |
| Not moving yet | Wait a minute and run it again. |
| Couldn't read the secrets | Cloudflare didn't answer; nothing was changed. Run it again. |
| Images are on for this deployment, but … | R2 didn't answer. Nothing was changed; run it again, or use `--no-media` to turn images off. |

## What becomes public

- **Your server's address.** Anyone can find it, but without being on your list they get
  "sign in" and nothing else. The server's name is the `name` in `wrangler.jsonc`, so someone who
  knows your subdomain and that name can guess the address.
- **Images you post.** A posted image's address names your image server, and every Farcaster
  app loads it from there. Use a subdomain you're happy to have public, and keep it: if the
  address changes, posted images stop loading.
- **Not:** your IP address, your laptop, your Cloudflare account, your email or your billing.
