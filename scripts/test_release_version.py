"""Tests of scripts/release-version.py, each run on a copy of the files it reads and writes, so the checkout is never changed.

Run with `python3 -I scripts/test_release_version.py`.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def copy_repository(into: Path) -> None:
    """Copies the script and every file it reads into `into`, at the same relative paths."""
    files = ["scripts/release-version.py", "rust/Cargo.toml", "rust/Cargo.lock", "schemas/crossmap.schema.json", "packages/crossmap/package.json"]
    files.extend(f"rust/{member}/Cargo.toml" for member in tomllib.loads((ROOT / "rust" / "Cargo.toml").read_text())["workspace"]["members"])
    for file in files:
        (into / file).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / file, into / file)


def run(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, "-I", str(root / "scripts" / "release-version.py"), *arguments], capture_output=True, text=True, check=False)


class ReleaseVersionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        copy_repository(self.root)
        self.addCleanup(shutil.rmtree, self.root)

    def test_the_committed_files_agree(self) -> None:
        result = run(self.root, "get")
        self.assertEqual(result.returncode, 0, result.stderr)
        version = tomllib.loads((ROOT / "rust" / "Cargo.toml").read_text())["workspace"]["package"]["version"]
        self.assertEqual(result.stdout, f"{version}\n")

    def test_set_writes_every_file_but_the_schema_and_changes_nothing_else(self) -> None:
        before = {path: path.read_text() for path in self.root.rglob("*") if path.is_file()}
        old = run(self.root, "get").stdout.strip()
        self.assertEqual(run(self.root, "set", "7.8.9-rc.1").returncode, 0)

        result = run(self.root, "check")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "schemas/crossmap.schema.json: $id names version " + old + ", and rust/Cargo.toml has 7.8.9-rc.1\n")

        schema = self.root / "schemas" / "crossmap.schema.json"
        schema.write_text(schema.read_text().replace(f"/crossmap@{old}/", "/crossmap@7.8.9-rc.1/"))
        result = run(self.root, "get")
        self.assertEqual((result.returncode, result.stdout), (0, "7.8.9-rc.1\n"), result.stderr)

        for path, text in before.items():
            after = path.read_text()
            # Every changed line is a version line that now names the new version where it named the old one.
            changed = [(old_line, new_line) for old_line, new_line in zip(text.splitlines(), after.splitlines(), strict=True) if old_line != new_line]
            for old_line, new_line in changed:
                self.assertEqual(old_line.replace(old, "7.8.9-rc.1"), new_line, path)
        lock = tomllib.loads((self.root / "rust" / "Cargo.lock").read_text())["package"]
        self.assertTrue(all(package["version"] != "7.8.9-rc.1" for package in lock if "source" in package))
        self.assertEqual(json.loads((self.root / "packages" / "crossmap" / "package.json").read_text())["version"], "7.8.9-rc.1")

    def test_a_disagreeing_file_is_named(self) -> None:
        manifest = self.root / "packages" / "crossmap" / "package.json"
        version = run(self.root, "get").stdout.strip()
        manifest.write_text(manifest.read_text().replace(f'"version": "{version}"', '"version": "0.0.0"', 1))
        result = run(self.root, "check")
        self.assertEqual(result.returncode, 1)
        self.assertIn(f"packages/crossmap/package.json: version 0.0.0, and rust/Cargo.toml has {version}", result.stderr)

    def test_bad_usage_is_refused(self) -> None:
        for arguments in [[], ["set"], ["set", "v1.2.3"], ["set", "1.2"], ["bump"]]:
            self.assertEqual(run(self.root, *arguments).returncode, 2, arguments)


if __name__ == "__main__":
    unittest.main()
