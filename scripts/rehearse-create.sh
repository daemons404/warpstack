#!/bin/sh
# Rehearses `create-warpstack-app` as a user would meet it, before anything is on npm: packs
# every @warpstack package, generates an app outside this repo that installs from those
# tarballs, then typechecks it, builds the web app, applies the database migrations locally and
# dry-runs the Worker deploy. Nothing listens on a port and nothing needs a Cloudflare account.
#
#   sh scripts/rehearse-create.sh [work folder] [--ios]      (CI runs it without --ios: check.yml)
#
# --ios also builds the vault from the installed package (needs Xcode and Rust; minutes).
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
work=""
ios=false
for a in "$@"; do
  case "$a" in
    --ios) ios=true ;;
    *) work=$a ;;
  esac
done
work=${work:-$(mktemp -d "${TMPDIR:-/tmp}/warpstack-rehearsal.XXXXXX")}
case "$work" in
  "$root"|"$root"/*) echo "rehearse-create: the work folder must be outside the repo, or pnpm treats the app as part of the workspace" >&2; exit 1 ;;
esac
mkdir -p "$work"
work=$(cd "$work" && pwd)
rm -rf "$work/tarballs" "$work/app" "$work/worker"

step() { printf '\n▸ %s\n' "$1"; }

step "Packing the packages into $work/tarballs"
for dir in "$root"/packages/*/; do
  name=$(node -p "require('$dir/package.json').name")
  case "$name" in @warpstack/*) ;; *) continue ;; esac
  (cd "$dir" && pnpm pack --pack-destination "$work/tarballs" >/dev/null)
  echo "  $name"
done

step "Building create-warpstack-app"
(cd "$root/packages/create-warpstack-app" && pnpm run build >/dev/null)

step "Generating the app"
node "$root/packages/create-warpstack-app/dist/index.js" "$work/app" --yes --name Rehearsal --tarballs "$work/tarballs"

cd "$work/app"
step "Typechecking"
pnpm typecheck
step "Building the web app"
pnpm run build:web >/dev/null
echo "  Built"
step "Applying the migrations to a local database"
node scripts/offline-config.mjs
CI=1 # CI=1: apply without asking, even in a terminal.
CI=1 pnpm exec wrangler d1 migrations apply DB --local -c wrangler.offline.jsonc
step "Dry-running the Worker deploy"
CI=1 CI=1 pnpm exec wrangler deploy --dry-run --outdir "$work/worker" -c wrangler.jsonc

if $ios; then
  step "Building the vault from the installed package"
  CARGO_TARGET_DIR="$work/cargo-target" pnpm exec warpstack-vault-build
fi

step "Rehearsal passed"
echo "  The app is in $work/app"
