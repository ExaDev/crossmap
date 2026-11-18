"""Tests of scripts/published-dependencies.py, with crates.io replaced by a fixed set of published versions, so no test reaches the network.

Run with `python3 -I scripts/test_published_dependencies.py`.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent / "published-dependencies.py"
spec = importlib.util.spec_from_file_location("published_dependencies", SCRIPT)
assert spec is not None and spec.loader is not None
published_dependencies = importlib.util.module_from_spec(spec)
spec.loader.exec_module(published_dependencies)

ON_CRATES_IO = {("serde", "1.0.0"), ("trilean-eval", "3.0.0")}


def dependency(name: str, requirement: str, *, path: bool) -> dict[str, object]:
    return {"name": name, "req": requirement, "path": f"/checkout/{name}" if path else None}


def metadata(*dependencies: dict[str, object]) -> str:
    sibling = dependency("app-core", "=0.1.0", path=True)
    return json.dumps({"packages": [{"name": "app", "dependencies": [sibling, *dependencies]}, {"name": "app-core", "dependencies": []}, {"name": "tool", "dependencies": [dependency("unpublished", "^9.9.9", path=True)]}]})


def run(stdin: str) -> tuple[int, str]:
    output = io.StringIO()
    with mock.patch.object(sys, "stdin", io.StringIO(stdin)), mock.patch.object(published_dependencies, "on_crates_io", lambda name, version: (name, version) in ON_CRATES_IO), contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        status = published_dependencies.main(["app", "app-core"])
    return status, output.getvalue()


class PublishedDependenciesTest(unittest.TestCase):
    def test_a_path_dependency_on_crates_io_passes(self) -> None:
        self.assertEqual(run(metadata(dependency("trilean-eval", "^3.0.0", path=True)))[0], 0)

    def test_a_path_dependency_missing_from_crates_io_is_named(self) -> None:
        status, output = run(metadata(dependency("trilean-eval", "^3.0.0", path=True), dependency("trilean-json-shape", "=3.0.0", path=True)))
        self.assertEqual(status, 1)
        self.assertIn("::error::", output)
        self.assertIn("trilean-json-shape 3.0.0 (needed by app)", output)
        self.assertNotIn("trilean-eval 3.0.0 (needed", output)

    def test_registry_dependencies_sibling_crates_and_unpublished_packages_are_not_looked_up(self) -> None:
        self.assertEqual(run(metadata(dependency("absent", "^1", path=False)))[0], 0)

    def test_a_requirement_naming_no_single_version_is_refused(self) -> None:
        self.assertEqual(run(metadata(dependency("trilean-eval", ">=3, <4", path=True)))[0], 2)

    def test_no_crate_names_is_bad_usage(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(published_dependencies.main([]), 2)


if __name__ == "__main__":
    unittest.main()
