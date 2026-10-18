# Security

## Supported versions

twindex has not been published to npm yet. Once it is, only the latest release receives fixes and there is no backport to an older version.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the [Security tab](https://github.com/ExaDev/twindex/security) and select "Report a vulnerability". Do not open a public issue for a suspected vulnerability.

## Scope

- **Untrusted crosswalks and documents.** A crosswalk is data that may be authored by someone other than the caller, and `encode` and `decode` read documents the caller does not control. `parseCrosswalk` is the parse boundary, and `validateCrosswalk` rejects rule lists that cannot execute. Input that makes the executor write outside the output it is building, reach `Object.prototype`, or crash with anything other than a `TwindexError` or a Zod error from the final JSON check is a real bug to report.
- **No code execution from data.** A crosswalk contains no code. Predicates are trilean predicate trees evaluated by an evaluator with an empty function registry, so a `call` node cannot resolve to anything. Report anything that appears to cross that boundary.
- **Regular expressions in `when`.** trilean's `matches` operator compiles its right-hand operand as a live regular expression, with no timeout or complexity guard, and a `when` can carry one. A caller who accepts crosswalks from untrusted authors and evaluates them against attacker-influenced strings has a catastrophic-backtracking denial-of-service surface. This is a known limitation inherited from trilean rather than a bug to report on its own, but questions about it are welcome.
- **Supply chain.** Installs of this repository's own dependencies are held back by the minimum release age in `pnpm-workspace.yaml`. Report anything suggesting a published artifact does not match its source once releases exist.
