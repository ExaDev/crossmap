# Properties

The original TypeScript implementation's suite held property tests (fast-check) that a JSON fixture cannot be. This file states each one, with its generators, so an implementation writes the same property with its own library: the Rust crate's are in `rust/crates/crossmap/tests/properties.rs` (`proptest`). Each section names the original test it was stated from. A fixed seeded sample of the differential property is also in `crossmap/generated/differential.json`, so a port that has not written the property yet is still held to it.

A fixture file keeps its object keys in sorted order, so key order is not part of any recorded input. A property that depends on the key order of a record (a template's `from` record, say) is stated here as depending on it, and the sample was drawn after sorting every key, so the recorded outcome holds for the bytes a loader reads.

## The executor against the reference executor

Stated from the original `src/executor-reference.unit.test.ts`, with its naive executor in `test/support/reference-executor.ts` (one pass per rule, validation and the full output check on every call, no compilation or fusing).

**Statement.** For a generated crosswalk and a generated document, in each direction, the optimised executor and the reference executor give the same outcome: the same output, key order included (compared as the exact serialisation), or the same error class, message, rule index and path. Each run must meet every outcome kind (`output`, `absent`, `conflict`, `gap`, `operation`, `structure`, and in TypeScript `not JSON`), so the generators cannot silently stop reaching a kind.

For a port the reference executor is the port's own simplest executor, kept as a test-support oracle if the port optimises; where it has one executor, the recorded outcomes in `generated/differential.json` are the oracle.

**Documents** are drawn per run: a generated native document encoded, a generated shared document decoded, a document fitted to each side's read paths in each direction, and what encode produced decoded.

- Leaves: one of `"open"`, `"closed"`, `"x"`, `"1"`, `"2.5"`, `"2026-10-18"`, `"2026-10-18T09:30:00.000Z"`, `"true"`, `"{\"k\":1}"`, `"p,q"`, `"p-q"`, `0`, `1`, `2.5`, `-3`, `true`, `false`, `null`, so several fit an op (enum keys, number text, ISO dates, separated text, JSON text).
- Records: keys `a`, `b`, `c`, `xs`, `ys`, each optional. `a`, `b`, `c` hold a record, a leaf, or (recursively) a field; `xs` and `ys` hold a leaf or an array (length at most 3) of records or of leaves. Nesting depth at most 3.
- Fitted document: every path of a list is made present, as far as the paths agree on a shape: each key a record, each wildcard or fixed index an array of a drawn length (0 to 3), each end a drawn leaf; where two paths disagree the first placed wins.
- Odd leaves (TypeScript only, not in the fixtures): `undefined`, `NaN`, `Infinity`, a bigint, a symbol, a function, a `Date`, a null-prototype object, an object with an own `__proto__` key, an array with an extra enumerable property, an object with a symbol key, and sparse arrays. They exist to check the TypeScript executor's "output must be exact JSON" rule. A language whose document type is JSON by construction has no such case.

**Crosswalks** are `{ source, target, rules, oneWay }` with 1 to 5 two-way rules (unique by `sharePath`: no two rules share a `from` or `to` path, so most crosswalks pass validation) and 0 to 2 one-way rules. A generated rule the schema refuses (a template whose fields repeat a path, say) is dropped, not counted.

- Key paths: a key, `outer.inner`, or an array name. Arity 0 also allows `list[i].field` and `list[i]` with `i` in 0 to 2. Arity 1 paths: `list[].field`, `list[].outer.inner`, `list[]`, `outer.list[].field`, and (weight 1 to 4) `list[i].inner[].field`. Arity 2: `outer[].inner[].field` and `outer[].inner[]`. Keys are `a`, `b`, `c`, arrays are `xs`, `ys`.
- Single-path rule: one of `move` (weight 3), `scale` (factor 2, 0.5 or 1000), `enum` (`{open: OPEN, closed: CLOSED}` and its inverse), `format` (any of the five kinds), `split` (separator `,`), over a `from` and a `to` drawn from the same arity, with a `when` drawn some of the time: a whole-rule gate `compare gt (reference key) (number -1, 0 or 1)`, or, when `from` has a wildcard, a per-element gate `textCompare equals (reference list[].field) (text open, closed or x)`.
- `template`: two `from` fields (`given`, `family`) and a `to` of one arity, template `{family}-{given}`. `copy`: a `from` and two `to` paths of one arity.
- Weights: single-path 6, template 1, copy 1. Arities: 0, 1, 1, 1, 2.
- One-way rules: `drop` (arity 0, encode), `default` (arity 0, a value of `0`, `"x"`, `null` or `{nested: true}`, either direction), `aggregate` (`count`, `sum`, `min` or `max`, from an arity-1 path to an arity-0 path, either direction).

**Runs per property:** 1500. Fixtures: 303 cases, thinned to at most 70 per outcome kind, from 220 pairs per generator at seed 20261118.

**Variants.** Two crosswalk generators run the property: every rule shape (`twoWayRule`), and keyed single-path rules over one wildcard with only keys around it, gated only on the whole rule (`keyedRule`). The second exists because most real crosswalks are of that shape and it is the fused executor's fast path.

## Fused plan never gives way on a run the reference completes

Stated from the third test of the same file. Specific to the TypeScript implementation (it tested an optimisation, `src/fused.ts`). **Statement.** For keyed single-path rules, in each direction, if a fused plan exists and the reference completes on a fitted document, then running the plan gives a defined result whose serialisation equals the reference's. A port with no fused path has no obligation; one that adds a fast path should state the same property of it.

## `keep` equals explicit identity moves

Stated from the fourth test. The Rust crate holds it as `keep_equals_explicit_identity_moves`. **Statement.** A crosswalk written with a `keep` list gives the same outcome (output or error, compared structurally) as the same crosswalk with each kept path written as `{ op: "move", from: path }` appended after the other rules, in each direction, over generated documents, and each equals the reference's outcome. Kept paths are drawn from keyed arity-1 paths (weight 3), key paths (2), arity-0, arity-1 and arity-2 paths (1 each), 1 to 5 of them, so a kept path both stands alone and collides with a rule's. The outcome kinds `output`, `absent`, `structure` and `conflict` must all occur. Fixtures: the `crosswalk/keep` and `executor/omitted-to-and-keep` files pin the rewriting itself and the rule numbering; the equality of outcomes is the property.

## Corpus samples (deterministic)

Stated from the original `src/corpus.ts` and the property file's last test: for every cell of the deterministic corpus and every sample, the executor and the reference agree in both directions. This one is not random and is fully in the fixtures (`round-trip/corpus`, `round-trip/corpus-samples`).

## `isExactJson`

Stated from the original `src/exact-json.unit.test.ts`. Specific to the TypeScript implementation: the check decided whether a JavaScript value can be returned from the executor without a copy. **Statement.** For any value (generated by `fc.jsonValue()` or `fc.anything({ withBigInt, withBoxedValues, withDate, withMap, withSet, withNullPrototype, withObjectString, withSparseArray, withTypedArray, withUnicodeString })`), if `isExactJson(value)` then parsing it with trilean's `JsonValueSchema` returns a strictly equal value. Its example tests (what it accepts and refuses) concern JavaScript-only values (`NaN`, `undefined`, `BigInt`, symbols, functions, class instances, holes, hidden properties, subclasses of `Array`); a JSON document type excludes them. No fixture and no port obligation beyond "a value of the document type is always valid JSON".
