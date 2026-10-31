import type { TwoWayRule } from "../crosswalk";
import { enumDecode, enumEncode } from "./enum";
import { formatDecode, formatEncode } from "./format";
import { moveValue } from "./move";
import { scaleDecode, scaleEncode } from "./scale";
import { splitDecode, splitEncode } from "./split";

/** The two-way rules with one path on each side. */
export type SinglePathRule = Exclude<TwoWayRule, { readonly op: "template" | "copy" }>;

/** Resolves a single-path operation in one direction to a function of the one value it reads. */
export function singlePathOp(rule: SinglePathRule, direction: "encode" | "decode"): (value: unknown) => unknown {
  switch (rule.op) {
    case "move":
      return (value) => moveValue(rule, value);
    case "scale":
      return direction === "encode" ? (value) => scaleEncode(rule, value) : (value) => scaleDecode(rule, value);
    case "enum":
      return direction === "encode" ? (value) => enumEncode(rule, value) : (value) => enumDecode(rule, value);
    case "format":
      return direction === "encode" ? (value) => formatEncode(rule, value) : (value) => formatDecode(rule, value);
    case "split":
      return direction === "encode" ? (value) => splitEncode(rule, value) : (value) => splitDecode(rule, value);
    default:
      return unhandledOp();
  }
}

/** Unreachable for any rule that passed the schema: the default arm exists so the switch is total, and reaching it means this package's schema and executor disagree. */
function unhandledOp(): never {
  throw new Error("no operation handler for the rule's op: the schema and the executor disagree");
}
