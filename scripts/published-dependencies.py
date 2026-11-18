"""Fails while a published crate depends by path on a crate that is not on crates.io at the version it requires.

Usage: cargo metadata --no-deps --format-version 1 | published-dependencies.py <published crate>...

`cargo publish` packages a path dependency as a crates.io dependency on the version its requirement names, so every path dependency of a published crate that is not itself one of the crates being published must already be on crates.io. Each is looked up there; one that is missing is named in an `::error::` line and the exit status is 1, so a publish dry run blocked by an unpublished dependency fails for that stated reason and not inside cargo. A requirement is read as the single version it names (`^3.0.0`, `=3.0.0` or `3.0.0`); any other form exits 2, since the version to look up is then not one release.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

CRATES_IO = "https://crates.io/api/v1/crates"
# crates.io refuses API requests without a User-Agent naming the client.
USER_AGENT = "ExaDev/crossmap CI"
TIMEOUT_SECONDS = 30


def required_version(requirement: str) -> str | None:
    version = requirement.removeprefix("^").removeprefix("=")
    parts = version.split(".")
    return version if len(parts) == 3 and all(part.isdigit() for part in parts) else None


def on_crates_io(name: str, version: str) -> bool:
    request = urllib.request.Request(f"{CRATES_IO}/{name}/{version}", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS):
            return True
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return False
        raise


def main(published: list[str]) -> int:
    if not published:
        sys.stderr.write(__doc__ or "")
        return 2
    missing: list[str] = []
    for package in json.load(sys.stdin)["packages"]:
        if package["name"] not in published:
            continue
        for dependency in package["dependencies"]:
            name = dependency["name"]
            if dependency.get("path") is None or name in published:
                continue
            version = required_version(dependency["req"])
            if version is None:
                sys.stderr.write(f"{package['name']} requires {name} {dependency['req']}, which names no single version\n")
                return 2
            if on_crates_io(name, version):
                print(f"{name} {version}, needed by {package['name']}, is on crates.io")
            else:
                missing.append(f"{name} {version} (needed by {package['name']})")
    if missing:
        print(f"::error::The crates cannot be packaged until these path dependencies are on crates.io: {', '.join(missing)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
