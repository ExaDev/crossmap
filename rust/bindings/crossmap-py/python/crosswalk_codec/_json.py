"""The type of a JSON value as this package takes and returns it."""

from __future__ import annotations

from typing import TypeAlias

JsonValue: TypeAlias = "dict[str, JsonValue] | list[JsonValue] | str | int | float | bool | None"
"""A JSON value as native Python objects: records are `dict` with `str` keys and arrays are `list`."""
