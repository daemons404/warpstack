#!/bin/sh
# Builds the Rust vault core for iOS (device and Apple-silicon simulator), generates its
# Swift bindings with uniffi, and packages both into ios/WarpstackVaultCore.xcframework,
# which ios/WarpstackVault.podspec vendors. The vault always builds from source on your
# machine; no prebuilt library is shipped. Needs Xcode and rustup: the toolchain and the two
# iOS targets are pinned in rust/rust-toolchain.toml and installed by rustup on first use.
#
# Installed as `warpstack-vault-build`. Set CARGO_TARGET_DIR to keep build output outside
# node_modules, so a reinstall doesn't start from scratch.
set -eu
cd "$(dirname "$0")"
here=$(pwd)
crate="$here/rust"
out="${CARGO_TARGET_DIR:-$crate/target}"
export CARGO_TARGET_DIR="$out"

need() { # command, what to do when it's missing
  command -v "$1" >/dev/null 2>&1 || { echo "warpstack-vault-build: $1 not found. $2" >&2; exit 1; }
}
need xcodebuild "Install Xcode from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
need rustup "Install Rust with rustup: https://rustup.rs"
need cargo "Install Rust with rustup: https://rustup.rs"

export IPHONEOS_DEPLOYMENT_TARGET=16.4
# Reproducible: no path from this machine ends up in the library (panic locations, debug info),
# so two builds of one commit match and nobody's username ships in it.
sysroot=$(cd "$crate" && rustc --print sysroot)
export RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$crate=/warpstack-vault --remap-path-prefix=$out=/target --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$sysroot=/rustc"
(cd "$crate" && cargo test --locked -q)
(cd "$crate" && cargo build --locked --release --target aarch64-apple-ios)
(cd "$crate" && cargo build --locked --release --target aarch64-apple-ios-sim)

rm -rf "$out/swift" ios/Generated ios/WarpstackVaultCore.xcframework
(cd "$crate" && cargo run --locked -q --release --features bindgen --bin uniffi-bindgen -- \
  generate "$out/aarch64-apple-ios/release/libwarpstack_vault.a" --language swift --out-dir "$out/swift")

mkdir -p ios/Generated "$out/headers"
cp "$out/swift/warpstack_vault.swift" ios/Generated/
cp "$out/swift/warpstack_vaultFFI.h" "$out/headers/"
cp "$out/swift/warpstack_vaultFFI.modulemap" "$out/headers/module.modulemap"

xcodebuild -create-xcframework \
  -library "$out/aarch64-apple-ios/release/libwarpstack_vault.a" -headers "$out/headers" \
  -library "$out/aarch64-apple-ios-sim/release/libwarpstack_vault.a" -headers "$out/headers" \
  -output ios/WarpstackVaultCore.xcframework
echo "Built ios/WarpstackVaultCore.xcframework"
