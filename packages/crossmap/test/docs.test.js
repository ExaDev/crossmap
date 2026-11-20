// Runs the JavaScript examples of the repository's README and usage guide against the installed package, so neither can show code the package does not run. Each block is written beside this file as a module, so its `import "crossmap"` resolves in the consumer exactly as a reader's would.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const root = process.env["CROSSMAP_DOCS"];
if (root === undefined) {
  throw new Error("CROSSMAP_DOCS must name the repository root, which holds README.md and docs/usage.md");
}
const generated = fileURLToPath(new URL("docs-examples/", import.meta.url));
mkdirSync(generated, { recursive: true });

// A block that reads a published URL is the one kind not run: it needs a network and a server this repository does not own.
const READS_THE_NETWORK = "example.com";

/** The `js` blocks of a document, in order. */
function jsBlocks(document) {
  return [...readFileSync(join(root, document), "utf8").matchAll(/^```js\n(.*?)^```/gmsu)].map((match) => match[1]);
}

for (const document of ["README.md", "docs/usage.md"]) {
  const blocks = jsBlocks(document);
  describe(`the JavaScript examples of ${document}`, () => {
    it("exist", () => {
      assert.ok(blocks.length > 0);
    });

    for (const [index, block] of blocks.entries()) {
      if (block.includes(READS_THE_NETWORK)) {
        continue;
      }
      it(`run as written (block ${String(index + 1)})`, async () => {
        const file = join(generated, `${document.replaceAll(/[^a-z]/gu, "-")}-${String(index)}.mjs`);
        writeFileSync(file, block);
        await import(pathToFileURL(file).href);
      });
    }
  });
}
