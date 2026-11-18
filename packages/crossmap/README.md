# crossmap

A bidirectional crosswalk codec. One crosswalk document describes how to map between a dataset's native JSON shape and a shared target shape, and that one document derives both directions: `decode` undoes `encode` over the paths the crosswalk maps, and what cannot be undone is declared as one-way rules. The format, the rules and their inverses are described in the [repository's README](https://github.com/ExaDev/crossmap#readme).

This package is the Rust implementation compiled to WebAssembly, with the same API in Node (22 or later), Bun, Deno, browsers and Cloudflare Workers. It is ESM only. A rule's `when` gate is evaluated inside the module by the same trilean evaluator the Rust crate uses.

```ts
import { assertRoundTrip, decode, encode, parseCrosswalk } from "crossmap";

const crosswalk = parseCrosswalk({
  source: "meridian-freight/consignment",
  target: "shared/consignment/v1",
  rules: [
    { op: "move", from: "consignmentId", to: "id" },
    { op: "scale", from: "weightGrams", to: "weightKilograms", factor: 0.001 },
  ],
});

encode(crosswalk, { consignmentId: "MF-2041", weightGrams: 1250000 });
// { id: "MF-2041", weightKilograms: 1250 }
```

The exports are `parseCrosswalk`, `validateCrosswalk`, `compileCrosswalk`, `encode`, `decode`, `assertRoundTrip` and `ruleSides`, and the error classes `CrossmapError` and its subclasses `CrosswalkSyntaxError` (`issues`), `CrosswalkStructureError` (`issues`), `RuleApplicationError` (`ruleIndex`, `path`) and `RoundTripMismatchError` (`sampleIndex`, `path`). A `when` that cannot be evaluated at all (a `lookup` node, an absent collection) throws a plain `Error`. The JSON Schema of the format is exported as `crossmap/schemas/crossmap.schema.json`.

## JSON values at the boundary

A document, a sample and a crosswalk cross into the module as the JavaScript value itself, never as text the package serialises. A value is accepted when it is one `JSON.parse` could have returned: `null`, a boolean, a finite number, a string of well-formed UTF-16, an array without holes, or a plain object (prototype `Object.prototype` or `null`), whose own enumerable string keys are read in `Object.keys` order. A structured clone of such a value is such a value. So a number means exactly what `JSON.parse` made of its text (an IEEE double, `-0` included), and a key keeps the position JavaScript gives it.

Anything else (`undefined`, a function, a symbol, a bigint, `NaN`, an infinity, a lone surrogate, an array hole, a `Date`, a `Map`, a class instance) is refused with a `TypeError` naming where it is, rather than dropped or converted as `JSON.stringify` would, because the codec reads every value it maps. To apply a crosswalk to JSON text, parse it first with `JSON.parse`.

A result comes back as fresh plain arrays and objects, its keys in the order the codec wrote them. A member named `__proto__` is an own property, as `JSON.parse` makes it.

`parseCrosswalk` returns the parsed crosswalk as a plain object. `encode`, `decode` and `compileCrosswalk` prepare a crosswalk once per object and keep the prepared form for it, so a crosswalk object changed after it has been used keeps the behaviour it was first compiled with; parse a new one instead.

## Command line

The package installs a `crossmap` command:

```sh
npx crossmap encode crosswalk.json document.json
npx crossmap decode crosswalk.json shared.json
npx crossmap validate crosswalk.json
npx crossmap round-trip crosswalk.json samples.json
```

Any file argument can be `-` for standard input (not both at once) or an `http:`, `https:`, `data:` or `file:` URL. The command's parsing of its arguments, its codec and its messages run in the module, as in the native `crossmap` command; Node reads the files, standard input and URLs. The exit status is 0 on success, 1 when the library rejects the crosswalk or the document (the reason is on standard error), and 2 for bad usage or an argument that cannot be read or is not JSON.

MIT licensed.
