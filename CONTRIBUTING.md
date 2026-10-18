# Contributing

`pnpm install` sets up the git hooks (`prepare: husky`). From then on:

- **Pre-commit** lints and fixes staged TypeScript (`lint-staged`).
- **commit-msg** checks the message against [Conventional Commits](https://www.conventionalcommits.org/) with commitlint. Describe the code change in the subject, not the review that prompted it.
- **Pre-push** runs typecheck, tests and the build, so a push that CI would reject fails locally first.

## Before opening a PR

`pnpm run prepublishOnly` runs the gate CI enforces: lint, build, typecheck over both tsconfig programs, tests, `publint` and `attw --pack --profile esm-only`. The build comes before typecheck and tests because the schema generation script imports the built `dist` and the schema tests read the generated schema. CI also packs the tarball and installs it into a clean project on each supported Node line, which is the check that the exports map works for a consumer. Tests are colocated as `*.unit.test.ts`.

## Constraints a change must preserve

- **Decode is the inverse of encode, by construction.** Each two-way operation implements both halves next to each other in `src/ops/`, and the executor swaps `from` and `to` for decode. A new operation ships with its inverse, a row in the deterministic corpus (`src/corpus.ts`) and a documented condition under which the inverse holds. A lossy operation is a one-way rule, never a two-way rule with a caveat.
- **A failure is loud.** An absent `from` path, an unmapped enum value, a split part containing its separator and a value of the wrong type all throw. The one non-throwing branch is a `when` that is false or indeterminate, which skips its rule. Do not add defaults, fallbacks or pass-through for a value the crosswalk did not describe.
- **Paths are data, not code.** A document or crosswalk must never reach `Object.prototype`. Read with own-property checks and write through `setOwn` in `src/own.ts`, never `record[key]`, and keep `__proto__` out of the path grammar.
- **One schema defines the format.** The Zod schemas in `src/crosswalk.ts` are the single definition, and the JSON Schema is generated from them. Predicates are trilean's `PredicateNodeSchema`, referenced rather than copied.
- **Generated files are never hand-edited or committed.** `schemas/twindex.schema.json` and `dist/` come from `pnpm build` and are gitignored. If the generated schema looks wrong, fix the Zod schema or `scripts/generate-json-schema.ts`.
- **No wall-clock figures in tests or docs.** Assert structure and counts of work.

## Releases

There is no release workflow yet, and `package.json` stays at `0.0.0`. Do not hand-bump the version or add a publish step: releasing waits on confirming the npm name and registering trusted publishing for the repository.
