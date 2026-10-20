import { describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_REJECTED, EXIT_USAGE, run } from "./run";

const crosswalk = {
  source: "meridian-freight/consignment",
  target: "shared/consignment/v1",
  rules: [
    { op: "move", from: "consignmentId", to: "id" },
    { op: "scale", from: "weightGrams", to: "weightKilograms", factor: 0.001 },
  ],
};
const native = { consignmentId: "MF-2041", weightGrams: 1250000 };
const shared = { id: "MF-2041", weightKilograms: 1250 };

/** Runs the command against in-memory files, returning its status and what it wrote. */
function exec(args: readonly string[], files: Readonly<Record<string, unknown>> = {}) {
  let stdout = "";
  let stderr = "";
  const status = run(args, {
    readText: (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`no such file: ${path}`);
      const content = files[path];

      return typeof content === "string" ? content : JSON.stringify(content);
    },
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
    version: "9.9.9",
  });

  return { status, stdout, stderr };
}

describe("run", () => {
  it("encodes a document and prints it as JSON", () => {
    const result = exec(["encode", "cw.json", "doc.json"], { "cw.json": crosswalk, "doc.json": native });

    expect(result.status).toBe(EXIT_OK);
    expect(JSON.parse(result.stdout)).toEqual(shared);
    expect(result.stderr).toBe("");
  });

  it("decodes a document back to the source shape", () => {
    const result = exec(["decode", "cw.json", "doc.json"], { "cw.json": crosswalk, "doc.json": shared });

    expect(result.status).toBe(EXIT_OK);
    expect(JSON.parse(result.stdout)).toEqual(native);
  });

  it("validates a sound crosswalk silently", () => {
    expect(exec(["validate", "cw.json"], { "cw.json": crosswalk })).toEqual({ status: EXIT_OK, stdout: "", stderr: "" });
  });

  it("rejects a structurally unsound crosswalk, naming the rule", () => {
    const duplicate = { ...crosswalk, rules: [...crosswalk.rules, { op: "move", from: "other", to: "id" }] };
    const result = exec(["validate", "cw.json"], { "cw.json": duplicate });

    expect(result.status).toBe(EXIT_REJECTED);
    expect(result.stderr).toBe("crosswalk structure error: two rules write the same to path: id\n");
    expect(result.stdout).toBe("");
  });

  it("rejects a document a rule cannot apply to, with the library's message", () => {
    const result = exec(["encode", "cw.json", "doc.json"], { "cw.json": crosswalk, "doc.json": {} });

    expect(result.status).toBe(EXIT_REJECTED);
    expect(result.stderr).toMatch(/rule 0 \(consignmentId\)/);
  });

  it("rejects a value that is not a crosswalk", () => {
    const result = exec(["validate", "cw.json"], { "cw.json": { rules: "none" } });

    expect(result.status).toBe(EXIT_REJECTED);
    expect(result.stderr).toMatch(/^crosswalk syntax error: /);
  });

  it("passes a round trip that reproduces every sample", () => {
    const result = exec(["round-trip", "cw.json", "samples.json"], { "cw.json": crosswalk, "samples.json": [native] });

    expect(result).toEqual({ status: EXIT_OK, stdout: "", stderr: "" });
  });

  it("fails a round trip whose decode differs from its sample", () => {
    const lossy = { ...crosswalk, rules: [{ op: "scale", from: "weightGrams", to: "weightKilograms", factor: 0.1 }] };
    const result = exec(["round-trip", "cw.json", "samples.json"], { "cw.json": lossy, "samples.json": [{ weightGrams: 3 }] });

    expect(result.status).toBe(EXIT_REJECTED);
    expect(result.stderr).toMatch(/^sample 0 /);
  });

  it("treats a samples file that is not an array as a usage error", () => {
    const result = exec(["round-trip", "cw.json", "samples.json"], { "cw.json": crosswalk, "samples.json": native });

    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/JSON array/);
  });

  it("reports an unreadable or non-JSON file as a usage error", () => {
    expect(exec(["validate", "missing.json"]).stderr).toMatch(/^cannot read missing\.json: /);
    const result = exec(["validate", "cw.json"], { "cw.json": "{" });

    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/^cw\.json is not valid JSON: /);
  });

  it("refuses two arguments that both read standard input", () => {
    const result = exec(["encode", "-", "-"]);

    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toMatch(/only one argument/);
  });

  it("answers an unknown command, a missing file argument and an unknown flag with the usage text", () => {
    for (const args of [["frobnicate", "a"], ["encode", "cw.json"], [], ["--nope"]]) {
      const result = exec(args);

      expect(result.status).toBe(EXIT_USAGE);
      expect(result.stderr).toContain("Usage: twindex");
    }
  });

  it("prints the version and the help text on success", () => {
    expect(exec(["--version"])).toEqual({ status: EXIT_OK, stdout: "9.9.9\n", stderr: "" });
    expect(exec(["-h"]).stdout).toContain("Usage: twindex");
  });
});
