---
order: 165
---

# Python

Selecting the `uv` module puts the fleet's Python lint floor on a repository: the managed `ruff.toml` carries the owner's code-standards ruff block, fleet.yml's `ruff` step enforces it at a pinned ruff, and the repository builds on top in its own `pyproject.toml`. This page is the floor's contract; the Python and uv versions stay the repository's own ([toolchains.md](../toolchains.md)).

## The floor

The sync writes `ruff.toml`, a managed file, beside the repository's `pyproject.toml`:

```toml
extend = "pyproject.toml"

[lint]
extend-select = ["C90", "PLR", "PLW", "RET", "PIE", "C4", "PERF", "ERA", "N", "ARG", "PTH", "RUF", "ANN", "D2", "D3", "D4"]
ignore = [
  "PLR2004", # a literal beside its comparison reads better than a one-use constant
  "D202", # a blank line after the docstring sets it apart from the body
]

[lint.mccabe]
max-complexity = 12

[lint.pylint]
max-branches = 12
max-statements = 50
max-args = 8
max-returns = 6

[lint.pydocstyle]
convention = "google"
```

| Family | What it holds |
| --- | --- |
| `C90` | mccabe complexity, at most 12 per function |
| `PLR`, `PLW` | pylint's refactor and warning rules: at most 12 branches, 50 statements, 8 arguments, and 6 returns per function |
| `RET`, `PIE`, `C4`, `PERF` | return shape, misc pitfalls, comprehensions, performance idioms |
| `ERA` | no commented-out code |
| `N` | pep8 naming |
| `ARG` | no unused argument |
| `PTH` | `pathlib` over `os.path` |
| `RUF` | ruff's own rules |
| `ANN` | every signature annotated |
| `D2`, `D3`, `D4` | docstring whitespace, quotes, and content, under the `google` convention |

Off, with the reason beside each in the file: `PLR2004` (magic values) and `D202` (the blank line after a docstring). The presence rules `D1` are neither selected nor ignored, so a repository can add them (below) and a small helper whose name says what it does carries no docstring until it does.

## How ruff merges the two files

`ruff.toml` has `extend = "pyproject.toml"`: the repository's `[tool.ruff]` is the parent and the managed file the child. Ruff resolves the selection level by level, parent first, so the child's `extend-select` is applied last, and a scalar (a threshold, the convention) takes the child's value. The scratch run below, at ruff 0.17.2, shows what that gives a repository:

| `pyproject.toml` carries | Result |
| --- | --- |
| a `[tool.ruff]` table with no `lint` keys | the floor's findings, with ruff's own default selection still beneath them |
| `[tool.ruff.lint] extend-select = ["D1"]` | `D103` reds beside the floor: the repository added a family |
| `[tool.ruff.lint] select = ["D1"]` | `D103` reds, and ruff's default selection is gone: `select` replaces it, `extend-select` keeps it |
| `[tool.ruff.lint] ignore = ["PLR0913"]` | `PLR0913` still reds: the child's `extend-select` re-selects the family after the parent's ignore |
| `[tool.ruff.lint.pylint] max-args = 20` | still `9 > 8`: the child's threshold wins |
| `[tool.ruff.lint.per-file-ignores] "sample.py" = ["PLR0913"]` | `PLR0913` off in that file alone |

So an `ignore` or a looser threshold in `pyproject.toml` does not lower the floor. The one way under it is `per-file-ignores`, scoped to named files and visible in a diff.

## Building on top

- **Additions are `extend-select` entries** in `[tool.ruff.lint]`, never a `select` list, which drops ruff's default selection on its way in.
- **A relaxation is a `per-file-ignores` entry** naming the files and the rule, with its reason in a comment beside it. Specimen: `PTH207` asks for `Path.glob` where `glob.glob` accepts absolute patterns and skips dotfiles, so the module that needs those keeps `glob.glob` under one entry.
- **The thresholds are the floor's.** A function over one is split; a threshold in `pyproject.toml` has no effect.
- **A nested `pyproject.toml` with its own `[tool.ruff]`** governs the files under it alone, since ruff reads the closest configuration, and those files leave the floor entirely. A reviewer treats one as a relaxation of the whole subtree.
- **A uv repository needs a `pyproject.toml` at its root,** since the `extend` fails without one, and keeps no `.ruff.toml`, which ruff would read in place of the managed file, silently.
- **The editor sees the floor too:** a ruff run from the repository root reads the same two files CI reads.

