"""
The conformance corpus, run through the installed package.

Every case of every kind runs except the `schema-*` kinds, which test the published JSON Schema file, an artefact of the npm package that the Python package does not ship. The corpus's `skip` lists name the TypeScript and the Rust implementations; this package is the Rust implementation, so a case marked to skip for Rust is skipped here.
"""

from __future__ import annotations

import copy
import http.server
import json
import os
import shutil
import subprocess
import sys
import sysconfig
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar

import crosswalk_codec
import pytest
from crosswalk_codec import (
    CrossmapError,
    CrosswalkIssue,
    CrosswalkStructureError,
    CrosswalkSyntaxError,
    RoundTripMismatchError,
    RuleApplicationError,
    SyntaxIssue,
    assert_round_trip,
    decode,
    encode,
    parse_crosswalk,
    rule_sides,
    validate_crosswalk,
)
from crosswalk_codec import _native as native

from tests.jsvalue import same, stringify

if TYPE_CHECKING:
    from collections.abc import Callable

    from crosswalk_codec import JsonValue

CORPUS = Path(os.environ.get("CROSSMAP_CONFORMANCE_DIR", Path(__file__).resolve().parents[4] / "conformance"))
"""The corpus: the repository's `conformance` directory, or the directory `CROSSMAP_CONFORMANCE_DIR` names."""

NOT_RUN_KINDS = frozenset(
    {
        "schema-canonical",
        "schema-when-ref",
        "schema-pointer",
        "schema-rule-requires-to",
        "schema-validates",
    }
)
"""The kinds that test `schemas/crossmap.schema.json`, which this package does not ship."""

SKIP_AS = "rust"

Case = dict[str, Any]


@dataclass(frozen=True)
class CorpusCase:
    """One case and the corpus file it came from."""

    file: str
    case: Case


def load_corpus() -> list[CorpusCase]:
    """Every case of every corpus file the manifest lists, after checking the manifest against the files."""
    manifest = json.loads((CORPUS / "manifest.json").read_text(encoding="utf-8"))["files"]
    found = sorted(path.relative_to(CORPUS).as_posix() for path in (CORPUS / "crossmap").rglob("*.json"))
    if found != sorted(manifest):
        message = f"the manifest lists {sorted(manifest)}, the corpus holds {found}"
        raise AssertionError(message)
    cases: list[CorpusCase] = []
    for name in found:
        file_cases = json.loads((CORPUS / name).read_text(encoding="utf-8"))["cases"]
        if len(file_cases) != manifest[name]["cases"]:
            message = f"{name} holds {len(file_cases)} cases, the manifest says {manifest[name]['cases']}"
            raise AssertionError(message)
        cases.extend(CorpusCase(name, case) for case in file_cases)
    if not cases:
        message = "the corpus holds no cases"
        raise AssertionError(message)
    return cases


ALL_CASES = load_corpus()
RUN_CASES = [entry for entry in ALL_CASES if entry.case["kind"] not in NOT_RUN_KINDS]


def test_runs_every_case_but_the_json_schema_kinds() -> None:
    kinds = {entry.case["kind"] for entry in ALL_CASES}
    assert kinds >= NOT_RUN_KINDS, "a schema kind is gone from the corpus; NOT_RUN_KINDS is stale"
    assert len(RUN_CASES) + sum(entry.case["kind"] in NOT_RUN_KINDS for entry in ALL_CASES) == len(ALL_CASES)
    assert RUN_CASES


def test_the_package_under_test_is_the_installed_wheel() -> None:
    installed = Path(sysconfig.get_paths()["purelib"]).resolve()
    assert Path(crosswalk_codec.__file__).resolve().is_relative_to(installed)
    assert Path(native.__file__).resolve().is_relative_to(installed)


# ---------------------------------------------------------------------------------------------------------------------
# Errors.

CLASS_NAMES: dict[type[BaseException], str] = {
    CrosswalkSyntaxError: "CrosswalkSyntaxError",
    CrosswalkStructureError: "CrosswalkStructureError",
    RuleApplicationError: "RuleApplicationError",
    RoundTripMismatchError: "RoundTripMismatchError",
    # A `when` predicate that cannot be evaluated is a plain `Error` in the TypeScript library and a `ValueError` here.
    ValueError: "Error",
}


def class_name(error: BaseException) -> str:
    """The corpus name of the error's class."""
    return CLASS_NAMES.get(type(error), type(error).__name__)


