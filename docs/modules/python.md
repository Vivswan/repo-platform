---
order: 165
---

# Python

Selecting the `uv` module puts the fleet's Python lint floor on a repository: the managed [`ruff.toml`](https://github.com/Vivswan/repo-platform/blob/main/files/uv/ruff.toml) is the floor, fleet.yml's `ruff` step enforces it at a pinned ruff, and the repository builds on top in its own `pyproject.toml`. The files say what they hold; this page says how the two combine and what a repository may do underneath. The Python and uv versions stay the repository's own ([toolchains.md](../toolchains.md)).

## How ruff combines the two files

Ruff reads one configuration file per directory, `.ruff.toml` first, then `ruff.toml`, then `pyproject.toml`, and ignores the rest. The managed `ruff.toml` carries `extend = "pyproject.toml"`, the only reason the repository's `[tool.ruff]` counts: it is the parent, the managed file the child.

Ruff resolves the selection level by level, parent first, so the child's `extend-select` is applied last and a scalar (a threshold, the convention) takes the child's value. Measured at ruff 0.17.2:

| `pyproject.toml` carries | Result |
| --- | --- |
| a `[tool.ruff]` table with no `lint` keys | the floor's findings, with ruff's own default selection still beneath them |
| `[tool.ruff.lint] extend-select = ["D1"]` | `D103` reds beside the floor: the repository added a family |
| `[tool.ruff.lint] select = ["D1"]` | `D103` reds, and ruff's default selection is gone: `select` replaces it, `extend-select` keeps it |
| `[tool.ruff.lint] ignore = ["PLR0913"]` | `PLR0913` still fires: the child's `extend-select` re-selects the family after the parent's ignore |
| `[tool.ruff.lint.pylint] max-args = 20` | still `9 > 8`: the child's threshold wins |
| `[tool.ruff.lint.per-file-ignores] "sample.py" = ["PLR0913"]` | `PLR0913` off in that file alone |

So an `ignore` or a looser threshold in `pyproject.toml` does not lower the floor. The one way under it is `per-file-ignores`, scoped to named files and visible in a diff.

## Building on top

- **Additions are `extend-select` entries** in `[tool.ruff.lint]`, never a `select` list, which drops ruff's default selection on its way in.
- **A relaxation is a `per-file-ignores` entry** naming the files and the rule, with its reason in a comment beside it. Specimen: `PTH207` asks for `Path.glob` where `glob.glob` accepts absolute patterns and skips dotfiles, so the module that needs those keeps `glob.glob` under one entry.
- **A nested `pyproject.toml` with its own `[tool.ruff]`** governs the files under it alone, since ruff reads the closest configuration, and those files leave the floor entirely. A reviewer treats one as a relaxation of the whole subtree.
- **A root `pyproject.toml` is required** (the `extend` fails without one) and a root `.ruff.toml` is refused by the fleet's ruff step before it lints, since ruff would read it in place of the managed file, silently.

## Handling a finding

| The finding | The response |
| --- | --- |
| a rule violation | fix it |
| a function over a threshold (`C901`, the `PLR09` counts) | advisory: the gate run ignores them and a second step warns with their count; split when the split reads better, else leave it, or carry a known case in `per-file-ignores` |
| a rule whose fix would change behaviour, or a false positive, in named files | one `per-file-ignores` entry in `pyproject.toml`, its reason beside it |
| anything else | not a `# noqa` wall, not a root `.ruff.toml`, not an `ignore` (which the floor re-selects anyway) |

## What is not in the files

- **The thresholds warn in CI, by two runs:** ruff has no per-rule severity, so fleet.yml's gate run passes `--ignore` for `C901` and the `PLR09` counts and an advisory step selects those alone under `--exit-zero`. The managed `ruff.toml` stays whole, so a local `ruff check` still lists them. A threshold is a hint, and a forced split can read worse.
- **The ruff pin** (`uvx ruff@<version>`) appears in fleet.yml and in the uv starters' format lines; a test holds them to one version, and it is bumped by hand ([toolchains.md](../toolchains.md#the-pins)), since a ruff minor can add rules to a selected family.
- **A repository that already owns its workflows** gets `ruff.toml` on the next sync (one of its own there is a replaced local edit, which holds the sync PR for review) and is linted by the fleet gate from that sync on; it copies the format steps from the [uv blocks](https://github.com/Vivswan/repo-platform/tree/main/files/uv/.github/workflows) into its `checks.yml` and `auto-format.yml` by hand, since starters are written once ([platform/sync/writer.md](../platform/sync/writer.md#classes)).
- **A NumPy-style docstring section is not rejected:** ruff's `google` convention judges Google-style sections and passes an underlined `Parameters` block untouched (ruff 0.17), so a repository converting from NumPy style converts by hand.
