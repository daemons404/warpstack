# create-warpstack-app

Creates a [Warpstack](https://github.com/daemons404/warpstack) app: a Farcaster client for
iPhone and the web, and its own server on Cloudflare. Your keys stay on your phone; Snapchain is
the database.

```sh
pnpm create warpstack-app my-app
```

It asks for the app's name and iOS bundle ID in a terminal. An agent passes them as flags
(`--name "My App" --bundle-id com.yourname.myapp`); without them it stops and lists what to ask
you. For a full agent-led setup, give your agent
[this guide](https://github.com/daemons404/warpstack/blob/main/docs/setup-with-an-agent.md).
Then:

```sh
cd my-app
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` (`openssl rand -hex 32` makes a key), then run `pnpm dev`: your server and
web app on localhost, with no Cloudflare account.

Your own server: the app's `SETUP.md` (about ten minutes, then `pnpm run deploy --fid <your FID>`).
The iPhone app needs Xcode and Rust: `EXPO_PUBLIC_API_URL=<your server> pnpm run ios:release`.

**Early and changing fast:** Warpstack hasn't been independently audited. Use it at your own
risk, and expect breaking changes before 1.0.

Needs Node 22 or later and pnpm 10. MIT licensed.