def compare_error(error: BaseException, expected: Case) -> list[str]:
    """How the raised error differs from the expected one, as the Rust runner compares them."""
    name = class_name(error)
    if name != expected["class"]:
        return [f"expected a {expected['class']}, got {name}: {error}"]
    problems: list[str] = []
    located: tuple[int, str, str] | None = None
    if isinstance(error, RuleApplicationError):
        located = (error.rule_index, error.path, "ruleIndex")
    elif isinstance(error, RoundTripMismatchError):
        located = (error.sample_index, error.path, "sampleIndex")
    if located is not None:
        index, path, index_key = located
        if index_key in expected and expected[index_key] != index:
            problems.append(f"index {index}, expected {expected[index_key]}")
        if "path" in expected and expected["path"] != path:
            problems.append(f"path {path}, expected {expected['path']}")
    message = str(error)
    if "message" in expected and expected["message"] != message:
        problems.append(f"message {message!r}, expected {expected['message']!r}")
    problems.extend(
        f"message {message!r} lacks {part!r}" for part in expected.get("messageContains", []) if part not in message
    )
    if isinstance(error, CrosswalkSyntaxError) and len(error.issues) < expected.get("minIssues", 0):
        problems.append(f"{len(error.issues)} issues, expected at least {expected['minIssues']}")
    if isinstance(error, CrosswalkStructureError) and "issues" in expected:
        got = issues_value(list(error.issues))
        if not same(got, expected["issues"]):
            problems.append(f"issues {got}, expected {expected['issues']}")
    return problems


def issues_value(issues: list[CrosswalkIssue]) -> JsonValue:
    return [{"message": issue.message, "ruleIndex": issue.rule_index} for issue in issues]


def outcome(expect: Case, attempt: Callable[[], Any], success: Callable[[Any], list[str]]) -> list[str]:
    """Compare the result of `attempt()` with an expectation that is either `{error}` or a success shape."""
    try:
        value = attempt()
    except (CrossmapError, ValueError) as error:
        if "error" in expect:
            return compare_error(error, expect["error"])
        return [f"raised {class_name(error)}: {error}, expected a result"]
    if "error" in expect:
        return [f"returned {value!r}, expected a {expect['error']['class']}"]
    return success(value)


def compared(got: JsonValue, expected: JsonValue) -> list[str]:
    return [] if same(got, expected) else [f"got {stringify(got)}, expected {stringify(expected)}"]


# ---------------------------------------------------------------------------------------------------------------------
# The kinds.


def run_parse(case: Case) -> list[str]:
    expect = case["expect"]
    return outcome(
        expect,
        lambda: parse_crosswalk(case.get("crosswalk")).to_dict(),
        lambda value: compared(value, expect["crosswalk"]) if "crosswalk" in expect else [],
    )


def run_validate(case: Case) -> list[str]:
    issues = validate_crosswalk(parse_crosswalk(case.get("crosswalk")))
    return compared({"issues": issues_value(issues)}, case["expect"])


def run_rule_sides(case: Case) -> list[str]:
    sides = rule_sides(case["rule"])
    return compared({"from": list(sides.from_), "to": list(sides.to)}, case["expect"])


def run_error_message(case: Case) -> list[str]:
    error = case["error"]
    issues = error.get("issues", [])
    built: CrossmapError
    match error["class"]:
        case "CrosswalkSyntaxError":
            built = CrosswalkSyntaxError(SyntaxIssue(issue["message"]) for issue in issues)
        case "CrosswalkStructureError":
            built = CrosswalkStructureError(CrosswalkIssue(issue["ruleIndex"], issue["message"]) for issue in issues)
        case "RuleApplicationError":
            built = RuleApplicationError(error["ruleIndex"], error["path"], error["message"])
        case "RoundTripMismatchError":
            built = RoundTripMismatchError(error["sampleIndex"], error["path"], error["message"])
        case other:
            return [f"unknown error class {other}"]
    return compared(str(built), case["expect"]["message"])


def run_run(case: Case) -> list[str]:
    expect = case["expect"]
    document = case["document"]
    untouched = copy.deepcopy(document)
    translate = encode if case["direction"] == "encode" else decode

    def success(value: JsonValue) -> list[str]:
        problems = compared(value, expect["output"]) if "output" in expect else []
        if "outputText" in expect and stringify(value) != expect["outputText"]:
            problems.append(f"serialised as {stringify(value)}, expected {expect['outputText']}")
        return problems

    problems = outcome(expect, lambda: translate(parse_crosswalk(case.get("crosswalk")), document), success)
    if not same(document, untouched):
        problems.append("the input document was mutated")
    return problems


def run_round_trip(case: Case) -> list[str]:
    expect = case["expect"]

    def attempt() -> bool:
        assert_round_trip(parse_crosswalk(case.get("crosswalk")), case["samples"])
        return True

    return outcome(expect, attempt, lambda value: compared(value, expect["ok"]) if "ok" in expect else [])


def run_path_parse(case: Case) -> list[str]:
    expect = case["expect"]
    return outcome(
        expect,
        lambda: native.parse_path(case["path"]),
        lambda value: compared(value, expect["steps"]) if "steps" in expect else [],
    )


def run_path_format(case: Case) -> list[str]:
    printed = native.format_path(case["path"])
    problems = compared(printed, case["expect"]["canonical"])
    if native.parse_path(printed) != native.parse_path(case["path"]):
        problems.append("the canonical spelling parses to a different path")
    return problems


