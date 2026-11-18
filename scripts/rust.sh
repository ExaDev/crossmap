#!/bin/sh
# Runs the Rust workspace's build tasks from rust/, so they use the committed lock file and the toolchain rust/rust-toolchain.toml pins. Package scripts call this rather than cargo, as in trilean's scripts/rust.sh.
#
# Usage: rust.sh <task> [arguments]. Tasks:
#   fmt                     formatting
#   clippy                  lints over every crate and target, warnings denied
#   test                    the tests of every crate, the conformance runner and the schema checks among them
#   conformance             the conformance corpus alone: fails unless every case of the manifest executes and passes, none skipped
#   deny                    cargo-deny's advisories, bans, licences and sources
#   schema-check            fails when schemas/crossmap.schema.json is not what the crate generates
#   published-dependencies  fails, naming them, while a published crate's path dependency outside the workspace is not on crates.io at its required version
#   publish-dry-run         packages the published crates (crossmap, crossmap-cli) together and builds each from its package, without uploading
#   publish                 publishes them to crates.io, with the token in CARGO_REGISTRY_TOKEN
#   packaged-schema         prints the schema the packaged crossmap crate generates, built from its .crate file alone (run publish-dry-run first)
#   xtask <arguments>       the repository's build tasks: `xtask npm crossmap` builds the npm package from the wasm binding, `xtask schema` writes the schema
#   install-wasm-bindgen    installs the wasm-bindgen command line tool at the version Cargo.lock pins, unless that version is already installed
set -eu

cd "$(dirname "$0")/../rust"

# The pinned toolchain is installed on first use, since rustup does not install it by itself. Its output goes to stderr so stdout stays clean.
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install >&2

task=${1:-}

[ "$#" -eq 0 ] || shift

# The crates published to crates.io, in dependency order. The bindings and the test and build crates are not published.
crates="crossmap crossmap-cli"
# shellcheck disable=SC2086 # $crates is a list of names.
published=$(printf -- '--package %s ' $crates)

case "$task" in
  fmt) cargo fmt --all --check ;;
  clippy) cargo clippy --locked --workspace --all-targets -- -D warnings ;;
  test) cargo test --locked --workspace ;;
  conformance)
    summary=$(cargo test --locked --package crossmap-conformance --test conformance) || { printf '%s\n' "$summary"; exit 1; }
    printf '%s\n' "$summary"
    # The runner already fails on a failing case, a corpus problem or a case it did not run; this also refuses a case the corpus marks to skip for Rust.
    printf '%s\n' "$summary" | grep -q ' executed, 0 skipped as marked, 0 failed, 0 corpus problems$' || { echo "conformance: not every case executed" >&2; exit 1; }
    ;;
  deny) cargo deny --locked check ;;
  schema-check) cargo run --locked --package xtask -- schema --check ;;
  published-dependencies)
    # shellcheck disable=SC2086 # $crates is a list of names.
    cargo metadata --locked --no-deps --format-version 1 | python3 -I ../scripts/published-dependencies.py $crates
    ;;
  publish-dry-run)
    # shellcheck disable=SC2086 # $published is a list of arguments.
    cargo publish --locked --dry-run $published
    ;;
  publish)
    # shellcheck disable=SC2086 # $published is a list of arguments.
    cargo publish --locked $published
    ;;
  packaged-schema)
    version=$(cargo metadata --locked --no-deps --format-version 1 | python3 -I -c 'import json, sys; print(next(p["version"] for p in json.load(sys.stdin)["packages"] if p["name"] == "crossmap"))')
    crate="$PWD/target/package/crossmap-$version.crate"
    [ -f "$crate" ] || { echo "$crate does not exist; run rust.sh publish-dry-run first" >&2; exit 1; }
    unpacked=$(mktemp -d)
    trap 'rm -rf "$unpacked"' EXIT
    tar -xzf "$crate" -C "$unpacked"
    # Outside this workspace, so cargo builds the package as crates.io users get it; the shared target directory only saves rebuilding its dependencies.
    CARGO_TARGET_DIR="$PWD/target/packaged" cargo run --quiet --locked --manifest-path "$unpacked/crossmap-$version/Cargo.toml" --example json-schema
    ;;
  xtask) cargo run --locked --package xtask -- "$@" ;;
  install-wasm-bindgen)
    version=$(awk '/^name = "wasm-bindgen"$/ { getline; gsub(/version = |"/, ""); print; exit }' Cargo.lock)

    [ -n "$version" ] || { echo "Cargo.lock does not pin wasm-bindgen" >&2; exit 1; }

    if [ "$(wasm-bindgen --version 2>/dev/null)" != "wasm-bindgen $version" ]; then
      cargo install --locked --version "$version" wasm-bindgen-cli
    fi
    ;;
  *)
    echo "usage: rust.sh fmt|clippy|test|conformance|deny|schema-check|published-dependencies|publish-dry-run|publish|packaged-schema|xtask|install-wasm-bindgen [arguments]" >&2
    exit 2
    ;;
esac
