---
order: 165
---

# Python

Selecting the `uv` module gives a repository the ruff steps that make the fleet's docstring floor a gate: Google-style docstrings, judged by ruff's pydocstyle rules under the `google` convention. This page is the floor's contract; the Python and uv versions stay the repository's own ([toolchains.md](../toolchains.md)).

## The floor

The floor rides ruff's command line in the module's steps, so a repository's own ruff `select` and `ignore` stay its own and cannot lower it (a `per-file-ignores` entry still exempts the files it names, as any local exemption does):

```text
uvx ruff check --extend-select D2,D3,D4 --config 'lint.pydocstyle.convention = "google"' .
```

The families are D2xx (whitespace), D3xx (quotes), and D4xx (content), as the `google` convention keeps them; ruff's pydocstyle documentation lists the rules that convention switches off. The findings a repository meets first:

| Finding | What it says |
| --- | --- |
| D205 | one blank line between the summary line and the description |
| D403 | the summary's first word is capitalized |
| D416 | a Google section header ends with a colon |
| D417 | every argument not prefixed with an underscore is described, where an `Args` section exists |

The findings on a docstring whose `Args` header lacks its colon and leaves `b` undescribed:

```text
$ uvx ruff check --quiet --output-format concise --extend-select D2,D3,D4 --config 'lint.pydocstyle.convention = "google"' .
t.py:1:5: D417 Missing argument description in the docstring for `add`: `b`
t.py:4:5: D416 [*] Section name should end with a colon ("Args")
```

A docstring the floor accepts:

```python
def add(a: int, b: int) -> int:
    """Add two numbers.

    Args:
        a: First addend.
        b: Second addend.

    Returns:
        The sum.
    """
    return a + b
```

- **A missing docstring is not a finding.** The presence rules (D1xx) are not selected. A repository that wants them selects them in its own configuration, and the floor leaves that selection standing.
- **A NumPy-style section is not rejected.** Ruff's `google` convention judges Google-style sections and passes an underlined `Parameters` block untouched (ruff 0.17), so a repository converting from NumPy style converts by hand.

## How a repository takes it

The workflows are starters, written once ([platform/sync/writer.md](../platform/sync/writer.md#classes)):

1. **A new repository:** the sync writes `checks.yml` and `auto-format.yml` with the ruff steps in place.
2. **A repository that already owns them:** copy the ruff steps from the [uv blocks](https://github.com/Vivswan/repo-platform/tree/main/files/uv/.github/workflows) into its `checks.yml` and `auto-format.yml`.

## The gate

The module's toolchain blocks ([platform/sync/files.md](../platform/sync/files.md#filesyml-reference)) put these steps into the repo-owned `checks.yml`:

```yaml
- uses: astral-sh/setup-uv@<sha> # v10.0.1
- run: uvx ruff check --extend-select D2,D3,D4 --config 'lint.pydocstyle.convention = "google"' .
- run: uvx ruff format --check .
```

- **`uvx ruff` floats** on the latest release; the version policy is [toolchains.md](../toolchains.md)'s.
- **`auto-format.yml`** runs the same check with `--fix`, then `ruff format`, on the `fix-lint` label: the findings ruff marks fixable (`[*]`) are fixed by the label, the rest by hand.
