// The package's API as a consumer imports it, and what the corpus cannot state: the error class hierarchy and fields, the compile-once behaviour per crosswalk object, the JSON value contract at the boundary, and the schema export.

import { createRequire } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as crossmap from "crossmap";
import { assertRoundTrip, compileCrosswalk, CrossmapError, CrosswalkStructureError, CrosswalkSyntaxError, decode, encode, parseCrosswalk, RoundTripMismatchError, RuleApplicationError, validateCrosswalk } from "crossmap";

const require = createRequire(import.meta.url);

const consignment = parseCrosswalk({
  source: "meridian-freight/consignment",
  target: "shared/consignment/v1",
  rules: [
    { op: "move", from: "consignmentId", to: "id" },
    { op: "scale", from: "weightGrams", to: "weightKilograms", factor: 0.001 },
  ],
});

describe("the package's exports", () => {
  it("are the API and the error classes, and nothing of the binding's", () => {
    assert.deepEqual(Object.keys(crossmap).sort(), ["CrossmapError", "CrosswalkStructureError", "CrosswalkSyntaxError", "RoundTripMismatchError", "RuleApplicationError", "assertRoundTrip", "compileCrosswalk", "decode", "encode", "parseCrosswalk", "ruleSides", "validateCrosswalk"]);
  });

  it("export the JSON Schema", () => {
    const schema = require("crossmap/schemas/crossmap.schema.json");

    assert.equal(typeof schema, "object");
    assert.ok("$defs" in schema);
  });
});

describe("the error classes", () => {
  it("are one family, each named after its class and carrying the fields it was built from", () => {
    const cases = [
      [() => parseCrosswalk({ rules: "none" }), CrosswalkSyntaxError, (error) => assert.ok(error.issues.length >= 1)],
      [() => compileCrosswalk(parseCrosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "x", to: "y" }, { op: "move", from: "x", to: "z" }] })), CrosswalkStructureError, (error) => assert.ok(error.issues.every((issue) => typeof issue.ruleIndex === "number" && typeof issue.message === "string"))],
      [() => encode(consignment, {}), RuleApplicationError, (error) => assert.deepEqual([error.ruleIndex, error.path], [0, "consignmentId"])],
      [() => assertRoundTrip(parseCrosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "x" }] }), [{ x: 1, y: 2 }]), RoundTripMismatchError, (error) => assert.deepEqual([error.sampleIndex, typeof error.path], [0, "string"])],
    ];
    for (const [action, Class, check] of cases) {
      assert.throws(action, (error) => {
        assert.ok(error instanceof Class);
        assert.ok(error instanceof CrossmapError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, Class.name);
        check(error);

        return true;
      });
    }
  });

  it("build their messages as the TypeScript classes did", () => {
    assert.equal(new RuleApplicationError(2, "a.b", "absent").message, "rule 2 (a.b): absent");
    assert.equal(new RuleApplicationError(-1, "a[0]", "no rule wrote it").message, "a[0]: no rule wrote it");
    assert.equal(new RoundTripMismatchError(1, "x", "differs").message, "sample 1 (x): differs");
    assert.equal(new CrosswalkStructureError([{ ruleIndex: 0, message: "m" }, { ruleIndex: -1, message: "n" }]).message, "crosswalk structure error: rule 0: m; n");
    assert.equal(new CrosswalkSyntaxError([{ message: "a" }, { message: "b" }]).message, "crosswalk syntax error: a; b");
  });
});

describe("compileCrosswalk", () => {
  it("returns the same compiled crosswalk for the same object, which encodes and decodes as encode and decode do", () => {
    const compiled = compileCrosswalk(consignment);

    assert.equal(compileCrosswalk(consignment), compiled);
    assert.equal(compiled.crosswalk, consignment);
    const shared = compiled.encode({ consignmentId: "MF-2041", weightGrams: 1250000 });
    assert.deepEqual(shared, { id: "MF-2041", weightKilograms: 1250 });
    assert.deepEqual(compiled.decode(shared), decode(consignment, shared));
  });

  it("reads a crosswalk when it is first compiled, so a change to the object afterwards has no effect", () => {
    const crosswalk = parseCrosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "x", to: "y" }] });
    assert.deepEqual(encode(crosswalk, { x: 1 }), { y: 1 });
    crosswalk.rules[0].to = "z";

    assert.deepEqual(encode(crosswalk, { x: 1 }), { y: 1 });
  });

  it("validates as validateCrosswalk reports", () => {
    assert.deepEqual(validateCrosswalk(consignment), []);
  });
});

describe("JSON values at the boundary", () => {
  const identity = parseCrosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "v" }] });

  it("carry every JSON value, numbers as JSON.parse reads them and keys in their order", () => {
    const text = '{"v":{"z":1,"a":[0.1,1e21,-0,5e-324,"\\u00e9",true,null,{}],"__proto__":{"x":1}}}';
    const out = encode(identity, JSON.parse(text));

    assert.equal(JSON.stringify(out), JSON.stringify(JSON.parse(text)));
    assert.ok(Object.is(out.v.a[2], -0));
    assert.ok(Object.hasOwn(out.v, "__proto__"));
    assert.equal(Object.getPrototypeOf(out.v), Object.prototype);
  });

  it("accept a structured clone and a null-prototype record", () => {
    const record = Object.assign(Object.create(null), { a: 1 });

    assert.deepEqual(encode(identity, structuredClone({ v: [1, "x"] })), { v: [1, "x"] });
    assert.deepEqual(encode(identity, { v: record }), { v: { a: 1 } });
  });

  it("refuse what JSON.parse cannot return, naming where it is", () => {
    for (const [value, what] of [
      [undefined, "undefined"],
      [Number.NaN, "not finite"],
      [Number.POSITIVE_INFINITY, "not finite"],
      [10n, "a bigint"],
      [() => 1, "a function"],
      [Symbol("s"), "a symbol"],
      [new Date(0), "not a plain object"],
      [new Map(), "not a plain object"],
      ["\ud800", "a lone surrogate"],
      [[1, , 3], "a hole at index 1"],
    ]) {
      assert.throws(
        () => encode(identity, { v: value }),
        (error) => error instanceof TypeError && error.message.includes(what) && error.message.includes('["v"]'),
        String(what),
      );
    }
  });
});
