#!/bin/sh
# Runs the Rust workspace's build tasks from rust/, so they use the committed lock file and the toolchain rust/rust-toolchain.toml pins. Package scripts call this rather than cargo, as in trilean's scripts/rust.sh.
#
# Usage: rust.sh <task> [arguments]. Tasks:
#   xtask <arguments>       the repository's build tasks: `xtask npm crossmap` builds the npm package from the wasm binding
#   install-wasm-bindgen    installs the wasm-bindgen command line tool at the version Cargo.lock pins, unless that version is already installed
set -eu

cd "$(dirname "$0")/../rust"

# The pinned toolchain is installed on first use, since rustup does not install it by itself. Its output goes to stderr so stdout stays clean.
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install >&2

task=${1:-}

[ "$#" -eq 0 ] || shift

case "$task" in
  xtask) cargo run --locked --package xtask -- "$@" ;;
  install-wasm-bindgen)
    version=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)

    [ -n "$version" ] || { echo "Cargo.lock does not pin wasm-bindgen" >&2; exit 1; }

    if [ "$(wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $version" ]; then
      cargo install --locked --version "$version" wasm-bindgen-cli
    fi
    ;;
  *)
    echo "usage: rust.sh xtask|install-wasm-bindgen [arguments]" >&2
    exit 2
    ;;
esac
