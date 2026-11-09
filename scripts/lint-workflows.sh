#!/bin/sh
# Lints .github/workflows with actionlint (syntax, expressions, shell) and zizmor (security:
# injection, credential persistence, unpinned actions, dangerous triggers). Each tool is a
# release binary pinned by version and SHA-256, checked before it runs. Works on Linux x86-64
# (CI) and macOS on Apple silicon.
set -eu

ACTIONLINT=1.7.12
ZIZMOR=1.31.1

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    actionlint_asset="actionlint_${ACTIONLINT}_linux_amd64.tar.gz"
    actionlint_sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
    zizmor_asset=zizmor-x86_64-unknown-linux-gnu.tar.gz
    zizmor_sha=d185f726bdaf92df78273217dfdd24ebcd6b0ef48cf3ce776ff5762b6e138c99
    ;;
  Darwin-arm64)
    actionlint_asset="actionlint_${ACTIONLINT}_darwin_arm64.tar.gz"
    actionlint_sha=aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f
    zizmor_asset=zizmor-aarch64-apple-darwin.tar.gz
    zizmor_sha=ad5aa633cd56215b11e6c51d51f90c7e6b22904a75047d1215abbd422f61d698
    ;;
  *) echo "lint-workflows: no pinned binaries for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

bin=$(mktemp -d)
trap 'rm -rf "$bin"' EXIT

fetch() { # url sha256 → extracted into $bin
  curl -fsSL --retry 3 -o "$bin/archive.tar.gz" "$1"
  echo "$2  $bin/archive.tar.gz" | shasum -a 256 -c - >/dev/null
  tar -xzf "$bin/archive.tar.gz" -C "$bin"
  rm "$bin/archive.tar.gz"
}

fetch "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT}/${actionlint_asset}" "$actionlint_sha"
fetch "https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR}/${zizmor_asset}" "$zizmor_sha"

cd "$(dirname "$0")/.."
"$bin/actionlint" -color
# Offline: no GitHub token, and nothing it checks needs the network.
"$bin/zizmor" --offline --persona=auditor .github/workflows
