"""Checks that the crates, the Python distributions and the npm tarball built from one commit carry one version and one schema.

Usage: verify-artefacts.py <directory> [--python <interpreter>]

<directory> holds what the artefacts workflow builds: the `.crate` files of every published crate, `crate.schema.json` (the schema the packaged `crossmap` crate generates), every wheel and the sdist of `crosswalk-codec`, and the npm tarball of `crossmap`. The expected version is the one scripts/release-version.py reads from this checkout, after checking every manifest agrees with it, and the expected schema is this checkout's schemas/crossmap.schema.json.

Each artefact's version is read from its own metadata (the crate's Cargo.toml, the wheel's METADATA, the sdist's PKG-INFO, the tarball's package.json), never its file name. The schema is compared byte for byte in three places: the crate's generated schema, the file the npm tarball ships under schemas/, and what `crosswalk_codec.json_schema_text()` returns from a wheel installed into a fresh environment of <interpreter> (default: this one) from <directory> alone.

Prints one line per check and exits 1 when any fails, 2 for bad usage.
"""

from __future__ import annotations

import email.parser
import hashlib
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The crates crates.io receives, which scripts/rust.sh publishes.
CRATES = ("crossmap", "crossmap-cli")
DISTRIBUTION = "crosswalk-codec"
NPM_PACKAGE = "crossmap"
SCHEMA_IN_TARBALL = "package/schemas/crossmap.schema.json"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def expected_version() -> str:
    result = subprocess.run([sys.executable, "-I", str(ROOT / "scripts" / "release-version.py"), "get"], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(1)
    return result.stdout.strip()


def single(directory: Path, pattern: str) -> Path:
    found = sorted(directory.glob(pattern))
    if len(found) != 1:
        message = f"expected exactly one {pattern} in {directory}, found {[path.name for path in found]}"
        raise SystemExit(message)
    return found[0]


def crate_version(crate: Path) -> tuple[str, str]:
    """The package name and version the `.crate` file's own Cargo.toml declares."""
    with tarfile.open(crate, "r:gz") as archive:
        manifests = [member for member in archive.getmembers() if member.name.count("/") == 1 and member.name.endswith("/Cargo.toml")]
        if len(manifests) != 1:
            message = f"{crate.name}: holds {len(manifests)} top-level Cargo.toml files"
            raise SystemExit(message)
        extracted = archive.extractfile(manifests[0])
        if extracted is None:
            message = f"{crate.name}: Cargo.toml is not a file"
            raise SystemExit(message)
        package = tomllib.loads(extracted.read().decode())["package"]
    return package["name"], package["version"]


def wheel_version(wheel: Path) -> tuple[str, str]:
    with zipfile.ZipFile(wheel) as archive:
        metadata = [name for name in archive.namelist() if name.count("/") == 1 and name.endswith(".dist-info/METADATA")]
        if len(metadata) != 1:
            message = f"{wheel.name}: holds {len(metadata)} METADATA files"
            raise SystemExit(message)
        headers = email.parser.BytesParser().parsebytes(archive.read(metadata[0]))
    return headers["Name"], headers["Version"]


def sdist_version(sdist: Path) -> tuple[str, str]:
    with tarfile.open(sdist, "r:gz") as archive:
        info = [member for member in archive.getmembers() if member.name.count("/") == 1 and member.name.endswith("/PKG-INFO")]
        if len(info) != 1:
            message = f"{sdist.name}: holds {len(info)} top-level PKG-INFO files"
            raise SystemExit(message)
        extracted = archive.extractfile(info[0])
        if extracted is None:
            message = f"{sdist.name}: PKG-INFO is not a file"
            raise SystemExit(message)
        headers = email.parser.BytesParser().parse(io.BytesIO(extracted.read()))
    return headers["Name"], headers["Version"]


def tarball(npm: Path) -> tuple[tuple[str, str], bytes]:
    """The npm tarball's package name and version, and the schema file it ships."""
    with tarfile.open(npm, "r:gz") as archive:
        manifest_file = archive.extractfile("package/package.json")
        schema_file = archive.extractfile(SCHEMA_IN_TARBALL)
        if manifest_file is None or schema_file is None:
            message = f"{npm.name}: package.json or {SCHEMA_IN_TARBALL} is not a file"
            raise SystemExit(message)
        manifest = json.loads(manifest_file.read())
        return (manifest["name"], manifest["version"]), schema_file.read()


def wheel_schema(directory: Path, interpreter: str) -> bytes:
    """The schema text an installed wheel returns, from a fresh environment that installs only from `directory`."""
    with tempfile.TemporaryDirectory() as work:
        venv = Path(work) / "venv"
        subprocess.run([interpreter, "-m", "venv", str(venv)], check=True)
        python = venv / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        subprocess.run([str(python), "-m", "pip", "install", "--quiet", "--no-index", "--no-deps", "--only-binary", ":all:", "--find-links", str(directory), DISTRIBUTION], check=True)
        result = subprocess.run([str(python), "-I", "-c", "import sys, crosswalk_codec; sys.stdout.buffer.write(crosswalk_codec.json_schema_text().encode())"], capture_output=True, check=True, cwd=work)
        return result.stdout


def main(arguments: list[str]) -> int:
    match arguments:
        case [directory]:
            interpreter = sys.executable
        case [directory, "--python", interpreter]:
            pass
        case _:
            sys.stderr.write(__doc__ or "")
            return 2
    artefacts = Path(directory)
    version = expected_version()
    schema = (ROOT / "schemas" / "crossmap.schema.json").read_bytes()
    print(f"expected version {version}, schema sha256 {digest(schema)}")

    found: list[tuple[str, tuple[str, str], tuple[str, str]]] = []
    for crate in CRATES:
        path = single(artefacts, f"{crate}-[0-9]*.crate")
        found.append((path.name, crate_version(path), (crate, version)))
    wheels = sorted(artefacts.glob("crosswalk_codec-*.whl"))
    if not wheels:
        message = f"no crosswalk_codec wheel in {artefacts}"
        raise SystemExit(message)
    found.extend((wheel.name, wheel_version(wheel), (DISTRIBUTION, version)) for wheel in wheels)
    sdist = single(artefacts, "crosswalk_codec-*.tar.gz")
    found.append((sdist.name, sdist_version(sdist), (DISTRIBUTION, version)))
    npm = single(artefacts, f"{NPM_PACKAGE}-*.tgz")
    npm_identity, npm_schema = tarball(npm)
    found.append((npm.name, npm_identity, (NPM_PACKAGE, version)))

    failures = 0
    for name, identity, wanted in found:
        ok = identity == wanted
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}: {identity[0]} {identity[1]}{'' if ok else f', expected {wanted[0]} {wanted[1]}'}")

    schemas = {
        "crate.schema.json (the packaged crate's generated schema)": (artefacts / "crate.schema.json").read_bytes(),
        f"{npm.name} {SCHEMA_IN_TARBALL}": npm_schema,
        "crosswalk_codec.json_schema_text() from the installed wheel": wheel_schema(artefacts, interpreter),
    }
    for name, text in schemas.items():
        ok = text == schema
        failures += not ok
        print(f"{'ok  ' if ok else 'FAIL'} {name}: sha256 {digest(text)}")

    print(f"{len(found) + len(schemas) - failures} of {len(found) + len(schemas)} checks pass")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
