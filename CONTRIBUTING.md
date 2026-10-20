# Contributing

`pnpm install` sets up the git hooks (`prepare: husky`). From then on:

- **Pre-commit** lints and fixes staged TypeScript (`lint-staged`).
- **commit-msg** checks the message against [Conventional Commits](https://www.conventionalcommits.org/) with commitlint. Describe the code change in the subject, not the review that prompted it.
- **Pre-push** runs the `prepush` task (build, typecheck and tests, through turbo), so a push that CI would reject fails locally first.

## Before opening a PR

`pnpm run prepublishOnly` runs the gate CI enforces: lint, build, typecheck over both tsconfig programs, tests, `publint` and `attw --pack --profile esm-only`. The build comes before typecheck and tests because the schema generation script imports the built `dist` and the schema tests read the generated schema; `turbo.json` records that order, so running `pnpm typecheck` or `pnpm test` on a clean tree builds first. CI also packs the tarball and installs it into a clean project on each supported Node line, which is the check that the exports map works for a consumer. Tests are colocated as `*.unit.test.ts`.

## Constraints a change must preserve

- **Decode is the inverse of encode, by construction.** Each two-way operation implements both halves next to each other in `src/ops/`, and the executor swaps `from` and `to` for decode. A new operation ships with its inverse, a row in the deterministic corpus (`src/corpus.ts`) and a documented condition under which the inverse holds. A lossy operation is a one-way rule, never a two-way rule with a caveat.
- **A failure is loud.** An absent `from` path, an unmapped enum value, a split part containing its separator and a value of the wrong type all throw. The one non-throwing branch is a `when` that is false or indeterminate, which skips its rule. Do not add defaults, fallbacks or pass-through for a value the crosswalk did not describe.
- **Paths are data, not code.** A document or crosswalk must never reach `Object.prototype`. Read with own-property checks and write through `setOwn` in `src/own.ts`, never `record[key]`, and keep `__proto__` out of the path grammar.
- **One schema defines the format.** The Zod schemas in `src/crosswalk.ts` are the single definition, and the JSON Schema is generated from them. Predicates are trilean's `PredicateNodeSchema`, referenced rather than copied.
- **Task order and caching live in `turbo.json`.** Each task is an underscore-prefixed leaf script (`_build`, `_typecheck`, `_test`, `_lint`) and the public script of the same name is `turbo run _<task>`. Ordering is a `dependsOn` edge, never a sequence of commands in a hook, a workflow or a script, so every entry point (hook, CI, a developer's shell) gets the same order and the same cache. `src/turbo.unit.test.ts` fails when a script, task or hook drifts from this. Incremental state that lives outside turbo's task cache is restored by its own CI cache step: the lint scripts cache by file content (mtimes do not survive a checkout) and `tsc` writes its build info beside each tsconfig, which the CI typecheck job caches.
- **Generated files are never hand-edited or committed.** `schemas/twindex.schema.json` and `dist/` come from `pnpm build` and are gitignored. If the generated schema looks wrong, fix the Zod schema or `scripts/generate-json-schema.ts`.
- **No wall-clock figures in tests or docs.** Assert structure and counts of work.

## Releases

A push to `main` runs semantic-release in CI (the `release` job in `ci.yml`, whose filename is the one the npm trusted publisher is registered against). It reads the conventional commits since the last tag, bumps the version, publishes to npm through OIDC trusted publishing with provenance, tags the release, writes `CHANGELOG.md` and commits it back to `main`. `release.config.ts` holds the commit types and the release level each triggers, and commitlint imports the same list.

Never hand-bump the `package.json` version or edit `CHANGELOG.md`: both are overwritten by the next release. The job needs a GitHub-hosted runner, and the release commit is pushed with the workflow's own token, which works only while `main` has no ruleset. Adding one needs a bypass identity for that push first.
