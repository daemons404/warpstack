#!/bin/sh
# Fails if a tree holds something that must never be published (Phase 4): local paths, private
# links, keys and tokens, real deployment IDs, or files that stay private. Runs on the release
# export before every commit, and in CI on every PR.
#
#   sh scripts/scan-leaks.sh [dir]        # default: the repository root
#
# Patterns here are public. The deployment's real values (the Cloudflare account ID and API
# token in apps/app/.env.deploy, the D1 ID in a local wrangler.jsonc) are read from those
# gitignored files at scan time and matched as plain strings, never copied anywhere. Other
# private strings (a personal FID, a username) go one regex per line in .leak-patterns.local
# (gitignored) at this repo's root. LEAK_VALUES_FROM=<checkout> reads those private values from
# another checkout instead, e.g. to scan from a clean release checkout that has none of them.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-$root}
cd "$dir"
found=0
fail() { echo "  ✗ $1" >&2; found=1; }

# Files that are tracked in the private working repo but must never be published.
for p in .agents videos docs/proposals docs/design docs/milestones.md .env .env.deploy apps/app/.env.deploy apps/app/.dev.vars apps/app/wrangler.deploy.jsonc .leak-patterns.local; do
  [ -e "$p" ] && fail "$p must not be published"
done
find . -path ./node_modules -prune -o -path ./.git -prune -o \( -name '*.pem' -o -name '*.p8' -o -name '*.p12' -o -name '*.mobileprovision' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '.DS_Store' \) -print | while read -r f; do
  echo "  ✗ $f must not be published" >&2
done | grep -q . && found=1

patterns=$(mktemp)
trap 'rm -f "$patterns"' EXIT
cat > "$patterns" <<'EOF'
/Users/[A-Za-z]
/home/[a-z][a-z0-9_-]*/
claude\.ai/(code|chat|project|artifact)
-----BEGIN [A-Z ]*PRIVATE KEY-----
ghp_[A-Za-z0-9]{36}
github_pat_[A-Za-z0-9_]{40,}
sk-ant-[A-Za-z0-9_-]{20,}
AKIA[0-9A-Z]{16}
xox[baprs]-[A-Za-z0-9-]{10,}
CLOUDFLARE_API_TOKEN=[A-Za-z0-9_-]{20,}
"database_id": "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
EOF
values=${LEAK_VALUES_FROM:-$root}
[ -f "$values/.leak-patterns.local" ] && grep -v '^[[:space:]]*\(#\|$\)' "$values/.leak-patterns.local" >> "$patterns"

# The deployment's own values, as fixed strings, kept only in this temporary file.
literals=$(mktemp)
trap 'rm -f "$patterns" "$literals"' EXIT
if [ -f "$values/apps/app/.env.deploy" ]; then
  sed -nE 's/^[[:space:]]*CLOUDFLARE_(ACCOUNT_ID|API_TOKEN)[[:space:]]*=[[:space:]]*["'"'"']?([^"'"'"' ]{8,}).*/\2/p' "$values/apps/app/.env.deploy" >> "$literals"
fi
if [ -f "$values/apps/app/wrangler.jsonc" ]; then
  grep -oE '"database_id": "[0-9a-f-]{36}"' "$values/apps/app/wrangler.jsonc" | grep -oE '[0-9a-f-]{36}' | grep -v '^00000000-' >> "$literals" || true
fi

# The all-zero database ID is the committed placeholder, so it's allowed.
hits=$(grep -rInE -f "$patterns" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=dist \
  --exclude-dir=.expo --exclude-dir=.wrangler --exclude-dir=ios --exclude-dir=android --exclude=scan-leaks.sh . 2>/dev/null \
  | grep -v '"database_id": "00000000-0000-0000-0000-000000000000"' || true)
echo "scan-leaks: $(wc -l < "$literals" | tr -d ' ') deployment value(s) to look for"
if [ -s "$literals" ]; then
  more=$(grep -rInF -f "$literals" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target --exclude-dir=dist \
    --exclude-dir=.expo --exclude-dir=.wrangler --exclude-dir=ios --exclude-dir=android . 2>/dev/null || true)
  hits=$(printf '%s\n%s' "$hits" "$more" | grep . || true)
fi
if [ -n "$hits" ]; then
  # Show where, not what: the match itself may be the secret.
  printf "%s\n" "$hits" | cut -d: -f1,2 | sed 's/^/  ✗ leak at /' >&2
  found=1
fi

if [ "$found" = 1 ]; then
  echo "scan-leaks: found something that must not be published in $dir" >&2
  exit 1
fi
echo "scan-leaks: clean ($dir)"
