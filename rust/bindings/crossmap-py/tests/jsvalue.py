"""JSON comparison and serialisation as the corpus defines them: by JavaScript's reading and writing of JSON."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from crosswalk_codec import JsonValue


def same(got: JsonValue, expected: JsonValue) -> bool:
    """Whether two values are equal as JSON: numbers by value, records regardless of key order, `bool` never a number."""
    if isinstance(got, bool) or isinstance(expected, bool):
        return type(got) is type(expected) and got == expected
    if isinstance(got, (int, float)) and isinstance(expected, (int, float)):
        return got == expected
    if isinstance(got, list) and isinstance(expected, list):
        return len(got) == len(expected) and all(same(left, right) for left, right in zip(got, expected, strict=True))
    if isinstance(got, dict) and isinstance(expected, dict):
        return got.keys() == expected.keys() and all(same(member, expected[key]) for key, member in got.items())
    return type(got) is type(expected) and got == expected


def number_text(number: float) -> str:
    """The text JavaScript's `Number.prototype.toString` writes for a finite number, which `JSON.stringify` writes."""
    if isinstance(number, int):
        return str(number)
    if number == 0:
        return "0"
    if not math.isfinite(number):
        message = f"{number} has no JSON form"
        raise ValueError(message)
    # `repr` gives the shortest digits that read back as the same double, which is also what JavaScript chooses; only the placement of the decimal point and the exponent differ.
    sign = "-" if number < 0 else ""
    digits, exponent = _shortest_digits(abs(number))
    point = exponent + 1  # the position of the decimal point after the first digit, as ECMA-262 Number::toString's n
    count = len(digits)
    if count <= point <= 21:
        return sign + digits + "0" * (point - count)
    if 0 < point <= 21:
        return sign + digits[:point] + "." + digits[point:]
    if -6 < point <= 0:
        return sign + "0." + "0" * -point + digits
    written = point - 1
    exponent_part = f"e{'+' if written >= 0 else '-'}{abs(written)}"
    if count == 1:
        return sign + digits + exponent_part
    return sign + digits[0] + "." + digits[1:] + exponent_part


def _shortest_digits(number: float) -> tuple[str, int]:
    """The shortest round-tripping decimal digits of a positive double and the exponent of its first digit."""
    text = repr(number)
    mantissa, _, exponent_text = text.partition("e")
    exponent = int(exponent_text) if exponent_text else 0
    whole, _, fraction = mantissa.partition(".")
    fraction = fraction.rstrip("0")
    digits = (whole + fraction).lstrip("0")
    leading_zeros = len(whole + fraction) - len((whole + fraction).lstrip("0"))
    first_digit_exponent = len(whole) - 1 - leading_zeros + exponent
    return digits.rstrip("0") or "0", first_digit_exponent


def _quote(text: str) -> str:
    escapes = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
    parts = []
    for character in text:
        if character in escapes:
            parts.append(escapes[character])
        elif ord(character) < 0x20:
            parts.append(f"\\u{ord(character):04x}")
        else:
            parts.append(character)
    return '"' + "".join(parts) + '"'


def stringify(value: JsonValue) -> str:
    """The text `JSON.stringify` writes for the value, keys in the order the `dict` holds them."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_text(value)
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, list):
        return "[" + ",".join(stringify(item) for item in value) + "]"
    return "{" + ",".join(_quote(key) + ":" + stringify(member) for key, member in value.items()) + "}"
