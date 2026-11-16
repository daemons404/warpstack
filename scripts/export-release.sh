#!/bin/sh
# Copies the publishable part of this repository into a checkout of the release repository
# (Phase 4). Only the paths listed here are copied, so anything new stays private until
# someone adds it to the list. The copy comes from a commit (`git archive`), never from the
# working tree, so local edits and ignored files (secrets, generated configs) can't come along.
# Then it runs the leak scan on the result. It never commits or pushes. It replaces the whole
# working tree (keeping .git and LICENSE), so run it in a checkout used for nothing else.
#
#   sh scripts/export-release.sh <release checkout> [commit]     # commit defaults to HEAD
#
# With --check, it changes nothing: it compares what a commit would publish with a commit of the
# release repository (default: its origin/main) and fails on any difference, so drift between
# the two repositories shows up. Run it after a release PR merges, and before exporting.
#
#   sh scripts/export-release.sh --check <release checkout> [commit] [release ref]
set -eu

check=0
[ "${1:-}" = "--check" ] && { check=1; shift; }
dest=${1:?usage: export-release.sh [--check] <release checkout> [commit] [release ref]}
rev=${2:-HEAD}
release_ref=${3:-origin/main}
src=$(cd "$(dirname "$0")/.." && pwd)

PUBLISH="
.github
.gitignore
AGENTS.md
CODEOWNERS
CONTRIBUTING.md
NOTICE
README.md
SECURITY.md
apps
docs/architecture.md
docs/brand
docs/security.md
docs/setup-with-an-agent.md
eslint.config.js
package.json
packages
pnpm-lock.yaml
pnpm-workspace.yaml
scripts
tsconfig.base.json
tsconfig.build.base.json
vitest.config.ts
"

# Inside the published paths, what stays private. Empty for now; docs/design, docs/milestones.md
# and docs/proposals are outside the published paths.
WITHHOLD="
"

[ -d "$dest/.git" ] || { echo "export-release: $dest is not a git checkout" >&2; exit 1; }
[ -f "$dest/LICENSE" ] || { echo "export-release: $dest has no LICENSE; the release repository keeps its own" >&2; exit 1; }

commit=$(git -C "$src" rev-parse --verify "$rev^{commit}")

# The files: every tracked file under a published path, minus the withheld ones.
files=$(mktemp)
trap 'rm -f "$files"' EXIT
# shellcheck disable=SC2086 # the lists are meant to split into paths
git -C "$src" ls-tree -r --name-only "$commit" -- $PUBLISH > "$files"
for w in $WITHHOLD; do
  grep -v -e "^$w\$" -e "^$w/" "$files" > "$files.next" || true
  mv "$files.next" "$files"
done

if [ "$check" = 1 ]; then
  ours=$(mktemp -d)
  theirs=$(mktemp -d)
  trap 'rm -rf "$files" "$ours" "$theirs"' EXIT
  tr '\n' '\0' < "$files" | xargs -0 git -C "$src" archive --format=tar "$commit" -- | tar -x -C "$ours"
  git -C "$dest" archive --format=tar "$release_ref" | tar -x -C "$theirs"
  rm -f "$theirs/LICENSE"
  short=$(git -C "$src" rev-parse --short "$commit")
  if diff -rq "$ours" "$theirs" > "$files.diff"; then
    echo "export-release: $release_ref matches what $short publishes"
    rm -f "$files.diff"
  else
    sed -e "s|$ours|this repo|g" -e "s|$theirs|release|g" "$files.diff"
    rm -f "$files.diff"
    echo "export-release: $release_ref differs from what $short publishes" >&2
    exit 1
  fi
  exit 0
fi

# Everything but the release repository's own history and LICENSE goes, so a path dropped
# from the list here is dropped there too.
find "$dest" -mindepth 1 -maxdepth 1 ! -name .git ! -name LICENSE -exec rm -rf {} +
tr '\n' '\0' < "$files" | xargs -0 git -C "$src" archive --format=tar "$commit" -- | tar -x -C "$dest"

echo "export-release: copied $(wc -l < "$files" | tr -d ' ') files from $(git -C "$src" rev-parse --short "$commit") into $dest"
sh "$src/scripts/scan-leaks.sh" "$dest"
