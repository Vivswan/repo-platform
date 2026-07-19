#!/usr/bin/env python3
"""From-version migration runner (pattern from copilot-env src/migrations).

Copier's native `_migrations` gates each entry on the version being updated
TO, which forces authors to predict the next release number - awkward with
release-please, where the number is only known when the release PR merges.
Instead copier.yml registers this single unconditional runner, and selection
happens here: each migration script is named for the release it migrates
AWAY from and runs when an update leaves that version behind, i.e. its
version falls in the half-open range [from, to).

Contract for migrations/<X.Y.Z>.py scripts:
- named for the released version they migrate away from (bare X.Y.Z)
- executed with cwd = the downstream repository being updated
- IDEMPOTENT: an update can be retried, so a script may run more than once
- best-effort: a failing script warns and the rest still run (the sync PR's
  validation step catches structural damage); migrations must never abort
  an otherwise-successful update

Invoked by copier with VERSION_FROM / VERSION_TO / STAGE in the environment
(positional args override: run.py <from> <to>). Versions arrive as git refs
of the build branches: `templates/vX.Y.Z` build tags on the latest channel
(the prefix is stripped here), or describe/sha strings on the staging
channel, which do not parse as semver - staging updates run no migrations.
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def parse(version: str):
    v = version.strip().removeprefix("templates/").removeprefix("v")
    match = SEMVER.match(v)
    return tuple(int(g) for g in match.groups()) if match else None


def due_migrations(vfrom, vto):
    """Scripts whose from-version falls in [vfrom, vto), ascending."""
    due = []
    for path in HERE.glob("*.py"):
        if path.name == "run.py":
            continue
        version = parse(path.stem)
        if version and vfrom <= version < vto:
            due.append((version, path))
    return sorted(due)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run due template migrations (from-version selection).",
    )
    parser.add_argument(
        "version_from",
        nargs="?",
        default=os.environ.get("VERSION_FROM", ""),
        help="version being updated away from (default: $VERSION_FROM)",
    )
    parser.add_argument(
        "version_to",
        nargs="?",
        default=os.environ.get("VERSION_TO", ""),
        help="version being updated to (default: $VERSION_TO)",
    )
    args = parser.parse_args()
    vfrom, vto = parse(args.version_from), parse(args.version_to)

    if vfrom is None or vto is None or vto <= vfrom:
        print(
            f"migrations: nothing to do (from={args.version_from or '?'} to={args.version_to or '?'})"
        )
        return 0

    due = due_migrations(vfrom, vto)
    if not due:
        print(f"migrations: none due for {args.version_from} -> {args.version_to}")
        return 0

    for version, path in due:
        label = ".".join(map(str, version))
        print(f"migrating from {label}: {path.name}")
        result = subprocess.run([sys.executable, str(path)])
        if result.returncode != 0:
            print(
                f"warning: migration {label} exited {result.returncode} (non-fatal)",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
