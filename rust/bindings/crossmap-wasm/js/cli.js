#!/usr/bin/env node
// The `crossmap` command in Node. The command's two steps are the native command's own, run in the wasm module: `cliPlan` reads the command line, and `cliComplete` parses what was read, applies the crosswalk and words the outcome. Only the reading between them is done here, so the output and the exit statuses (0, 1, 2) are the native command's.

import { readFileSync } from "node:fs";
import "./index.js";
import { cliComplete, cliPlan } from "./crossmap.js";
import { readSource } from "./read-source.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// A reader that closes early (`| head -c 0`) makes the next write fail with EPIPE. The result was computed either way, so that error is dropped and the exit status the command settled on stands; any other stdout error is still thrown.
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});

const args = process.argv.slice(2);
const planned = cliPlan(args, version);
// Read together so two remote arguments are fetched concurrently; `cliComplete` reports the first failure in argument order.
const outcome =
  "operands" in planned
    ? cliComplete(
        args,
        version,
        (await Promise.allSettled(planned.operands.map(async (operand) => readSource(operand)))).map((read) =>
          read.status === "fulfilled" ? { text: read.value } : { error: read.reason instanceof Error ? read.reason.message : String(read.reason) },
        ),
      )
    : planned;

if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
process.exitCode = outcome.status;
