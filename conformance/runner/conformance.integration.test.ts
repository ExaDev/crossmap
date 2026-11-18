import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { generate } from "../generate/differential";
import { canonical } from "./canonical";
import { runCorpus } from "./run";

const ROOT = join(import.meta.dirname, "..");

const CasesFile = z.object({ cases: z.array(z.record(z.string(), z.unknown())) });
const ManifestFile = z.object({ files: z.record(z.string(), z.unknown()) });

/** The whole corpus runs in one test: roughly a thousand cases, a few of which start a local server or read files. */
const CORPUS_TIMEOUT_MILLISECONDS = 120_000;

describe("the conformance corpus against the TypeScript implementation", () => {
  it("conforms: every case passes and the corpus agrees with its manifest", async () => {
    const report = await runCorpus(ROOT);

    expect(report.problems).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.executed).toBeGreaterThan(0);
  }, CORPUS_TIMEOUT_MILLISECONDS);

  it("holds the seeded differential sample exactly as its generator writes it", () => {
    expect(readFileSync(join(ROOT, "crossmap/generated/differential.json"), "utf8")).toBe(generate());
  }, CORPUS_TIMEOUT_MILLISECONDS);
});

describe("the runner refuses what it must refuse", { timeout: CORPUS_TIMEOUT_MILLISECONDS }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "crossmap-conformance-selftest-"));
  const files = ["crossmap/paths/format.json", "crossmap/executor/encode.json"];
  let counter = 0;

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  }, CORPUS_TIMEOUT_MILLISECONDS);

  /** A small corpus root of two real files, with the manifest to match, and a hook to damage it before the runner reads it. */
  function miniCorpus(damage: (root: string) => void = () => undefined): string {
    counter += 1;
    const root = join(scratch, String(counter));
    for (const name of ["case.schema.json", "manifest.schema.json"]) {
      cpSync(join(ROOT, name), join(root, name));
    }
    const manifest = ManifestFile.parse(JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")));
    const kept = Object.fromEntries(files.map((file) => [file, manifest.files[file]]));
    writeFileSync(join(root, "manifest.json"), `${canonical({ files: kept })}\n`);
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(ROOT, file), join(root, file));
    }
    damage(root);

    return root;
  }

  /** Rewrites one corpus file of a mini corpus through `change`, in canonical form. */
  function edit(root: string, file: string, change: (cases: readonly Record<string, unknown>[]) => readonly Record<string, unknown>[]): void {
    const path = join(root, file);
    const parsed = CasesFile.parse(JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(path, `${canonical({ cases: change(parsed.cases) })}\n`);
  }

  it("accepts the undamaged mini corpus, so the damage below is what fails it", async () => {
    const report = await runCorpus(miniCorpus());

    expect(report).toMatchObject({ problems: [], failures: [] });
    expect(report.executed).toBeGreaterThan(0);
  });

  it("fails a case whose expected value has been changed", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      edit(root, "crossmap/executor/encode.json", (cases) => {
        const first = cases[0];
        if (first === undefined) {
          throw new Error("the file holds no case");
        }
        first["expect"] = { output: { x: { y: 2 } } };

        return cases;
      });
    }));

    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain("executor.encode.1");
  });

  it("fails a case whose expected error class has been changed", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      edit(root, "crossmap/executor/encode.json", (cases) => {
        const missing = cases.find((entry) => JSON.stringify(entry["expect"]).includes("RuleApplicationError"));
        if (missing === undefined) {
          throw new Error("the file holds no error case");
        }
        missing["expect"] = { error: { class: "CrosswalkSyntaxError" } };

        return cases;
      });
    }));

    expect(report.failures).toHaveLength(1);
  });

  it("refuses an empty corpus", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      writeFileSync(join(root, "manifest.json"), `${canonical({ files: {} })}\n`);
      rmSync(join(root, "crossmap"), { recursive: true });
    }));

    expect(report.problems).toContain("the corpus holds no cases");
    expect(report.executed).toBe(0);
  });

  it("refuses a manifest that disagrees with the files", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      edit(root, "crossmap/paths/format.json", (cases) => {
        return cases.slice(0, -1);
      });
    }));

    expect(report.problems.join("\n")).toContain("the manifest says");
  });

  it("refuses a file the manifest does not list and a manifest entry with no file", async () => {
    const unlisted = await runCorpus(miniCorpus((root) => {
      writeFileSync(join(root, "manifest.json"), `${canonical({ files: {} })}\n`);
    }));
    const missing = await runCorpus(miniCorpus((root) => {
      rmSync(join(root, "crossmap/paths"), { recursive: true });
    }));

    expect(unlisted.problems.join("\n")).toContain("is not in the manifest");
    expect(missing.problems.join("\n")).toContain("is in the manifest and not on disk");
  });

  it("refuses a file that is not in canonical form", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      const path = join(root, "crossmap/paths/format.json");
      writeFileSync(path, readFileSync(path, "utf8").replaceAll("  ", "    "));
    }));

    expect(report.problems.join("\n")).toContain("is not in canonical form");
  });

  it("refuses an id used twice", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      edit(root, "crossmap/paths/format.json", (cases) => {
        const [first, second] = cases;
        if (first === undefined || second === undefined) {
          throw new Error("the file holds fewer than two cases");
        }
        second["id"] = first["id"];

        return cases;
      });
    }));

    expect(report.problems.join("\n")).toContain("is also used in");
  });

  it("refuses a case the schema does not describe", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      edit(root, "crossmap/paths/format.json", (cases) => {
        const [first] = cases;
        if (first === undefined) {
          throw new Error("the file holds no case");
        }
        first["unknown"] = true;

        return cases;
      });
    }));

    expect(report.problems.length).toBeGreaterThan(0);
  });

  it("honours a skip only when the manifest lists it", async () => {
    const report = await runCorpus(miniCorpus((root) => {
      edit(root, "crossmap/paths/format.json", (cases) => {
        const [first] = cases;
        if (first === undefined) {
          throw new Error("the file holds no case");
        }
        first["skip"] = "ts";
        first["reason"] = "self-test";

        return cases;
      });
    }));

    expect(report.problems.join("\n")).toContain("marked skip ts differ from the manifest");
    expect(report.skipped).toBe(1);
  });
});
