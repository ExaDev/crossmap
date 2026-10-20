#!/usr/bin/env node
import packageJson from "../package.json" with { type: "json" };
import { readSource } from "./read-source";
import { run } from "./run";

// A reader that closes early (`| head -c 0`) makes the next write fail with EPIPE. The result was computed either way, so that error is dropped and the exit status the command settled on stands; any other stdout error is still thrown.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EPIPE") throw error;
});

process.exitCode = await run(process.argv.slice(2), {
  readText: readSource,
  writeStdout: (text) => {
    process.stdout.write(text);
  },
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  version: packageJson.version,
});