## Handling a finding

| The finding | The response |
| --- | --- |
| a rule violation | fix it |
| a function over a threshold | split it into named steps |
| a rule whose fix would change behaviour, or a false positive, in named files | one `per-file-ignores` entry in `pyproject.toml`, its reason beside it |
| anything else | not a `# noqa` wall, not a root `.ruff.toml`, not an `ignore` (which the floor re-selects anyway) |

## The gate

fleet.yml's `standard-checks` job runs the lint half on every push and pull request of a uv repository, after the base checks and before knip:

```yaml
- id: uv
  if: >-
    !cancelled() && steps.plan.outcome == 'success' && github.event_name != 'schedule' &&
    contains(steps.plan.outputs.modules, '"uv"')
  uses: astral-sh/setup-uv@<sha> # v10.0.1
- id: ruff
  if: ${{ !cancelled() && steps.uv.outcome == 'success' && hashFiles('ruff.toml') != '' }}
  run: uvx ruff@0.17.2 check --no-fix --no-fix-only .
- name: Note why ruff stood down
  if: ${{ !cancelled() && steps.uv.outcome == 'success' && steps.ruff.outcome == 'skipped' }}
  run: echo "::notice::ruff stood down, this repository has no ruff.toml until its first sync writes it"
```

- **`--no-fix --no-fix-only`:** a repository's own `fix = true` or `fix-only = true` would otherwise repair findings in the runner or exit green on unfixable ones; the gate judges the committed files, and the `fix-lint` label repairs.
- **The pin:** `uvx ruff@0.17.2` here and in the uv starters' format lines, held to one version by a test and bumped by hand ([toolchains.md](../toolchains.md#the-pins)), since a ruff minor can add rules to a selected family.
- **The stand-down:** a repository registered before its first sync has no `ruff.toml` yet, so the step skips with a notice. Once a sync has recorded the file, a deleted one is red through validate-managed-files, so the stand-down is no bypass.
- **The formatter's half** stays in the repo-owned `checks.yml`: `uvx ruff@0.17.2 format --check .`, from the module's toolchain block ([platform/sync/files.md](../platform/sync/files.md#filesyml-reference)).
- **`auto-format.yml`** runs `ruff check --fix`, then `ruff format`, on the `fix-lint` label, at the same pin: the findings ruff marks fixable (`[*]`) are fixed by the label, the rest by hand.

## How a repository takes it

`ruff.toml` is managed, so every sync writes it; the workflows are starters, written once ([platform/sync/writer.md](../platform/sync/writer.md#classes)):

1. **A new repository:** the sync writes `ruff.toml`, `checks.yml`, and `auto-format.yml` with the ruff steps in place, and the fleet gate lints from the first push after it.
2. **A repository that already owns the workflows:** the next sync brings `ruff.toml` (a `ruff.toml` of the repository's own there is a replaced local edit, which holds the sync PR for review), and the fleet gate lints from that sync on; copy the format steps from the [uv blocks](https://github.com/Vivswan/repo-platform/tree/main/files/uv/.github/workflows) into its `checks.yml` and `auto-format.yml`.

## The docstring shape

The `D` families under the `google` convention hold the shape of every docstring that exists; ruff's pydocstyle documentation lists the rules the convention switches off. The findings a repository meets first:

| Finding | What it says |
| --- | --- |
| D205 | one blank line between the summary line and the description |
| D403 | the summary's first word is capitalized |
| D416 | a Google section header ends with a colon |
| D417 | every argument not prefixed with an underscore is described, where an `Args` section exists |

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

A NumPy-style section is not rejected: ruff's `google` convention judges Google-style sections and passes an underlined `Parameters` block untouched (ruff 0.17), so a repository converting from NumPy style converts by hand.
