"""The one release version of the crate, the wheel and the npm package, read from and written to every file that carries it.

The version is `[workspace.package] version` in rust/Cargo.toml. Every workspace crate inherits it, the wheel takes it from the Python binding's crate (pyproject.toml declares the version dynamic), and the npm manifests and the lock file repeat it, so they are written with it and checked against it. The schema's `$id` names it too; the schema is regenerated from the crate after a `set`, never edited here.

Usage:
  release-version.py get           prints the version, after checking every file agrees with it release-version.py check         the same check, printing nothing on success release-version.py set <version> writes the version into every file that carries it (rust/Cargo.toml, its sibling crate requirements, rust/Cargo.lock, the npm manifests); run `sh scripts/rust.sh xtask schema` afterwards to regenerate the schema whose `$id` names it

Exits 1, naming each file, when they disagree, and 2 for bad usage.
"""

from __future__ import annotations

import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKSPACE_MANIFEST = ROOT / "rust" / "Cargo.toml"
LOCK = ROOT / "rust" / "Cargo.lock"
SCHEMA = ROOT / "schemas" / "crossmap.schema.json"
# The npm manifests that carry the version: the published package's, and the repository root's, which semantic-release reads the last release from.
NPM_MANIFESTS = (ROOT / "packages" / "crossmap" / "package.json", ROOT / "package.json")

# A semantic version as semantic-release writes one: no leading `v`, an optional pre-release and build part.
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
# A workspace dependency on a published sibling crate, whose exact requirement carries the release version: `crossmap = { path = "crates/crossmap", version = "=1.2.3" ... }`.
SIBLING_REQUIREMENT = re.compile(r'(?m)^(crossmap(?:-cli)? = \{ path = "crates/[^"]+", version = "=)([^"]+)(")')
# The `version = "..."` line of `[workspace.package]`, the only version line in that table.
WORKSPACE_VERSION_LINE = re.compile(r'(?ms)^(\[workspace\.package\]\n(?:(?!^\[).)*?^version = ")([^"]+)(")')


def workspace_version() -> str:
    """The version `[workspace.package]` declares."""
    version = tomllib.loads(WORKSPACE_MANIFEST.read_text())["workspace"]["package"]["version"]
    if not isinstance(version, str):
        message = f"{WORKSPACE_MANIFEST}: [workspace.package] version is not a string"
        raise TypeError(message)
    return version


def workspace_members() -> set[str]:
    """The package names of the workspace's members, which are the lock file's entries without a `source`."""
    members = tomllib.loads(WORKSPACE_MANIFEST.read_text())["workspace"]["members"]
    names = set()
    for member in members:
        manifest = tomllib.loads((WORKSPACE_MANIFEST.parent / member / "Cargo.toml").read_text())
        names.add(manifest["package"]["name"])
    return names


def locked_member_versions() -> dict[str, str]:
    """The version the lock file records for each workspace member."""
    members = workspace_members()
    return {package["name"]: package["version"] for package in tomllib.loads(LOCK.read_text())["package"] if "source" not in package and package["name"] in members}


def schema_version() -> str | None:
    """The crossmap version the committed schema's `$id` names, if it names one."""
    found = re.search(r"/crossmap@([^/]+)/", json.loads(SCHEMA.read_text())["$id"])
    return found.group(1) if found else None


def disagreements(version: str) -> list[str]:
    """Every file that carries a version other than `version`, each with what it carries."""
    problems = []
    requirements = SIBLING_REQUIREMENT.findall(WORKSPACE_MANIFEST.read_text())
    if not requirements:
        problems.append(f"{WORKSPACE_MANIFEST.relative_to(ROOT)}: no sibling crate requirement found")
    problems.extend(f"{WORKSPACE_MANIFEST.relative_to(ROOT)}: requirement ={found} on a sibling crate" for _, found, _ in requirements if found != version)
    for manifest in NPM_MANIFESTS:
        found = json.loads(manifest.read_text())["version"]
        if found != version:
            problems.append(f"{manifest.relative_to(ROOT)}: version {found}")
    for name, found in sorted(locked_member_versions().items()):
        if found != version:
            problems.append(f"{LOCK.relative_to(ROOT)}: {name} {found}")
    missing = workspace_members() - locked_member_versions().keys()
    problems.extend(f"{LOCK.relative_to(ROOT)}: no entry for {name}" for name in sorted(missing))
    found_schema = schema_version()
    if found_schema != version:
        problems.append(f"{SCHEMA.relative_to(ROOT)}: $id names version {found_schema}")
    return problems


def set_version(version: str) -> None:
    """Writes `version` into rust/Cargo.toml, rust/Cargo.lock and the npm manifests."""
    manifest = WORKSPACE_MANIFEST.read_text()
    written, count = WORKSPACE_VERSION_LINE.subn(lambda match: f"{match.group(1)}{version}{match.group(3)}", manifest)
    if count != 1:
        message = f"{WORKSPACE_MANIFEST}: found {count} [workspace.package] version lines, expected 1"
        raise ValueError(message)
    written = SIBLING_REQUIREMENT.sub(lambda match: f"{match.group(1)}{version}{match.group(3)}", written)
    WORKSPACE_MANIFEST.write_text(written)

    members = workspace_members()
    entries = LOCK.read_text().split("\n[[package]]\n")
    for at, entry in enumerate(entries):
        name = re.search(r'^name = "([^"]+)"$', entry, re.MULTILINE)
        if name and name.group(1) in members and not re.search(r"^source = ", entry, re.MULTILINE):
            entries[at] = re.sub(r'^version = "[^"]+"$', f'version = "{version}"', entry, count=1, flags=re.MULTILINE)
    LOCK.write_text("\n[[package]]\n".join(entries))

    for path in NPM_MANIFESTS:
        text = path.read_text()
        written, count = re.subn(r'^(  "version": ")[^"]+(")', lambda match: f"{match.group(1)}{version}{match.group(2)}", text, count=1, flags=re.MULTILINE)
        if count != 1:
            message = f"{path}: no top-level version field"
            raise ValueError(message)
        path.write_text(written)


def main(arguments: list[str]) -> int:
    """Runs the command line; returns the exit status."""
    match arguments:
        case ["get" | "check" as command]:
            version = workspace_version()
            problems = disagreements(version)
            for problem in problems:
                print(f"{problem}, and rust/Cargo.toml has {version}", file=sys.stderr)
            if problems:
                return 1
            if command == "get":
                print(version)
            return 0
        case ["set", version] if VERSION_PATTERN.fullmatch(version):
            set_version(version)
            return 0
        case _:
            print(__doc__, file=sys.stderr)
            return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
