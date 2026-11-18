"""The errors crossmap raises: every one is a `CrossmapError`, so a caller catches the family with one clause.

Each class is constructed from the fields it carries and builds its message with the Rust codec's own formatting, so an error raised by the codec and one constructed here with the same fields read the same.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from crosswalk_codec import _native

if TYPE_CHECKING:
    from collections.abc import Iterable


@dataclass(frozen=True, slots=True)
class SyntaxIssue:
    """One reason a crosswalk document or a path failed its schema or grammar, naming the offending field."""

    message: str


@dataclass(frozen=True, slots=True)
class CrosswalkIssue:
    """One structural defect of a crosswalk that parses.

    `rule_index` numbers two-way rules first, then one-way rules, continuing the count, and is negative when the defect lies between rules rather than in one.
    """

    rule_index: int
    message: str


class CrossmapError(Exception):
    """The root of the errors crossmap raises."""


class CrosswalkSyntaxError(CrossmapError):
    """A crosswalk document or a path fails its schema or grammar. Carries every issue found, not just the first."""

    issues: tuple[SyntaxIssue, ...]

    def __init__(self, issues: Iterable[SyntaxIssue]) -> None:
        """Build the error from its issues, in the order the document's fields were read."""
        self.issues = tuple(issues)
        super().__init__(_native.format_syntax_error([issue.message for issue in self.issues]))

    def __reduce__(self) -> tuple[type[CrosswalkSyntaxError], tuple[tuple[SyntaxIssue, ...]]]:
        """Pickle by the fields the constructor takes."""
        return (type(self), (self.issues,))


class CrosswalkStructureError(CrossmapError):
    """A crosswalk parses but its rule list cannot execute as written. Carries what `validate_crosswalk` reports."""

    issues: tuple[CrosswalkIssue, ...]

    def __init__(self, issues: Iterable[CrosswalkIssue]) -> None:
        """Build the error from its issues."""
        self.issues = tuple(issues)
        super().__init__(_native.format_structure_error([(issue.rule_index, issue.message) for issue in self.issues]))

    def __reduce__(self) -> tuple[type[CrosswalkStructureError], tuple[tuple[CrosswalkIssue, ...]]]:
        """Pickle by the fields the constructor takes."""
        return (type(self), (self.issues,))


class RuleApplicationError(CrossmapError):
    """A rule cannot be applied to a document.

    Its read path is absent, a value does not fit the operation, or two destinations conflict. `rule_index` numbers two-way rules first, then one-way rules, and is negative when no single rule owns the failure (an output array element no rule wrote). `path` is the path or paths concerned, as the crosswalk spells them, and `detail` what went wrong.
    """

    rule_index: int
    path: str
    detail: str

    def __init__(self, rule_index: int, path: str, detail: str) -> None:
        """Build the error from the rule, the path and what went wrong."""
        self.rule_index = rule_index
        self.path = path
        self.detail = detail
        super().__init__(_native.format_rule_application_error(rule_index, path, detail))

    def __reduce__(self) -> tuple[type[RuleApplicationError], tuple[int, str, str]]:
        """Pickle by the fields the constructor takes."""
        return (type(self), (self.rule_index, self.path, self.detail))


class RoundTripMismatchError(CrossmapError):
    """`decode(encode(sample))` differs from the sample on a path the crosswalk promises to preserve.

    `sample_index` is the sample's position in the samples given, `path` the first differing location in the path grammar's canonical spelling (empty for the root), and `detail` how the two values differ.
    """

    sample_index: int
    path: str
    detail: str

    def __init__(self, sample_index: int, path: str, detail: str) -> None:
        """Build the error from the sample, the path and how the values differ."""
        self.sample_index = sample_index
        self.path = path
        self.detail = detail
        super().__init__(_native.format_round_trip_mismatch(sample_index, path, detail))

    def __reduce__(self) -> tuple[type[RoundTripMismatchError], tuple[int, str, str]]:
        """Pickle by the fields the constructor takes."""
        return (type(self), (self.sample_index, self.path, self.detail))
