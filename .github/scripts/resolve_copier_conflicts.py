#!/usr/bin/env python3
"""Resolve copier's inline merge-conflict markers in favor of the template.

`copier update --conflict inline` (the default) renders overlapping local
edits as git-style conflict blocks:

    <(x7) before updating
    local lines
    =(x7)
    template lines
    >(x7) after updating

This script keeps the "after updating" (template) side of every block and
collects the dropped local lines into a markdown summary, which the template
sync workflow embeds in the PR body so a human can restore anything that
should stay local. The full summary goes to stdout; the --summary file drops
whole trailing sections past --limit bytes so it fits a PR body with its
markdown fences intact.

A file whose markers are malformed (missing, nested, or out-of-order marker
lines) is left untouched and noted in the summary; the validator then fails
on the remaining markers and the sync run goes red for manual editing.

Usage:
  python3 resolve_copier_conflicts.py --summary /path/to/summary.md [--root .]
"""

import argparse
import sys
from pathlib import Path

# Built by concatenation so this file never contains a literal marker line
# (the validator flags those in any text file).
START = b"<" * 7 + b" before updating"
SEP = b"=" * 7
END = b">" * 7 + b" after updating"

SKIP_DIRS = {
    ".git",
    ".repo-platform-src",
    "node_modules",
    ".venv",
    "__pycache__",
}


def resolve(data: bytes) -> tuple[bytes, list[bytes], bool]:
    """Return (resolved content, dropped local hunks, malformed).

    Malformed means a marker line outside the strict START/SEP/END sequence;
    the caller must then leave the file untouched.
    """
    lines = data.split(b"\n")
    out: list[bytes] = []
    dropped: list[bytes] = []
    i = 0
    while i < len(lines):
        stripped = lines[i].rstrip(b"\r")
        if stripped in (SEP, END):
            return data, [], True
        if stripped != START:
            out.append(lines[i])
            i += 1
            continue
        j = i + 1
        while j < len(lines) and lines[j].rstrip(b"\r") != SEP:
            if lines[j].rstrip(b"\r") in (START, END):
                return data, [], True
            j += 1
        k = j + 1
        while k < len(lines) and lines[k].rstrip(b"\r") != END:
            if lines[k].rstrip(b"\r") in (START, SEP):
                return data, [], True
            k += 1
        if j >= len(lines) or k >= len(lines):
            return data, [], True
        dropped.append(b"\n".join(lines[i + 1 : j]))
        out.extend(lines[j + 1 : k])
        i = k + 1
    return b"\n".join(out), dropped, False


def fence_for(text: str) -> str:
    longest = run = 0
    for char in text:
        run = run + 1 if char == "`" else 0
        longest = max(longest, run)
    return "`" * max(4, longest + 1)


def summarize(rel: str, dropped: list[bytes], malformed: bool) -> str:
    lines = [f"#### `{rel}`", ""]
    if malformed:
        lines += [
            "Malformed or out-of-order conflict markers; left unresolved for manual editing.",
            "",
        ]
        return "\n".join(lines)
    for n, hunk in enumerate(dropped, 1):
        text = hunk.decode("utf-8", errors="replace")
        lines += [f"Conflict {n}: dropped local lines (template version kept):", ""]
        if text.strip():
            fence = fence_for(text)
            lines += [fence, text, fence, ""]
        else:
            lines += ["(none; the local side of the conflict was empty)", ""]
    return "\n".join(lines)


def truncate(sections: list[str], limit: int) -> str:
    """Assemble the summary, dropping whole sections past the byte budget.

    Cutting at section boundaries keeps the markdown fences balanced.
    """
    full = "\n".join(sections)
    if len(full.encode("utf-8")) <= limit:
        return full
    budget = limit - 100  # room for the omitted-count note
    kept: list[str] = []
    size = 0
    for index, section in enumerate(sections):
        section_size = len(section.encode("utf-8")) + 1
        if size + section_size > budget:
            omitted = len(sections) - index
            kept.append(f"({omitted} file(s) omitted; the full list is in this sync run's log)")
            break
        kept.append(section)
        size += section_size
    return "\n".join(kept)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", required=True, type=Path)
    parser.add_argument("--root", default=".", type=Path)
    parser.add_argument("--limit", type=int, default=20000)
    args = parser.parse_args()
    if args.limit < 200:
        parser.error("--limit must be at least 200")

    sections: list[str] = []
    for path in sorted(args.root.rglob("*")):
        if any(part in SKIP_DIRS for part in path.relative_to(args.root).parts):
            continue
        if not path.is_file() or path.is_symlink():
            continue
        data = path.read_bytes()
        if START not in data:
            continue
        rel = str(path.relative_to(args.root))
        resolved, dropped, malformed = resolve(data)
        if malformed:
            print(f"{rel}: malformed or out-of-order conflict markers, left untouched")
        elif dropped:
            path.write_bytes(resolved)
            print(f"{rel}: resolved {len(dropped)} conflict(s) toward the template")
        else:
            # Marker bytes appear only mid-line (not a conflict); skip.
            continue
        sections.append(summarize(rel, dropped if not malformed else [], malformed))

    full = "\n".join(sections)
    if full:
        print(full)
    args.summary.write_text(truncate(sections, args.limit), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