def run_path_read(case: Case) -> list[str]:
    expect = case["expect"]
    reading = native.read_path(case["document"], case["path"])
    if reading is None:
        return compared(False, expect["found"])  # noqa: FBT003
    return [
        *compared(True, expect["found"]),  # noqa: FBT003
        *compared(reading["matches"], expect["matches"]),
        *compared(reading["empties"], expect["empties"]),
    ]


def run_is_url(case: Case) -> list[str]:
    return compared(native.is_url(case["argument"]), case["expect"])


class CaseServer(http.server.ThreadingHTTPServer):
    """A local HTTP server answering each request path with the case's response."""

    daemon_threads = True

    def __init__(self, responses: dict[str, Case]) -> None:
        self.responses = responses
        super().__init__(("127.0.0.1", 0), CaseHandler)


class CaseHandler(http.server.BaseHTTPRequestHandler):
    """Answers a GET with the case's status, body and headers for the path, or 404."""

    server: CaseServer
    protocol_version: ClassVar[str] = "HTTP/1.1"  # type: ignore[misc]

    def do_GET(self) -> None:
        response = self.server.responses.get(self.path, {"status": 404, "body": "missing"})
        body = response["body"].encode()
        self.send_response(response["status"])
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        for name, value in response.get("headers", {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        """Keep the test output to the test's own."""


def crossmap_command() -> str:
    """The `crossmap` console script the wheel installed, next to this interpreter."""
    found = shutil.which("crossmap", path=str(Path(sys.executable).parent))
    assert found is not None, "the wheel installed no crossmap command next to the interpreter"
    return found


def run_cli(case: Case, tmp_path: Path) -> list[str]:
    expect = case["expect"]
    server = CaseServer(case["server"]) if "server" in case else None
    if server is not None:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        origin = f"http://127.0.0.1:{server.server_address[1]}" if server is not None else ""
        replacements = {"{dir}": str(tmp_path), "{origin}": origin, "{version}": crosswalk_codec.__version__}

        def substitute(text: str) -> str:
            for name, value in replacements.items():
                text = text.replace(name, value)
            return text

        for name, content in case.get("files", {}).items():
            target = tmp_path / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        completed = subprocess.run(  # noqa: PLW1510
            [crossmap_command(), *(substitute(argument) for argument in case.get("args", []))],
            input=case.get("stdin", "").encode(),
            capture_output=True,
            timeout=120,
        )
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
    stdout = completed.stdout.decode()
    stderr = completed.stderr.decode()
    problems: list[str] = []
    if completed.returncode != expect.get("status"):
        problems.append(f"exit status {completed.returncode}, expected {expect.get('status')}")

    def stream(name: str, got: str, wanted: str | Case) -> None:
        if isinstance(wanted, str):
            if got != substitute(wanted):
                problems.append(f"{name} was {got!r}, expected {substitute(wanted)!r}")
            return
        problems.extend(
            f"{name} {got!r} lacks {substitute(part)!r}"
            for part in wanted.get("contains", [])
            if substitute(part) not in got
        )

    if "stdout" in expect:
        stream("stdout", stdout, expect["stdout"])
    if "stdoutJson" in expect:
        try:
            problems.extend(compared(json.loads(stdout), expect["stdoutJson"]))
        except json.JSONDecodeError:
            problems.append(f"stdout is not JSON: {stdout!r}")
    if "stderr" in expect:
        wanted = expect["stderr"]
        if "equals" in wanted:
            stream("stderr", stderr, wanted["equals"])
        if "startsWith" in wanted and not stderr.startswith(substitute(wanted["startsWith"])):
            problems.append(f"stderr {stderr!r} does not start with {substitute(wanted['startsWith'])!r}")
        if "contains" in wanted:
            stream("stderr", stderr, {"contains": wanted["contains"]})
    return problems


RUNNERS = {
    "parse": run_parse,
    "validate": run_validate,
    "rule-sides": run_rule_sides,
    "error-message": run_error_message,
    "run": run_run,
    "round-trip": run_round_trip,
    "path-parse": run_path_parse,
    "path-format": run_path_format,
    "path-read": run_path_read,
    "is-url": run_is_url,
}


def cases() -> list[Any]:
    """The cases this package runs, each marked to skip when the corpus skips it for Rust."""
    return [
        pytest.param(
            entry,
            id=entry.case["id"],
            marks=[pytest.mark.skip(reason=entry.case.get("reason", ""))] if entry.case.get("skip") == SKIP_AS else [],
        )
        for entry in RUN_CASES
    ]


@pytest.mark.parametrize("entry", cases())
def test_case(entry: CorpusCase, tmp_path: Path) -> None:
    case = entry.case
    kind = case["kind"]
    problems = run_cli(case, tmp_path) if kind == "cli" else RUNNERS[kind](case)
    assert not problems, f"{case['id']} ({entry.file}): {'; '.join(problems)}"


def test_every_run_kind_has_a_runner() -> None:
    assert {entry.case["kind"] for entry in RUN_CASES} == {*RUNNERS, "cli"}
