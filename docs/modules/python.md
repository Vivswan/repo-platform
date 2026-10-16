---
order: 165
---

# Python

Selecting the `uv` module gives a repository the ruff steps that make the fleet's docstring floor a gate: Google-style docstrings, judged by ruff's pydocstyle rules under the `google` convention. This page is the floor's contract; the Python and uv versions stay the repository's own ([toolchains.md](../toolchains.md)).

## The floor

The sync writes `ruff.toml`, a managed file, beside the repository's `pyproject.toml` and extends it:

```toml
extend = "pyproject.toml"

[lint]
extend-select = ["D2", "D3", "D4"]

[lint.pydocstyle]
convention = "google"
```

- **The repository's settings stay in `pyproject.toml`** under `[tool.ruff]`, read through the `extend`: its own `select`, `ignore`, and `line-length` apply, and an `ignore = ["D"]` there does not lower the floor.
- **Two local exemptions remain,** both visible in a diff: a `per-file-ignores` entry exempts the files it names, and a nested `pyproject.toml` with its own `[tool.ruff]` governs the files under it, since ruff reads the closest configuration.
- **The editor sees the floor too:** a ruff run from the repository root reads the same file CI reads.
- **A uv repository needs a `pyproject.toml`** at its root, since the `extend` fails without one, and must keep no `.ruff.toml`, which ruff would read instead of the managed file, silently.

The families are D2xx (whitespace), D3xx (quotes), and D4xx (content), as the `google` convention keeps them; ruff's pydocstyle documentation lists the rules that convention switches off. The findings a repository meets first:

| Finding | What it says |
| --- | --- |
| D205 | one blank line between the summary line and the description |
| D403 | the summary's first word is capitalized |
| D416 | a Google section header ends with a colon |
| D417 | every argument not prefixed with an underscore is described, where an `Args` section exists |

The findings on a docstring whose `Args` header lacks its colon and leaves `b` undescribed:

```text
$ uvx ruff check --quiet --output-format concise .
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

- **A missing docstring is not a finding.** The presence rules (D1xx) are not selected. A repository that wants them selects them in its own `pyproject.toml`, and the floor leaves that selection standing.
- **A NumPy-style section is not rejected.** Ruff's `google` convention judges Google-style sections and passes an underlined `Parameters` block untouched (ruff 0.17), so a repository converting from NumPy style converts by hand.

## How a repository takes it

`ruff.toml` is managed, so every sync writes it; the workflows are starters, written once ([platform/sync/writer.md](../platform/sync/writer.md#classes)):

1. **A new repository:** the sync writes `ruff.toml`, `checks.yml`, and `auto-format.yml` with the ruff steps in place.
2. **A repository that already owns the workflows:** the next sync brings `ruff.toml` (a `ruff.toml` of the repository's own there is a replaced local edit, which holds the sync PR for review); copy the ruff steps from the [uv blocks](https://github.com/Vivswan/repo-platform/tree/main/files/uv/.github/workflows) into its `checks.yml` and `auto-format.yml`.

## The gate

The module's toolchain blocks ([platform/sync/files.md](../platform/sync/files.md#filesyml-reference)) put these steps into the repo-owned `checks.yml`:

```yaml
- uses: astral-sh/setup-uv@<sha> # v10.0.1
- run: uvx ruff check --no-fix --no-fix-only .
- run: uvx ruff format --check .
```

- **`--no-fix --no-fix-only`:** a repository's own `fix = true` or `fix-only = true` would otherwise repair findings in the runner or exit green on unfixable ones; the gate judges the committed files, and the label repairs.
- **`uvx ruff` floats** on the latest release; the version policy is [toolchains.md](../toolchains.md)'s.
- **`auto-format.yml`** runs the same check with `--fix`, then `ruff format`, on the `fix-lint` label: the findings ruff marks fixable (`[*]`) are fixed by the label, the rest by hand.
