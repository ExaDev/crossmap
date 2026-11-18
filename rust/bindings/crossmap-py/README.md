# crosswalk-codec

The Python package of [crossmap](https://github.com/ExaDev/crossmap), a bidirectional crosswalk codec. One crosswalk document describes how to map between a dataset's native JSON shape and a shared target shape, and that one document derives both directions: `decode` undoes `encode` over the paths the crosswalk maps, and what cannot be undone is declared as one-way rules. The codec is the Rust crate, built into one wheel per platform against CPython's stable ABI, so a wheel installs on CPython 3.11 and every later version. The crosswalk format is documented in the [crossmap README](https://github.com/ExaDev/crossmap#the-format).

```sh
pip install crosswalk-codec
```

```python
from crosswalk_codec import assert_round_trip, decode, encode, parse_crosswalk

crosswalk = parse_crosswalk(
    {
        "source": "field-sensors/reading",
        "target": "observations/v1",
        "rules": [
            {"op": "move", "from": "rows[].sensor", "to": "observations[].deviceId"},
            {"op": "scale", "from": "rows[].depthM", "to": "observations[].depthMm", "factor": 1000},
        ],
        "oneWay": [{"op": "drop", "from": "rows[].batteryPct", "direction": "encode"}],
    }
)

table = {"rows": [{"sensor": "S-01", "depthM": 3, "batteryPct": 91}]}
encode(crosswalk, table)
# {'observations': [{'deviceId': 'S-01', 'depthMm': 3000}]}

decode(crosswalk, encode(crosswalk, table))
# {'rows': [{'sensor': 'S-01', 'depthM': 3}]}: batteryPct was declared lossy

assert_round_trip(crosswalk, [table])
```

## API

The names follow the npm package's and the Rust crate's in Python's spelling.

| Name | |
| --- | --- |
| `parse_crosswalk(document)` | Parses a crosswalk document into an immutable `Crosswalk` (`source`, `target`, `schema`, `to_dict()` for the parsed form). Raises `CrosswalkSyntaxError` carrying every issue. |
| `validate_crosswalk(crosswalk)` | The structural defects of the rule list as `CrosswalkIssue`s, empty when it can execute. |
| `encode(crosswalk, document)`, `decode(crosswalk, document)` | Translate a document in either direction. A crosswalk is validated and prepared the first time it is used and kept prepared, so translating many documents with one `Crosswalk` validates it once. |
| `compile_crosswalk(crosswalk)` | Validates and prepares now, raising `CrosswalkStructureError` here, and returns a `CompiledCrosswalk` with `encode(document)` and `decode(document)`. |
| `assert_round_trip(crosswalk, samples)` | Encodes and decodes each sample and raises `RoundTripMismatchError` at the first difference, leaving out the paths one-way rules touch. |
| `rule_sides(rule)` | The `from_` and `to` paths of a two-way rule, such as an element of `crosswalk.to_dict()["rules"]`. |
| `json_schema_text()` | The crosswalk format's JSON Schema 2020-12 document as text, byte for byte the `crossmap/schemas/crossmap.schema.json` the npm package of the same version ships. |

Every error the codec raises is a `CrossmapError`: `CrosswalkSyntaxError` and `CrosswalkStructureError` carry `issues` (`SyntaxIssue(message)`, `CrosswalkIssue(rule_index, message)`), `RuleApplicationError` carries `rule_index`, `path` and `detail`, and `RoundTripMismatchError` carries `sample_index`, `path` and `detail`. A `when` predicate that cannot be evaluated at all (a `lookup` node, or a collection that is not an array of records) raises `ValueError`, as the npm package throws a plain `Error` there.

The package installs the `crossmap` command, the same command the npm package installs, documented in the [crossmap README](https://github.com/ExaDev/crossmap#command-line).

## Documents and numbers

Documents are native Python values: `dict` with `str` keys, `list`, `str`, `int`, `float`, `bool` and `None`, and their subclasses. Anything else raises `TypeError`, naming where it is in the document: a `tuple`, a `set` or `bytes` is refused rather than turned into something else, since `decode` could not give it back. A document is converted once on the way in and once on the way out, straight to and from the codec's own value, never through JSON text, and the interpreter is released while the codec runs.

A JSON number is an IEEE double, as JavaScript's `JSON.parse` reads it, so numbers convert by their value as a double:

- An `int` is accepted when a double has exactly its value: every integer of magnitude up to 2^53, and larger ones a double holds exactly. Any other `int` raises `ValueError` rather than being rounded, where `JSON.parse` would round the same digits to the nearest double. A `float` is accepted when it is finite; NaN and the infinities raise `ValueError`, since JSON cannot write them.
- A number comes back as an `int` when it is a safe integer (integral with magnitude at most 2^53 - 1, as `Number.isSafeInteger` defines it) and as a `float` otherwise. So `3`, `3.0` and `3e0` all come back as `3`, which is what `json.loads` gives for the text `JSON.stringify` writes for each of them, and `2.5` and `1e300` come back as `float`. Negative zero comes back as the `float` `-0.0`, keeping its sign.

Records keep their key order, in the order a JavaScript object would list the same keys: keys that are array indices (`"0"`, `"17"`) first in numeric order, then the others in insertion order. A document may nest 127 arrays and records, the root included, which is as deep as the `crossmap` command reads from JSON text; deeper nesting, or a container that contains itself, raises `ValueError`.

MIT licensed.
