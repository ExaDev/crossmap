"""The Python examples of the repository's README and usage guide, run as written so neither can show code the package does not run."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[4]
"""The repository root, which holds the README and `docs`."""

FENCE = re.compile(r"^```python\n(.*?)^```", re.DOTALL | re.MULTILINE)


def python_blocks(document: str) -> list[str]:
    return FENCE.findall((ROOT / document).read_text(encoding="utf8"))


EXAMPLES = [(document, block) for document in ("README.md", "docs/usage.md") for block in python_blocks(document)]
"""Every Python block of the two documents."""

READS_THE_NETWORK = "example.com"
"""A block that reads a published URL is the one kind not run: it needs a network and a server this repository does not own."""


def test_the_documents_have_python_examples() -> None:
    assert {document for document, _ in EXAMPLES} == {"README.md", "docs/usage.md"}


@pytest.mark.parametrize(
    ("document", "block"), [example for example in EXAMPLES if READS_THE_NETWORK not in example[1]]
)
def test_a_python_example_runs(document: str, block: str) -> None:
    exec(compile(block, document, "exec"), {})  # noqa: S102 - the repository's own documentation, run to prove it
