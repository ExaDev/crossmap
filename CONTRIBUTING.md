# Contributing

The codec is a Cargo workspace in `rust/` on the toolchain `rust/rust-toolchain.toml` pins, which rustup installs on first use. `pnpm install` at the root installs the release tooling and the npm package's development dependencies, and sets up the git hooks (`prepare: husky`). From then on:

- **Pre-commit** formats staged Rust with rustfmt (`lint-staged`).
- **commit-msg** checks the message against [Conventional Commits](https://www.conventionalcommits.org/) with commitlint. Describe the code change in the subject, not the review that prompted it.
- **Pre-push** runs `sh scripts/rust.sh fmt`, `clippy` and `test`, so a push that CI would reject on those fails locally first.

## Before opening a PR

`sh scripts/rust.sh <task>` runs cargo from `rust/` against the committed lock file and the pinned toolchain, and CI runs the same tasks: `fmt`, `clippy` (warnings denied), `test` (every crate's tests, the Rust examples of `docs/usage.md` as doctests and the schema checks among them), `conformance` (every case of the corpus, none skipped), `deny`, `schema-check`, `published-dependencies` (fails, naming it, while a path dependency of a published crate is not on crates.io), `publish-dry-run` and `packaged-schema`. `python3 -I scripts/release-version.py check` fails when the manifests disagree on the release version. CI also builds the npm package and the wheels and tests each from its installed artefact, as below.

## Constraints a change must preserve

- **Decode is the inverse of encode, by construction.** Each two-way operation implements both halves next to each other (`rust/crates/crossmap/src/ops/`), and the executor swaps `from` and `to` for decode. A new operation ships with its inverse, conformance cases for both directions and a documented condition under which the inverse holds. A lossy operation is a one-way rule, never a two-way rule with a caveat.
- **A failure is loud.** An absent `from` path, an unmapped enum value, a split part containing its separator and a value of the wrong type are all errors. The one non-failing branch is a `when` that is false or indeterminate, which skips its rule. Do not add defaults, fallbacks or pass-through for a value the crosswalk did not describe.
- **Paths are data, not code.** Keep `__proto__` out of the path grammar in every spelling (bare and quoted). Record keys and array indices are distinct step kinds in a parsed path and in every trail, so a key spelled with digits is never treated as an index. Compare paths by their canonical spelling (`canonical_path` in `rust/crates/crossmap/src/path.rs`), never by the raw string, and keep `format_path` the exact inverse of `parse_path`.
- **A document means what `JSON.parse` makes of it.** Numbers are IEEE doubles read and written as JavaScript reads and writes them, and a record keeps the key order a JavaScript object gives it. The npm and Python bindings convert to and from the crate's `Value` and nothing else, so all three packages give the same output for the same input.
- **The corpus is the specification.** `conformance/` holds language-neutral cases recorded against the original implementation, and every package runs them (`conformance/README.md`). A change to behaviour changes its cases in the same commit; an expectation is never weakened to make a change pass, and a defect fixed changes its case with the fix.
- **One schema defines the format.** `schemas/crossmap.schema.json` is committed: `sh scripts/rust.sh xtask schema` writes it from `rust/crates/crossmap/src/schema.rs`, whose fields come from the parser's own tables, and `cargo test` fails when the committed file differs from what the crate generates or from the schema published before the port (`rust/tests/fixtures/pre-port-crossmap.schema.json`). Predicates are trilean's predicate schema, referenced at the release `TRILEAN_VERSION` names rather than copied. If the schema looks wrong, fix the generator, never the file.
- **No wall-clock figures in tests or docs.** Assert structure and counts of work. `sh scripts/rust.sh bench` measures a change against a hand-written copy of the same fields, as ratios in one run on one machine.

## The npm package

`packages/crossmap` is the npm package built from the Rust workspace: `rust/bindings/crossmap-wasm` (wasm-bindgen, no input or output) compiled to wasm, with the API, the error classes and the command's Node shim beside it in `rust/bindings/crossmap-wasm/js/`. `pnpm --dir packages/crossmap run build` runs `cargo xtask npm crossmap` through `scripts/rust.sh`, which needs the `wasm-bindgen` command at the version `rust/Cargo.lock` pins (`sh scripts/rust.sh install-wasm-bindgen`) and the JSON Schema in `schemas/`, which it copies into the package. The xtask writes `packages/crossmap/dist` and `packages/crossmap/schemas` (build output, gitignored) and fails when the manifest's `./dist/` paths and the files it wrote differ.

`pnpm --dir packages/crossmap run test` packs the package with `npm pack`, checks the tarball holds exactly the published files, installs it into a fresh directory and runs `packages/crossmap/test/` there in plain Node: the conformance corpus (every kind except the JSON Schema kinds), the command's end-to-end scenarios and the API's contract. `run check:package` runs `publint` and `attw --pack --profile esm-only`, and `run check:types` typechecks the declarations.

## The Python package

`rust/bindings/crossmap-py` is the `crosswalk-codec` wheel, a PyO3 binding of the crate. It is built with `maturin build --release --locked` there and tested by installing the wheel into a fresh environment with `tests/requirements.txt` (hashed, generated from `pyproject.toml`'s `test` group by the command at its head) and running `pytest` there. The same environment runs `ruff check`, `ruff format --check` and `mypy python tests`.

## Releases

A push to `main` runs the `release` job in `ci.yml` once every check has passed. semantic-release reads the conventional commits since the last tag and computes the next version, `scripts/semantic-release-version.mjs` writes it into `rust/Cargo.toml` (which every crate and, through maturin, the wheel inherit), `rust/Cargo.lock` and `packages/crossmap/package.json` and regenerates the schema whose `$id` names it, and the release commit, `CHANGELOG.md` included, is tagged and pushed with a GitHub Release. `release.config.js` holds the commit types and the release level each triggers, and commitlint imports the same list.

The tagged commit is then built again by `artefacts.yml`, the same workflow every pull request runs: the npm package, the wheels (manylinux, musllinux, macOS and Windows) and the sdist, and the crates, each tested from its installed artefact, put through `cargo publish --dry-run`, `twine check --strict` and `npm publish --dry-run`, and checked by `scripts/verify-artefacts.py` to carry the one version and the one schema. Three jobs publish exactly those artefacts: `crossmap` and `crossmap-cli` to crates.io, `crosswalk-codec` to PyPI and `crossmap` to npm, each through OIDC trusted publishing from `ci.yml` in the `release` environment, with no stored registry token. Each skips what its registry already holds, so re-running a failed release completes it.

Never hand-bump a version or edit `CHANGELOG.md`: the next release overwrites both, and `release-version.py check` fails on a manifest that disagrees. The release commit and tag are pushed over SSH with the deploy key in the `release` environment, so a ruleset on `main` can name that key as a bypass actor.
