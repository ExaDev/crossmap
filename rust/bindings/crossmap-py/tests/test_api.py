"""The Python surface: its names, types, value conversion, errors and command."""

from __future__ import annotations

import json
import pickle
import subprocess
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any

import crosswalk_codec
import pytest
from crosswalk_codec import (
    CompiledCrosswalk,
    CrossmapError,
    Crosswalk,
    CrosswalkIssue,
    CrosswalkStructureError,
    CrosswalkSyntaxError,
    RoundTripMismatchError,
    RuleApplicationError,
    RuleSides,
    SyntaxIssue,
    assert_round_trip,
    compile_crosswalk,
    encode,
    parse_crosswalk,
    rule_sides,
    validate_crosswalk,
)

if TYPE_CHECKING:
    from crosswalk_codec import JsonValue

TRUE: JsonValue = {
    "kind": "compare",
    "op": "eq",
    "left": {"kind": "numberLiteral", "value": 1},
    "right": {"kind": "numberLiteral", "value": 1},
}
MOVE: JsonValue = {"source": "n", "target": "s", "rules": [{"op": "move", "from": "a", "to": "b"}]}


def test_exports_the_documented_names() -> None:
    assert set(crosswalk_codec.__all__) == {
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
    }
    for name in crosswalk_codec.__all__:
        assert hasattr(crosswalk_codec, name), name


def test_returns_the_repository_schema_byte_for_byte() -> None:
    # The committed schema this wheel was built from, which the npm package ships and the crate generates.
    committed = (Path(__file__).resolve().parents[4] / "schemas" / "crossmap.schema.json").read_bytes()
    assert crosswalk_codec.json_schema_text().encode() == committed
    assert json.loads(crosswalk_codec.json_schema_text())["$id"].endswith(
        f"/crossmap@{crosswalk_codec.__version__}/schemas/crossmap.schema.json"
    )


def test_ships_its_type_information() -> None:
    package = Path(crosswalk_codec.__file__).parent
    assert (package / "py.typed").is_file()
    assert (package / "_native.pyi").is_file()


def test_the_version_is_the_distribution_version() -> None:
    from importlib.metadata import version  # noqa: PLC0415

    assert crosswalk_codec.__version__ == version("crosswalk-codec")


def test_the_errors_form_one_family() -> None:
    for error in (CrosswalkSyntaxError, CrosswalkStructureError, RuleApplicationError, RoundTripMismatchError):
        assert issubclass(error, CrossmapError)
    assert issubclass(CrossmapError, Exception)


# ---------------------------------------------------------------------------------------------------------------------
# The crosswalk.


def test_a_parsed_crosswalk_exposes_its_labels_and_parsed_form() -> None:
    crosswalk = parse_crosswalk({"$schema": "https://example.com/s.json", "source": "n", "target": "s", "keep": ["a"]})
    assert isinstance(crosswalk, Crosswalk)
    assert (crosswalk.source, crosswalk.target, crosswalk.schema) == ("n", "s", "https://example.com/s.json")
    assert crosswalk.to_dict() == {
        "$schema": "https://example.com/s.json",
        "source": "n",
        "target": "s",
        "rules": [{"op": "move", "from": "a", "to": "a"}],
        "oneWay": [],
    }
    assert parse_crosswalk(crosswalk.to_dict()) == crosswalk
    assert parse_crosswalk(MOVE).schema is None


def test_a_crosswalk_is_immutable() -> None:
    crosswalk = parse_crosswalk(MOVE)
    with pytest.raises(AttributeError):
        crosswalk.source = "other"  # type: ignore[misc]


def test_compile_returns_a_codec_over_the_same_crosswalk() -> None:
    crosswalk = parse_crosswalk(MOVE)
    compiled = compile_crosswalk(crosswalk)
    assert isinstance(compiled, CompiledCrosswalk)
    assert compiled.crosswalk is crosswalk
    assert compiled.encode({"a": 1}) == {"b": 1}
    assert compiled.decode({"b": 1}) == {"a": 1}


def test_compile_raises_the_structure_error_up_front() -> None:
    crosswalk = parse_crosswalk({"source": "n", "target": "s", "rules": [{"op": "move", "from": "a[]", "to": "b"}]})
    with pytest.raises(CrosswalkStructureError) as raised:
        compile_crosswalk(crosswalk)
    assert raised.value.issues == tuple(validate_crosswalk(crosswalk))
    assert all(isinstance(issue, CrosswalkIssue) for issue in raised.value.issues)
    assert raised.value.issues[0].rule_index == 0
    with pytest.raises(CrosswalkStructureError):
        encode(crosswalk, {"a": []})


