# Conformance corpus

Language-neutral cases that pin the behaviour of crossmap: the crosswalk format and its parse, the path grammar, every two-way and one-way operation, `when` gating (whole-rule and per-element), `keep`, structural validation, execution errors, round trips, the command line, and the published JSON Schema. Every implementation (the TypeScript source and the Rust port) runs the same cases, so a port is correct when it passes what the original passes. The layout and rules follow trilean's corpus (`trilean/conformance`).

## Layout

```
conformance/
  README.md                  this file
  PROPERTIES.md              the property tests a JSON fixture cannot be, stated for a port
  case.schema.json           JSON Schema of a corpus file
  manifest.json              what the corpus holds
  manifest.schema.json       JSON Schema of the manifest
  crossmap/<area>/<name>.json
  runner/                    the TypeScript runner and its self-test
  generate/                  the generator of the seeded differential sample
```

Run the corpus on TypeScript with `pnpm conformance` (a turbo task that builds first, because the JSON Schema cases read `schemas/crossmap.schema.json`, which the build writes), or `pnpm exec tsx conformance/runner/run.ts [corpus directory]` once built. `pnpm test` also runs it, and runs the runner's self-test. The runner exits non-zero on any mismatch, any corpus problem (format, schema, manifest, ids) and on an empty corpus.

## Files

Files are UTF-8 without a byte order mark and canonical JSON, which the loaders check byte for byte: keys in ascending UTF-16 code-unit order, two-space indent, one element per line, `[]` and `{}` for empty containers, numbers as `JSON.stringify` writes them, one trailing line feed. A file is `{ "cases": [...] }` with at least one case.

Because keys are sorted, **the order of an object's keys is never part of a case**, with one exception: a `run` case may carry `outputText`, the exact serialisation of the output, key order included (the generated cases do). A port that does not keep insertion order skips that check. A template rule's `from` record is read in sorted order too, so a case never depends on the order the original wrote it in.

A corpus file is `crossmap/<area>/<name>.json`. A name is lower-case ASCII letters, digits, dots, hyphens and underscores. Directories called `runner`, `generate`, `fixtures` or `schema`, and names starting with a dot, are not corpus. `manifest.json` records every corpus file with its case count and, per implementation, the sorted ids of cases marked to skip (`skip: { "ts": [], "rust": [] }`), and `generated: true` for the file the generator writes. A runner fails on any difference between the manifest and the files, and asserts from what it registers and starts that every case was either skipped as marked or executed.

## Cases

Every case has `id` (unique across the corpus), `from` (the original test title, `<test file>: <describe> > <test>`, or the source of a README or recorded behaviour; a recorded expectation says so), `kind`, and optionally `skip` (`ts` or `rust`, the implementation that does not run it) with a `reason`. Where the original test asserted less than the case records (an acceptance only, a class only), the case records the parsed form or the class, rule index and path from the TypeScript implementation and `from` says so.

Numbers are written as JSON writes them and read as `JSON.parse` reads them (IEEE doubles). Error classes are the names `CrosswalkSyntaxError`, `CrosswalkStructureError`, `RuleApplicationError` and `RoundTripMismatchError`. A syntax error's message comes from the schema library, so a case matches it only on the field names the original tests matched (`messageContains`), plus `minIssues`. A rule application error is matched on rule index and path (negative index: a failure owned by no rule) and on the message fragments the original asserted.

| kind | input | expectation |
| --- | --- | --- |
| `path-parse` | `path` | `steps` (key, index, wildcard) or a `CrosswalkSyntaxError` |
| `path-format` | `path` | the canonical spelling, which must parse back to the same steps |
| `path-read` | `document`, `path` | `found`, the `matches` (trail and value) and `empties` (trail and wildcard ordinal) of the read |
| `parse` | `crosswalk` (raw JSON) | the parsed crosswalk (defaults filled in, `keep` turned into moves, an omitted `to` filled in) or an error |
| `validate` | `crosswalk` (must parse) | the structural issues, `message` and `ruleIndex` (negative: between rules) |
| `rule-sides` | `rule` | the `from` and `to` paths of the rule |
| `error-message` | an error's class and fields | its message text |
| `run` | `crosswalk`, `direction`, `document` | the `output` (and optionally `outputText`) or an error; the input document must not be mutated |
| `round-trip` | `crosswalk`, `samples` | `ok`, or a `RoundTripMismatchError` with `sampleIndex` and `path` (or another error) |
| `cli` | `args`, `files`, `stdin`, `server` | exit status, stdout (exact, `contains`, or `stdoutJson`) and stderr (`equals`, `startsWith`, `contains`) |
| `is-url` | `argument` | whether the command reads it as a URL |
| `schema-*` | `schemas/crossmap.schema.json` (built by the TypeScript runner, committed for the Rust one) | its canonical form, its trilean reference, a JSON pointer's value, whether a rule requires `to`, and whether a document validates |

A `cli` case runs the command with `files` written into a fresh directory, `stdin` as standard input and `server` (response status, body and headers by request path) as a local HTTP server. These placeholders are replaced in `args` and in expected text: `{dir}` the directory, `{dirUrl}` its `file:` URL (as Node's `pathToFileURL` writes it, so `file:///C:/...` on Windows), `{origin}` the server's origin, `{version}` the package version. In `schema-*` cases `{trileanVersion}` and `{packageVersion}` are replaced the same way. The TypeScript runner calls `run` from `cli/run.ts` in process; another implementation runs its binary.

## Areas

`paths`, `crosswalk` (schema, parse, `keep`, rule sides), `validate`, `ops` (one file per operation), `when`, `executor` (encode, decode, path shapes, element gates, template and copy, aggregate, omitted `to`, prototype names), `round-trip`, `examples` (the README's worked examples), `cli`, `json-schema` and `generated` (a seeded sample of the differential property test; see `PROPERTIES.md`).

## Not in the corpus

Behaviours with no language-neutral expression, and so no case: the large-array memory test, the compile-once call count (`vi.mock` of `validateCrosswalk`), the fused plan's internals, `isExactJson` and the non-JSON values it guards, the `turbo.json` and `package.json` consistency checks, the platform-neutral import check, `bench/`, and the injectable size cap and timeout of `readSource`.

## Changing the corpus

A case comes from an existing test or a stated behaviour; an expectation is never weaker than the original's. A behaviour that is a defect is fixed and its case changed together, never left pinned. Edit a file, keep it canonical (the runner prints the problem), and update `manifest.json`. The generated file is rewritten with `pnpm exec tsx conformance/generate/differential.ts`.
