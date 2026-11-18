"""The `crossmap` console script: the Rust command, run on this process's standard streams."""

from __future__ import annotations

import sys

from crosswalk_codec import _native


def main() -> None:
    """Run the command with the process's arguments and exit with its status."""
    # The command writes to the process's file descriptors directly, so anything Python has buffered goes first.
    sys.stdout.flush()
    sys.stderr.flush()
    sys.exit(_native.run_command(sys.argv[1:]))
