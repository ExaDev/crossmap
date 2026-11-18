// The package's API over the wasm binding. A crosswalk is the plain object `parseCrosswalk` returns (or any value that parses as one); the binding parses it into a `Codec` the first time a crosswalk object is compiled, and the codec is kept for that object, so a crosswalk changed after it has been used keeps the behaviour it was first compiled with. Documents cross as JSON values, which the binding reads directly; see the README's "JSON values at the boundary".

import { Codec, ruleSides as bindingRuleSides } from "./crossmap.js";

/** The compiled form of each crosswalk object compiled so far, and the codec behind it. Weak, so a crosswalk that is collected takes its codec with it, and the codec's memory in the module is freed by its finaliser. */
const compiled = new WeakMap();
const codecs = new WeakMap();

export function parseCrosswalk(doc) {
  const codec = new Codec(doc);
  try {
    return codec.parsed();
  } finally {
    codec.free();
  }
}

export function validateCrosswalk(crosswalk) {
  const codec = new Codec(crosswalk);
  try {
    return codec.validate();
  } finally {
    codec.free();
  }
}

export function compileCrosswalk(crosswalk) {
  const cached = compiled.get(crosswalk);
  if (cached !== undefined) {
    return cached;
  }
  const codec = new Codec(crosswalk);
  try {
    codec.compile();
  } catch (error) {
    codec.free();
    throw error;
  }
  const result = {
    crosswalk,
    encode: (doc) => codec.encode(doc),
    decode: (doc) => codec.decode(doc),
  };
  compiled.set(crosswalk, result);
  codecs.set(crosswalk, codec);

  return result;
}

export function encode(crosswalk, doc) {
  return compileCrosswalk(crosswalk).encode(doc);
}

export function decode(crosswalk, doc) {
  return compileCrosswalk(crosswalk).decode(doc);
}

export function assertRoundTrip(crosswalk, samples) {
  compileCrosswalk(crosswalk);
  codecs.get(crosswalk).assertRoundTrip(samples);
}

export function ruleSides(rule) {
  return bindingRuleSides(rule);
}
