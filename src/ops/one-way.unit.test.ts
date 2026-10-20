import { describe, expect, it } from "vitest";
import type { DefaultRule, DropRule } from "../crosswalk";
import { applyOneWayRule } from "./one-way";

describe("applyOneWayRule", () => {
  it("inserts an encode-direction default when its target is absent", () => {
    const rule: DefaultRule = { op: "default", to: "locale", value: "en-GB", direction: "encode" };
    const target: Record<string, unknown> = {};
    applyOneWayRule(rule, "encode", {}, target);
    expect(target).toEqual({ locale: "en-GB" });
  });

  it("leaves an existing value in place", () => {
    const rule: DefaultRule = { op: "default", to: "locale", value: "en-GB", direction: "encode" };
    const target: Record<string, unknown> = { locale: "cy" };
    applyOneWayRule(rule, "encode", {}, target);
    expect(target).toEqual({ locale: "cy" });
  });

  it("does nothing when running the other direction", () => {
    const rule: DefaultRule = { op: "default", to: "locale", value: "en-GB", direction: "decode" };
    const target: Record<string, unknown> = {};
    applyOneWayRule(rule, "encode", {}, target);
    expect(target).toEqual({});
  });

  it("creates intermediate records for a nested target", () => {
    const rule: DefaultRule = { op: "default", to: "delivery.locale", value: "en-GB", direction: "encode" };
    const target: Record<string, unknown> = {};
    applyOneWayRule(rule, "encode", {}, target);
    expect(target).toEqual({ delivery: { locale: "en-GB" } });
  });

  it("drop is a declared no-op in the fresh-output executor", () => {
    const rule: DropRule = { op: "drop", from: "internal", direction: "encode" };
    const target: Record<string, unknown> = {};
    applyOneWayRule(rule, "encode", {}, target);
    applyOneWayRule(rule, "decode", {}, target);
    expect(target).toEqual({});
  });
});
