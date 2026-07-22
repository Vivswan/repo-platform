#!/usr/bin/env python3
"""Validate repos.yml: `managed` must be a list of owner/repo slugs."""

import re
import sys
from pathlib import Path

import yaml


def main() -> int:
    repos = yaml.safe_load(Path("repos.yml").read_text(encoding="utf-8"))["managed"]
    if not isinstance(repos, list):
        sys.exit("repos.yml: managed must be a list")
    bad = [r for r in repos if not re.fullmatch(r"[\w.-]+/[\w.-]+", str(r))]
    if bad:
        sys.exit(f"repos.yml: invalid entries: {bad}")
    print(f"repos.yml: {len(repos)} managed repo(s) OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
