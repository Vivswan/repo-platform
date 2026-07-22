#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Compose the flat template/ tree Copier renders from templates/ sources.

templates/ is the source of truth, one folder per module plus base/:

- templates/base/: passed through verbatim, filenames included (explicit
  conditional filenames like SECURITY.md's `not private` gate live here).
- templates/<module>/: whole files owned by that module. The composer adds
  the module's filename gate automatically ({% if '<module>' in modules %}),
  wrapping the leaf name (keeping any .jinja suffix outside), or a whole
  directory listed in the folder's optional module.yml `gate_dirs`.
- templates/<module>/fragments/<anchor>.jinja: additive contributions to
  shared files. A skeleton file contains a full-line marker
  `{# compose:<anchor> #}`; the composer replaces it with every module's
  fragment wrapped in that module's gate, in MODULE_ORDER. Fragments own all
  whitespace between the tags; the composer adds none.

Collisions are errors, never silent merges: the same logical path provided
by two folders (or a module file colliding with base) must be resolved by
hoisting the file to base/ with an explicit gate or by adding an anchor.

All I/O is bytes (template/.gitignore.jinja carries an intentional CR) and
symlinks are copied as symlinks. Output is deterministic: sorted walks plus
the fixed MODULE_ORDER (CI builds twice and diffs to prove it).

Usage:
  uv run scripts/compose_template.py   # regenerate the local template/ artifact
"""

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "templates"
OUT = REPO_ROOT / "template"

# Fixed, deterministic fragment/collision order (bun before uv preserves the
# dependabot ecosystem order). A templates/ folder not listed here is an error.
MODULE_ORDER = [
    "agents",
    "bun",
    "uv",
    "pages",
    "release-please",
    "issue-templates",
    "pr-title",
    "auto-assign",
    "settings-sync",
]

ANCHOR_RE = re.compile(rb"^\{# compose:([a-z0-9][a-z0-9-]*) #\}$")
JINJA_SUFFIX = ".jinja"
MANIFEST_NAME = "module.yml"
FRAGMENTS_DIR = "fragments"


class SymlinkEntry:
    """A collected symlink, copied as a link (target rewritten on emit)."""

    def __init__(self, target: str):
        self.target = target


class FileEntry:
    """A collected regular file's raw bytes."""

    def __init__(self, data: bytes):
        self.data = data


# One collected source file: regular bytes or a symlink target.
Entry = SymlinkEntry | FileEntry


def read_entry(path: Path) -> Entry:
    if path.is_symlink():
        return SymlinkEntry(os.readlink(path))
    return FileEntry(path.read_bytes())


def load_manifest(folder: Path) -> dict:
    manifest = folder / MANIFEST_NAME
    if not manifest.is_file():
        return {}
    data = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise SystemExit(
            f"error: {manifest.relative_to(REPO_ROOT)} must be a YAML mapping "
            "(it parsed as something else); rewrite it as 'key: value' lines "
            "using only the gate / gate_dirs keys"
        )
    unknown = set(data) - {"gate", "gate_dirs"}
    if unknown:
        raise SystemExit(
            f"error: {manifest.relative_to(REPO_ROOT)}: unknown key(s): "
            f"{', '.join(sorted(unknown))} - only gate and gate_dirs are "
            "recognized; remove or rename the extra keys"
        )
    gate = data.get("gate")
    if gate is not None and not isinstance(gate, str):
        raise SystemExit(
            f"error: {manifest.relative_to(REPO_ROOT)}: gate must be a string "
            "(quote it - unquoted YAML may parse as bool/int)"
        )
    gate_dirs = data.get("gate_dirs")
    if gate_dirs is not None and (
        not isinstance(gate_dirs, list) or not all(isinstance(d, str) for d in gate_dirs)
    ):
        raise SystemExit(
            f"error: {manifest.relative_to(REPO_ROOT)}: gate_dirs must be a list of "
            "strings naming directories in this module; write it as e.g. "
            'gate_dirs: [".github/ISSUE_TEMPLATE"]'
        )
    return data


def collect_files(folder: Path) -> dict[str, Entry]:
    """Logical path -> Entry for a source folder (skips manifest + fragments)."""
    files: dict[str, Entry] = {}
    for path in sorted(folder.rglob("*")):
        rel = path.relative_to(folder)
        if rel.parts[0] == FRAGMENTS_DIR or str(rel) == MANIFEST_NAME:
            continue
        if path.is_symlink() or path.is_file():
            files[str(rel)] = read_entry(path)
    return files


def collect_fragments(folder: Path) -> dict[str, bytes]:
    """Anchor name -> fragment bytes for a module folder."""
    fragments: dict[str, bytes] = {}
    frag_dir = folder / FRAGMENTS_DIR
    if not frag_dir.is_dir():
        return fragments
    for path in sorted(frag_dir.iterdir()):
        if not path.is_file():
            continue
        if path.suffix != JINJA_SUFFIX:
            raise SystemExit(
                f"error: {path.relative_to(REPO_ROOT)}: fragment files must end in "
                f"{JINJA_SUFFIX} (the composer strips it to get the anchor name); "
                f"rename the file to <anchor>{JINJA_SUFFIX} or move it out of {FRAGMENTS_DIR}/"
            )
        fragments[path.name.removesuffix(JINJA_SUFFIX)] = path.read_bytes()
    return fragments


def gate_expression(module: str, manifest: dict) -> str:
    return manifest.get("gate") or f"'{module}' in modules"


def gated_path(logical: str, gate: str, gate_dirs: list[str]) -> str:
    """Wrap the leaf filename (or a declared directory) in the module gate."""
    for gated_dir in gate_dirs:
        prefix = gated_dir.rstrip("/")
        if logical == prefix or logical.startswith(prefix + "/"):
            parent, _, dirname = prefix.rpartition("/")
            wrapped = f"{{% if {gate} %}}{dirname}{{% endif %}}"
            new_prefix = f"{parent}/{wrapped}" if parent else wrapped
            return new_prefix + logical[len(prefix) :]
    parent, _, leaf = logical.rpartition("/")
    if leaf.endswith(JINJA_SUFFIX):
        stem = leaf.removesuffix(JINJA_SUFFIX)
        wrapped = f"{{% if {gate} %}}{stem}{{% endif %}}{JINJA_SUFFIX}"
    else:
        wrapped = f"{{% if {gate} %}}{leaf}{{% endif %}}"
    return f"{parent}/{wrapped}" if parent else wrapped


def splice_fragments(
    files: dict[str, tuple[str, Entry]],
    fragments: dict[str, list[tuple[str, bytes]]],
    gates: dict[str, str],
) -> list[str]:
    """Replace anchor lines in-place; returns error strings."""
    errors: list[str] = []
    anchor_owner: dict[str, tuple[str, str]] = {}  # anchor -> (source, logical)
    for logical, (source, entry) in sorted(files.items()):
        if isinstance(entry, SymlinkEntry):
            continue
        for line in entry.data.split(b"\n"):
            if b"{# compose:" in line and not ANCHOR_RE.match(line):
                errors.append(
                    f"templates/{source}/{logical}: malformed anchor line "
                    f"{line.decode(errors='replace').strip()!r} - anchors must be a "
                    "full line exactly matching '{# compose:<name> #}' (no "
                    "indentation, trailing whitespace, or CRLF)"
                )
                continue
            match = ANCHOR_RE.match(line)
            if not match:
                continue
            anchor = match.group(1).decode()
            if anchor in anchor_owner:
                other = anchor_owner[anchor]
                errors.append(
                    f"duplicate anchor '{anchor}' in templates/{source}/{logical} "
                    f"and templates/{other[0]}/{other[1]} - each anchor may appear "
                    "in exactly one skeleton file; rename one anchor (and any "
                    f"fragments/{anchor}.jinja files that feed it) or remove the duplicate marker"
                )
            anchor_owner[anchor] = (source, logical)

    for anchor, contributions in sorted(fragments.items()):
        if anchor not in anchor_owner:
            for module, _ in contributions:
                errors.append(
                    f"templates/{module}/{FRAGMENTS_DIR}/{anchor}{JINJA_SUFFIX}: no "
                    f"anchor {{# compose:{anchor} #}} found in any source file - the "
                    "fragment has nowhere to splice; add the marker line to a "
                    "skeleton file or delete the fragment"
                )
    for anchor, (source, logical) in sorted(anchor_owner.items()):
        if anchor not in fragments:
            errors.append(
                f"templates/{source}/{logical}: anchor '{anchor}' has no contributing "
                f"fragments - remove the marker or add {FRAGMENTS_DIR}/{anchor}{JINJA_SUFFIX} "
                "to a module"
            )
    if errors:
        return errors

    for _logical, (_source, entry) in files.items():
        if isinstance(entry, SymlinkEntry) or b"{# compose:" not in entry.data:
            continue
        lines = entry.data.split(b"\n")
        rebuilt: list[bytes] = []
        for line in lines:
            match = ANCHOR_RE.match(line)
            if not match:
                rebuilt.append(line)
                continue
            anchor = match.group(1).decode()
            spliced = b"".join(
                b"{% if " + gates[module].encode() + b" %}" + body + b"{% endif %}"
                for module, body in fragments[anchor]
            )
            rebuilt.append(spliced)
        entry.data = b"\n".join(rebuilt)
    return errors


def build() -> dict[str, Entry]:
    """Compose the output map: emitted path -> Entry. SystemExit on errors."""
    base = SRC / "base"
    if not base.is_dir() or not any(base.iterdir()):
        raise SystemExit(
            "error: templates/base is missing or empty; refusing to compose "
            "(a broken checkout must not wipe template/). Restore templates/base/ "
            "with git checkout before rerunning."
        )
    folders = sorted(p.name for p in SRC.iterdir() if p.is_dir() and p.name != "base")
    unknown = [f for f in folders if f not in MODULE_ORDER]
    if unknown:
        raise SystemExit(
            f"error: templates/{unknown[0]}/ is not a known module; add it to "
            "MODULE_ORDER in scripts/compose_template.py"
        )

    errors: list[str] = []
    files: dict[str, tuple[str, Entry]] = {}
    fragments: dict[str, list[tuple[str, bytes]]] = {}
    gates: dict[str, str] = {}
    gate_dirs: dict[str, list[str]] = {}

    for logical, entry in collect_files(base).items():
        files[logical] = ("base", entry)
    if os.path.lexists(base / FRAGMENTS_DIR):
        errors.append(
            f"templates/base/{FRAGMENTS_DIR}: base cannot contribute fragments "
            "(it owns the skeletons); fragments belong to module folders"
        )

    for module in [m for m in MODULE_ORDER if m in folders]:
        folder = SRC / module
        manifest = load_manifest(folder)
        gates[module] = gate_expression(module, manifest)
        gate_dirs[module] = list(manifest.get("gate_dirs") or [])
        module_files = collect_files(folder)
        # Every gate_dirs entry must name a DIRECTORY holding at least one of
        # this module's files - a typo would otherwise silently fall back to
        # per-leaf gating, and a file entry would break .jinja suffix handling.
        for gated_dir in gate_dirs[module]:
            prefix = gated_dir.rstrip("/")
            if prefix in module_files:
                errors.append(
                    f"templates/{module}/{MANIFEST_NAME}: gate_dirs entry "
                    f"'{gated_dir}' is a file, not a directory - leaf files are "
                    "gated automatically; remove the entry"
                )
            elif not any(p.startswith(prefix + "/") for p in module_files):
                errors.append(
                    f"templates/{module}/{MANIFEST_NAME}: gate_dirs entry "
                    f"'{gated_dir}' matches none of the module's files - likely a "
                    "typo; fix the path or remove the entry"
                )
        for logical, entry in module_files.items():
            if "{%" in logical:
                errors.append(
                    f"templates/{module}/{logical}: module files must not hand-write "
                    f"filename gates; the composer adds the '{module}' gate "
                    "automatically (custom gates go in module.yml)"
                )
                continue
            if logical in files:
                other = files[logical][0]
                errors.append(
                    f"collision: templates/{other}/{logical} and "
                    f"templates/{module}/{logical} both provide {logical}. Additive "
                    "content must go through an anchor ({# compose:<name> #} plus "
                    f"{FRAGMENTS_DIR}/<name>{JINJA_SUFFIX}); otherwise hoist the file "
                    "to templates/base/ with an explicit {% if %} filename."
                )
                continue
            files[logical] = (module, entry)
        for anchor, body in collect_fragments(folder).items():
            fragments.setdefault(anchor, []).append((module, body))

    errors.extend(splice_fragments(files, fragments, gates))
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)

    output: dict[str, Entry] = {}
    emitted_errors: list[str] = []
    for logical, (source, entry) in files.items():
        if source == "base":
            emitted = logical
        else:
            emitted = gated_path(logical, gates[source], gate_dirs[source])
        if emitted in output:
            # Distinct logical paths can still emit the same name (e.g. a
            # hand-gated base filename plus the module's plain copy). A plain
            # `assert` would vanish under python -O and silently overwrite.
            emitted_errors.append(
                f"collision: two sources emit template/{emitted} (one of them via "
                "an explicit filename gate in base/) - delete the module copy or "
                "the hand-gated base file"
            )
            continue
        output[emitted] = entry
    if emitted_errors:
        for error in emitted_errors:
            print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
    return output


def write_output(composed: dict[str, Entry], out: Path) -> None:
    """Write the composed map into `out`, replacing it entirely."""
    if out.exists():
        shutil.rmtree(out)
    for path, entry in sorted(composed.items()):
        dest = out / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(entry, SymlinkEntry):
            # Source symlinks target the .jinja file so they are never
            # dangling in git (GitHub's action downloader refuses tarballs
            # with broken links); emitted links target the RENDERED name.
            target = entry.target
            if target.endswith(JINJA_SUFFIX):
                target = target.removesuffix(JINJA_SUFFIX)
            os.symlink(target, dest)
        else:
            dest.write_bytes(entry.data)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compose the local template/ artifact from the templates/ sources.",
    )
    parser.parse_args()
    composed = build()
    write_output(composed, OUT)
    print(f"composed {len(composed)} file(s) into template/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
