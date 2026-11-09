#!/bin/sh
# Publishes every package to npm, the same way from a laptop and from CI. Without --publish it
# does everything except the upload: checks, builds, packs, scans the tarballs and prints what
# it would publish.
#
#   sh scripts/publish-npm.sh              # dry run
#   sh scripts/publish-npm.sh --publish    # upload; npm asks for your 2FA code on a laptop
#
# On a laptop, point LEAK_VALUES_FROM at the checkout that holds your private values
# (.leak-patterns.local, apps/app/.env.deploy, the real database ID), so the tarball scan looks
# for them too. The publish refuses to run on a laptop without it.
#
# The first release runs from a laptop, because npm lets a package trust GitHub Actions only
# once it exists. Later releases run in .github/workflows/release.yml with trusted publishing:
# no token, and a provenance record linking each package to the commit that built it.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
publish=0
[ "${1:-}" = "--publish" ] && publish=1

# Dependencies before the packages that use them, so each one's dependencies exist when it lands.
ORDER="protocol contract wallet client api app-core ui create-warpstack-app"

fail() { echo "publish-npm: $1" >&2; exit 1; }

[ -z "$(git status --porcelain)" ] || fail "the working tree has changes; publish only a clean commit (run this in the release checkout)"
if [ -n "${CI:-}" ]; then
  # Trusted publishing (no token, with provenance) needs npm 11.5.1 or later.
  node -e 'const [a,b,c]=process.argv[1].split(".").map(Number);process.exit(a>11||(a===11&&(b>5||(b===5&&c>=1)))?0:1)' "$(npm --version)" \
    || fail "npm $(npm --version) is too old for trusted publishing; it needs 11.5.1 or later"
fi
version=$(node -p "require('./packages/protocol/package.json').version")
for p in $ORDER; do
  v=$(node -p "require('./packages/$p/package.json').version")
  [ "$v" = "$version" ] || fail "packages/$p is $v, packages/protocol is $version: release them together"
  name=$(node -p "require('./packages/$p/package.json').name")
  if npm view "$name@$version" version >/dev/null 2>&1; then fail "$name@$version is already on npm"; fi
done
if [ -n "${GITHUB_REF_NAME:-}" ] && [ "$GITHUB_REF_NAME" != "v$version" ]; then
  fail "the tag is $GITHUB_REF_NAME but the packages are $version"
fi

echo "▸ Checking $version at $(git rev-parse --short HEAD)"
pnpm install --frozen-lockfile >/dev/null
pnpm check >/dev/null 2>&1 || fail "pnpm check failed; run it to see why"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
echo "▸ Packing"
for p in $ORDER; do
  (cd "packages/$p" && pnpm pack --pack-destination "$out" >/dev/null)
done

echo "▸ Scanning the tarballs"
if [ -z "${CI:-}" ] && [ -z "${LEAK_VALUES_FROM:-}" ]; then
  fail "set LEAK_VALUES_FROM to the checkout with your private values, so the scan looks for them"
fi
mkdir "$out/x"
for t in "$out"/*.tgz; do
  mkdir "$out/x/$(basename "$t" .tgz)"
  tar -xzf "$t" -C "$out/x/$(basename "$t" .tgz)"
done
sh scripts/scan-leaks.sh "$out/x"
if grep -rlE '"(workspace|catalog):' "$out"/x/*/package/package.json; then fail "a packed package.json still has workspace: or catalog:"; fi

for p in $ORDER; do
  name=$(node -p "require('./packages/$p/package.json').name")
  t="$out/$(echo "$name" | sed 's|^@||; s|/|-|')-$version.tgz"
  [ -f "$t" ] || fail "no tarball for $name"
  if [ "$publish" = 1 ]; then
    echo "▸ Publishing $name@$version"
    npm publish "$t" --access public
  else
    echo "  would publish $name@$version ($(du -k "$t" | cut -f1) KB)"
  fi
done
[ "$publish" = 1 ] || echo "Dry run: nothing published. Run with --publish to upload."
