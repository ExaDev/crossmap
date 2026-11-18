"""A bidirectional crosswalk codec.

One crosswalk document describes how to map between a dataset's native JSON shape and a shared target shape, and that one document derives both directions: `decode` undoes `encode` over the paths the crosswalk maps, and what cannot be undone is declared as one-way rules. Documents are native Python values (`dict`, `list`, `str`, `int`, `float`, `bool`, `None`); see the package README for how numbers convert.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from crosswalk_codec._errors import (
    CrossmapError,
    CrosswalkIssue,
    CrosswalkStructureError,
    CrosswalkSyntaxError,
    RoundTripMismatchError,
    RuleApplicationError,
    SyntaxIssue,
)
from crosswalk_codec._json import JsonValue
from crosswalk_codec._native import (
    VERSION,
    CompiledCrosswalk,
    Crosswalk,
    assert_round_trip,
    compile_crosswalk,
    decode,
    encode,
    json_schema_text,
    parse_crosswalk,
    validate_crosswalk,
)
from crosswalk_codec._native import rule_sides as _rule_sides

if TYPE_CHECKING:
    from collections.abc import Mapping

__version__ = VERSION

__all__ = [
    "CompiledCrosswalk",
    "CrossmapError",
    "Crosswalk",
    "CrosswalkIssue",
    "CrosswalkStructureError",
    "CrosswalkSyntaxError",
    "JsonValue",
    "RoundTripMismatchError",
    "RuleApplicationError",
    "RuleSides",
    "SyntaxIssue",
    "__version__",
    "assert_round_trip",
    "compile_crosswalk",
    "decode",
    "encode",
    "json_schema_text",
    "parse_crosswalk",
    "rule_sides",
    "validate_crosswalk",
]


@dataclass(frozen=True, slots=True)
class RuleSides:
    """The paths a two-way rule reads and writes: encode reads `from_` and writes `to`, decode the reverse."""

    from_: tuple[str, ...]
    to: tuple[str, ...]


def rule_sides(rule: Mapping[str, JsonValue]) -> RuleSides:
    """Return the sides of a two-way rule, such as an element of a parsed crosswalk's `rules`.

    A template reads its fields in its `from` record's order, a copy writes several targets, and every other rule has one path on each side. Raises `CrosswalkSyntaxError` when the rule does not parse; its issues name it `rules.0`.
    """
    from_, to = _rule_sides(dict(rule))
    return RuleSides(tuple(from_), tuple(to))
