/**
 * A semantic-release plugin whose `prepare` step gives every artefact the release's one version: scripts/release-version.py writes it into rust/Cargo.toml (which the crates and, through maturin, the wheel take it from), rust/Cargo.lock and the npm manifests, the schema is regenerated from the crate so its `$id` names it, and the check that every file agrees runs last. The release commit @semantic-release/git makes then holds them together, and the publish jobs build the crates, the wheels and the npm package from that commit.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/**
 * @param {unknown} _pluginConfig this plugin takes no options
 * @param {{ nextRelease: { version: string }, logger: { log: (message: string) => void } }} context the semantic-release context of the release
 */
export function prepare(_pluginConfig, context) {
  const { version } = context.nextRelease;
  const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  run("python3", ["-I", "scripts/release-version.py", "set", version]);
  run("sh", ["scripts/rust.sh", "xtask", "schema"]);
  run("python3", ["-I", "scripts/release-version.py", "check"]);
  context.logger.log(`Wrote version ${version} into every manifest, the lock file and the schema`);
}
