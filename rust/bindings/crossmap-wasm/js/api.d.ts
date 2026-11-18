/** A JSON value: what `JSON.parse` returns. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A trilean predicate tree, the shape of every rule's optional `when`: evaluated against the governing document (the source while encoding, the target while decoding). Its grammar is trilean's predicate schema, which `parseCrosswalk` checks. */
export type When = { readonly kind: string; readonly [field: string]: JsonValue };

export interface MoveRule {
  readonly op: "move";
  readonly from: string;
  readonly to: string;
  readonly when?: When | undefined;
}

export interface ScaleRule {
  readonly op: "scale";
  readonly from: string;
  readonly to: string;
  /** Finite and non-zero: decode divides by it. */
  readonly factor: number;
  readonly when?: When | undefined;
}

/** `mapBack` must be the exact inverse of an injective `map`, checked when the crosswalk is parsed. */
export interface EnumRule {
  readonly op: "enum";
  readonly from: string;
  readonly to: string;
  readonly map: Readonly<Record<string, string>>;
  readonly mapBack: Readonly<Record<string, string>>;
  readonly when?: When | undefined;
}

/** The textual forms `format` converts, each a bijection between its canonical text and a machine value. */
export type FormatKind = "isoDateTime" | "isoDate" | "numberText" | "booleanText" | "jsonText";

export interface FormatRule {
  readonly op: "format";
  readonly from: string;
  readonly to: string;
  readonly kind: FormatKind;
  readonly when?: When | undefined;
}

export interface SplitRule {
  readonly op: "split";
  readonly from: string;
  readonly to: string;
  /** Non-empty. */
  readonly separator: string;
  readonly when?: When | undefined;
}

/** Several fields rendered into one text through a template, and split back out of it. `from` maps each placeholder name to the path of its field. */
export interface TemplateRule {
  readonly op: "template";
  readonly from: Readonly<Record<string, string>>;
  readonly to: string;
  readonly template: string;
  readonly when?: When | undefined;
}

/** One value written to several places, at least two. */
export interface CopyRule {
  readonly op: "copy";
  readonly from: string;
  readonly to: readonly string[];
  readonly when?: When | undefined;
}

/** A two-way rule: closed under inversion, so encode and decode both derive from it. */
export type TwoWayRule = MoveRule | ScaleRule | EnumRule | FormatRule | SplitRule | TemplateRule | CopyRule;

export interface DropRule {
  readonly op: "drop";
  readonly from: string;
  readonly direction: "encode";
  readonly when?: When | undefined;
}

export interface DefaultRule {
  readonly op: "default";
  readonly to: string;
  readonly value: JsonValue;
  readonly direction: "encode" | "decode";
  readonly when?: When | undefined;
}

export type AggregateFunction = "count" | "sum" | "min" | "max";

/** A value derived from the elements a wildcard path reaches, written in one direction. `to` has fewer wildcards than `from`. */
export interface AggregateRule {
  readonly op: "aggregate";
  readonly fn: AggregateFunction;
  readonly from: string;
  readonly to: string;
  readonly direction: "encode" | "decode";
  readonly when?: When | undefined;
}

/** A one-way rule: explicitly lossy, applying in one direction only. */
export type OneWayRule = DropRule | DefaultRule | AggregateRule;

/** A parsed crosswalk: defaults filled in, kept paths as the moves they stand for, every single-path rule's `to` present. */
export interface Crosswalk {
  /** The address of the JSON Schema the document declares itself written against. It has no part in encoding, decoding or validation. */
  readonly $schema?: string | undefined;
  readonly source: string;
  readonly target: string;
  readonly rules: readonly TwoWayRule[];
  readonly oneWay: readonly OneWayRule[];
}

/** A crosswalk validated and prepared once, for encoding and decoding any number of documents. */
export interface CompiledCrosswalk {
  /** The crosswalk this was compiled from. */
  readonly crosswalk: Crosswalk;
  /**
   * Encodes a native document into the shared shape, as {@link encode} does.
   * @throws RuleApplicationError as {@link encode} does.
   */
  readonly encode: (doc: unknown) => JsonValue;
  /**
   * Decodes a shared document back into the native shape, as {@link decode} does.
   * @throws RuleApplicationError as {@link decode} does.
   */
  readonly decode: (doc: unknown) => JsonValue;
}

/** The paths a two-way rule reads and writes, in the order its operation takes and produces values: encode reads `from` and writes `to`, decode the reverse. */
export interface RuleSides {
  readonly from: readonly string[];
  readonly to: readonly string[];
}

/**
 * Parses a value as a crosswalk document.
 * @param doc - The candidate crosswalk document, a JSON value.
 * @returns The validated crosswalk, with omitted lists defaulted to empty, kept paths turned into moves and every `to` filled in.
 * @throws CrosswalkSyntaxError carrying every issue found, not just the first; TypeError when `doc` is not a JSON value.
 */
export declare function parseCrosswalk(doc: unknown): Crosswalk;

/**
 * The structural issues of a crosswalk: the properties of the rule list as a whole that parsing cannot check.
 * @param crosswalk - The parsed crosswalk.
 * @returns Every issue, empty when the crosswalk can execute.
 */
export declare function validateCrosswalk(crosswalk: Crosswalk): readonly import("./errors.js").CrosswalkIssue[];

/**
 * Validates and prepares a crosswalk once, for encoding and decoding any number of documents. The result is kept for the crosswalk object, so compiling the same object again (as {@link encode} and {@link decode} do on every call) returns it at no cost; a crosswalk is read when it is first compiled, so an object changed afterwards keeps the behaviour it was first compiled with.
 * @param crosswalk - The parsed crosswalk.
 * @returns The compiled crosswalk.
 * @throws CrosswalkStructureError when the crosswalk fails structural validation.
 */
export declare function compileCrosswalk(crosswalk: Crosswalk): CompiledCrosswalk;

/**
 * Encodes a native document into the shared shape. A rule's `when` is evaluated against `doc`.
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The native document, a JSON value.
 * @returns The shared document.
 * @throws CrosswalkStructureError, RuleApplicationError; TypeError when `doc` is not a JSON value.
 */
export declare function encode(crosswalk: Crosswalk, doc: unknown): JsonValue;

/**
 * Decodes a shared document back into the native shape. A rule's `when` is evaluated against `doc`.
 * @param crosswalk - The parsed crosswalk.
 * @param doc - The shared document, a JSON value.
 * @returns The native document.
 * @throws CrosswalkStructureError, RuleApplicationError; TypeError when `doc` is not a JSON value.
 */
export declare function decode(crosswalk: Crosswalk, doc: unknown): JsonValue;

/**
 * Encodes and decodes each sample and compares the result with it, leaving out the paths one-way rules touch.
 * @param crosswalk - The parsed crosswalk.
 * @param samples - Native documents, JSON values.
 * @throws RoundTripMismatchError on the first difference, naming the sample and the path.
 */
export declare function assertRoundTrip(crosswalk: Crosswalk, samples: readonly unknown[]): void;

/**
 * The sides of a two-way rule.
 * @param rule - The rule.
 * @returns Its `from` and `to` paths as lists, each non-empty.
 */
export declare function ruleSides(rule: TwoWayRule): RuleSides;
