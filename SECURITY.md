# Security

## Supported versions

Only the latest release receives fixes, and there is no backport to an older version. Every release publishes the `crossmap` and `crossmap-cli` crates, the `crossmap` npm package and the `crosswalk-codec` Python package at one version, so a fix reaches all of them together.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the [Security tab](https://github.com/ExaDev/crossmap/security) and select "Report a vulnerability". Do not open a public issue for a suspected vulnerability.

## Scope

- **Untrusted crosswalks and documents.** A crosswalk is data that may be authored by someone other than the caller, and `encode` and `decode` read documents the caller does not control. `parseCrosswalk` is the parse boundary, and `validateCrosswalk` rejects rule lists that cannot execute. Input that makes the executor write outside the output it is building, reach a JavaScript object's prototype, panic in Rust, or fail with anything other than a `CrossmapError` (or, in the npm and Python packages, the `TypeError` or `ValueError` that refuses a value that is not JSON) is a real bug to report.
- **No code execution from data.** A crosswalk contains no code. Predicates are trilean predicate trees evaluated by trilean's evaluator, to which crossmap provides no function, so a `call` node cannot resolve to anything. Report anything that appears to cross that boundary.
- **Regular expressions in `when`.** trilean's `matches` operator compiles its right-hand operand with trilean's own regular-expression matcher, which never backtracks and bounds the input length and the work of one match, so a pattern in a crosswalk cannot make evaluation arbitrarily expensive. A pattern or input that gets past those bounds is a bug to report.
- **Remote reads by the command.** The `crossmap` command fetches `http:` and `https:` arguments with a timeout and a cap on the body's size, and refuses every scheme it does not read. A way to make it read past either bound, or reach a scheme it refuses, is a bug to report.
- **Supply chain.** The crates' dependencies are held to the allowlist, licences, sources and advisories in `rust/deny.toml`, and installs of the npm tooling are held back by the minimum release age in `pnpm-workspace.yaml`. Every published artefact is built and published by the repository's release workflow through trusted publishing, with no stored registry token. Report anything suggesting a published artefact does not match its source.