def test_rule_sides_gives_both_sides_of_a_rule() -> None:
    template: dict[str, JsonValue] = {
        "op": "template",
        "from": {"g": "given", "f": "family"},
        "to": "name",
        "template": "{f}, {g}",
    }
    assert rule_sides(template) == RuleSides(("given", "family"), ("name",))
    assert rule_sides({"op": "move", "from": "a"}) == RuleSides(("a",), ("a",))
    with pytest.raises(CrosswalkSyntaxError):
        rule_sides({"op": "nope"})


# ---------------------------------------------------------------------------------------------------------------------
# Errors and their fields.


def test_a_syntax_error_carries_every_issue() -> None:
    with pytest.raises(CrosswalkSyntaxError) as raised:
        parse_crosswalk({"rules": "none"})
    error = raised.value
    assert len(error.issues) >= 3
    assert all(isinstance(issue, SyntaxIssue) for issue in error.issues)
    assert str(error) == "crosswalk syntax error: " + "; ".join(issue.message for issue in error.issues)


def test_a_rule_application_error_names_the_rule_and_path() -> None:
    with pytest.raises(RuleApplicationError) as raised:
        encode(parse_crosswalk(MOVE), {"c": 1})
    error = raised.value
    assert (error.rule_index, error.path) == (0, "a")
    assert str(error) == f"rule 0 (a): {error.detail}"


def test_a_round_trip_mismatch_names_the_sample_and_path() -> None:
    lossy = parse_crosswalk({"source": "n", "target": "s", "keep": ["a"]})
    with pytest.raises(RoundTripMismatchError) as raised:
        assert_round_trip(lossy, [{"a": 1}, {"a": 1, "b": 2}])
    error = raised.value
    # The extra key makes the whole record differ, so the first differing location is the root, spelt as "".
    assert (error.sample_index, error.path) == (1, "")
    assert str(error).startswith("sample 1 (): ")


def test_assert_round_trip_takes_any_iterable_of_samples() -> None:
    samples: list[JsonValue] = [{"a": 1}, {"a": [2]}]
    assert_round_trip(parse_crosswalk(MOVE), iter(samples))


def test_an_unevaluable_predicate_is_a_value_error() -> None:
    gated: JsonValue = {
        "source": "n",
        "target": "s",
        "rules": [
            {"op": "move", "from": "a", "to": "b", "when": {"collection": "lines", "kind": "some", "item": TRUE}}
        ],
    }
    with pytest.raises(ValueError, match="resolved to nothing") as raised:
        encode(parse_crosswalk(gated), {"a": 1})
    assert not isinstance(raised.value, CrossmapError)


def test_errors_built_by_hand_read_as_the_codecs_own() -> None:
    assert str(RuleApplicationError(-1, "items[2]", "no rule wrote it")) == "items[2]: no rule wrote it"
    structure = CrosswalkStructureError([CrosswalkIssue(2, "x"), CrosswalkIssue(-1, "y")])
    assert str(structure) == "crosswalk structure error: rule 2: x; y"


@pytest.mark.parametrize(
    "error",
    [
        CrosswalkSyntaxError([SyntaxIssue("m")]),
        CrosswalkStructureError([CrosswalkIssue(0, "m")]),
        RuleApplicationError(1, "a", "m"),
        RoundTripMismatchError(1, "a", "m"),
    ],
)
def test_errors_pickle_with_their_fields(error: CrossmapError) -> None:
    copy = pickle.loads(pickle.dumps(error))  # noqa: S301
    assert type(copy) is type(error)
    assert str(copy) == str(error)
    assert vars(copy) == vars(error)


# ---------------------------------------------------------------------------------------------------------------------
# Values crossing the boundary.


def member(record: JsonValue, key: str) -> JsonValue:
    """The member of a record, which the codec returned as a `dict`."""
    assert isinstance(record, dict)
    return record[key]


def carry(value: Any) -> JsonValue:  # noqa: ANN401
    """The value after a move of it across encode. `Any`, since the refusal tests pass values that are not JSON."""
    return member(encode(parse_crosswalk(MOVE), {"a": value}), "b")


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,
        False,
        "",
        "text é \U0001f600",
        0,
        -7,
        2**53 - 1,
        -(2**53 - 1),
        2.5,
        1e300,
        5e-324,
        [],
        {},
        [1, [2, {}]],
    ],
)
def test_json_values_cross_unchanged(value: JsonValue) -> None:
    got = carry(value)
    assert got == value
    assert type(got) is type(value)


def test_integral_numbers_come_back_as_int_whatever_they_went_in_as() -> None:
    assert type(carry(3.0)) is int
    assert carry(3.0) == 3
    assert type(carry(2**53 - 1)) is int


def test_integers_beyond_the_safe_range_come_back_as_float() -> None:
    got = carry(2**60)
    assert type(got) is float
    assert got == 2**60


def test_negative_zero_keeps_its_sign() -> None:
    got = carry(-0.0)
    assert type(got) is float
    assert str(got) == "-0.0"


def test_bool_is_not_a_number() -> None:
    assert carry(True) is True  # noqa: FBT003
    assert carry(1) is not True


def test_subclasses_of_json_types_cross_as_their_base() -> None:
    class Text(str):
        __slots__ = ()

    class Record(dict[str, int]):
        pass

    assert carry(Text("x")) == "x"
    assert type(carry(Text("x"))) is str
    assert carry(Record(k=1)) == {"k": 1}


def test_records_keep_javascripts_key_order() -> None:
    assert list(carry({"b": 1, "10": 2, "a": 3, "2": 4})) == ["2", "10", "b", "a"]  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("value", "error", "fragment"),
    [
        ((1, 2), TypeError, "tuple"),
        ({1, 2}, TypeError, "set"),
        (b"x", TypeError, "bytes"),
        (object(), TypeError, "object"),
        ({1: "x"}, TypeError, "key"),
        (float("nan"), ValueError, "finite"),
        (float("inf"), ValueError, "finite"),
        (2**53 + 1, ValueError, "double"),
        (10**400, ValueError, "double"),
        ("\ud800", ValueError, "surrogate"),
    ],
)
def test_non_json_values_are_refused_naming_where_they_are(
    value: Any,  # noqa: ANN401
    error: type[Exception],
    fragment: str,
) -> None:
    with pytest.raises(error, match=fragment) as raised:
        encode(parse_crosswalk(MOVE), {"a": [0, {"deep": value}]})
    assert str(raised.value).startswith('document["a"][1]["deep"] is not JSON: ')


def test_large_integers_a_double_holds_exactly_are_accepted() -> None:
    assert carry(2**60) == 2**60
    assert carry(-(2**1000)) == -(2.0**1000)


def nest(containers: int) -> list[JsonValue]:
    """Arrays nested `containers` deep."""
    nested: list[JsonValue] = []
    for _ in range(containers - 1):
        nested = [nested]
    return nested


def test_nesting_is_bounded_as_the_command_bounds_it() -> None:
    keep = parse_crosswalk({"source": "n", "target": "s", "keep": ["a"]})
    # The root record holds the arrays, so it counts as one more.
    assert encode(keep, {"a": nest(126)}) == {"a": nest(126)}
    with pytest.raises(ValueError, match="more than 127"):
        encode(keep, {"a": nest(127)})


def test_a_value_that_contains_itself_is_refused() -> None:
    loop: list[Any] = []
    loop.append(loop)
    with pytest.raises(ValueError, match="contains itself"):
        carry(loop)


def test_the_input_document_is_not_mutated() -> None:
    document: JsonValue = {"a": {"x": [1, 2]}}
    output = encode(parse_crosswalk(MOVE), document)
    assert document == {"a": {"x": [1, 2]}}
    assert member(output, "b") is not member(document, "a")


def test_other_threads_run_while_the_codec_runs() -> None:
    crosswalk = compile_crosswalk(parse_crosswalk({"source": "n", "target": "s", "keep": ["rows[].v"]}))
    rows: list[JsonValue] = [{"v": index} for index in range(200_000)]
    document: JsonValue = {"rows": rows}
    results: list[JsonValue] = []
    threads = [threading.Thread(target=lambda: results.append(crosswalk.encode(document))) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [document] * 4


# ---------------------------------------------------------------------------------------------------------------------
# The command.


def crossmap(*args: str, stdin: str = "") -> subprocess.CompletedProcess[str]:
    command = Path(sys.executable).with_name("crossmap")
    return subprocess.run([str(command), *args], input=stdin, capture_output=True, text=True, check=False)


def test_the_command_reports_the_package_version() -> None:
    completed = crossmap("--version")
    assert completed.returncode == 0
    assert completed.stdout == f"{crosswalk_codec.__version__}\n"


def test_the_command_encodes_from_standard_input(tmp_path: Path) -> None:
    crosswalk = tmp_path / "cw.json"
    crosswalk.write_text('{"source":"n","target":"s","rules":[{"op":"move","from":"a","to":"b"}]}')
    completed = crossmap("encode", str(crosswalk), "-", stdin='{"a":1}')
    assert (completed.returncode, completed.stdout, completed.stderr) == (0, '{\n  "b": 1\n}\n', "")


def test_the_command_exits_2_on_bad_usage() -> None:
    completed = crossmap("nonsense")
    assert completed.returncode == 2
    assert completed.stderr.startswith("expected a command")
