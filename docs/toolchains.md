---
order: 210
group: Fleet operations
---

# Toolchain pins

One version per toolchain, fleet-wide, spelled once: a version dotfile under `files/<module>/` holds exactly the version plus a newline, every consumer reads that file, and the refresh below is its only writer.

## The pins

| Toolchain | Pin | Readers |
|---|---|---|
| bun | [files/bun/.bun-version](../files/bun/.bun-version) | the fleet's synced `.bun-version`; this repository's workflows (`bun-version-file: files/bun/.bun-version`); every composite action's bun-setup step; `scripts/bootstrap.ts`, which refuses a local bun at another MAJOR.MINOR; `@types/bun` in every package declaring it, pinned exactly to it |
| deno | [files/deno/.dvmrc](../files/deno/.dvmrc) | the fleet's synced `.dvmrc` |

Modules without a pin: uv floats on its setup action's default, and rust ships no toolchain setup in CI, so rust version selection stays repository-owned.

The fleet's yamllint step is not a module pin: `actions/yamllint/requirements.txt` pins the yamllint the action installs and the pathspec release its ignore list is matched with (the validate-managed-files scan ports that release), dependabot's pip entry for that directory bumps them, and this repository's `lint:yaml` script installs from the same file.

## How the pin reaches repositories

- **Managed files:** the dotfiles are MANAGED files (deliberately not starters). In a repo selecting the module, every sync updates them, and no registration key overrides them: the fleet shares one version per toolchain.

- **Version-file inputs:** managed workflows and the repo-owned starters as first written pass the matching version-file input (`bun-version-file: .bun-version`, `deno-version-file: .dvmrc`).

- **The site hook:** the [site module's](site.md) build hook is the repository's own composite action, so it installs whatever toolchain its steps name (the seeded example reads `.bun-version`); the fleet's docs build runs under the fleet's own bun, never the repository's pin.

- **Parity:** validate-managed-files fails a repo whose dotfile differs from the one its recorded commit's sync writes.

- **This repository's actions:** repo-platform's own composite actions (under `actions/`) pin their bun from the same file. A `uses:` fetch is the whole repository at the ref, so the pin path climbs from the action's directory to the repository root.

**How the actions pin their bun:**

- Each action's first step calls the shared `actions/bun-setup` action (`uses: Vivswan/repo-platform/actions/bun-setup@stable` with `pin` set to the pin's path relative to `github.action_path`, `../../files/bun/.bun-version` for a top-level action). It reuses a bun already on PATH at the pin, installs it with oven-sh/setup-bun otherwise (one retry for the known network flake), and records the absolute path of the bun that prints the pin as `path`.

- Every later step runs that path, never `bun` by name, because a later setup-bun can put another bun first on PATH.

- validate-managed-files passes `required: "false"` and gates its legs on the `ready` output, so its report step still runs and reports a missing bun instead of the action dying before it.

- The actions run vendored scripts and action-local lockfiles inside caller checkouts, so the CALLER's version resolution must never pick their bun: a repository pinning an older bun cannot parse the lockfiles repo-platform's bun writes. `tests/actions/bun_setup_first.test.ts` asserts that shape of every action shipping a bun.lock: the setup step first, no bare `bun` line.

- ci.yml's bun-setup-smoke job puts the pinned bun on the runner, then calls the shared action from the working tree once per planted pin (that version, reused; an earlier release, installed) and judges both calls' outputs.

- The validator script directory inside validate-managed-files (`actions/validate-managed-files/validator`) is part of that action's one package, so the action's pin covers it: the action runs the validator on its own bun.

## Overriding, per toolchain

To run one repo on a different version, override in a repo-owned workflow and leave the dotfile alone:

| Toolchain | Override |
|---|---|
| bun | pass the explicit version input (`bun-version:` on setup-bun), which the action prefers over its version-file input |
| deno | setup-deno resolves the other way around (a non-empty `deno-version-file` wins over `deno-version`), so replace or remove the `deno-version-file:` line instead |

Rules that follow:

- **Never hand-edit the dotfile:** it is managed, so the next sync overwrites it, with the change visible only in the sync PR. Keep deliberate divergence in the workflow inputs above.

- **Starters are written once:** repo-owned starters (`auto-format.yml`, `copilot-setup-steps.yml`, the `checks.yml` examples) are never resynced, so a later change to a starter reaches an existing copy only by hand.

- **Drop `packageManager`:** once the dotfile pins bun, drop any `packageManager` field for it from `package.json`. setup-bun falls back to `packageManager`/`engines.bun` only when no version input or file matched, so a stale field is at best dead and at worst a second, disagreeing pin.

## Keeping the pins fresh

Each pinned module declares its pin in `files.yml` (`modules.<name>.pin`), data the refresh reads and never content the sync writes:

| Key | Meaning | bun |
|---|---|---|
| `file` | the version dotfile under `files/` | `files/bun/.bun-version` |
| `repository` | the github.com repository whose latest release the pin follows | `oven-sh/bun` |
| `tag` | its release tag with `{version}` where the version stands | `bun-v{version}` |

[refresh-upstream.yml](../.github/workflows/refresh-upstream.yml) (weekly cron plus manual dispatch) runs `release` pins as one matrix leg beside the `commit` pins of [sync.md](sync.md#upstream-refs), each on its own PR branch, so a toolchain bump is never held behind a gitignore diff:

1. **Fetch each pin's latest release** (`releases/latest`, never a prerelease) and read the version through `tag`; a tag of another shape is refused. An unreachable source, or a "latest" older than the pin (a backport surfacing as latest), aborts the run: such a view cannot tell "nothing moved" from "could not see upstream's newest".

2. **Write the dotfile** of each pin that moved. A bun bump also pins `@types/bun` to the same version in every package declaring it (`bun add --dev --exact`), which is why `.github/dependabot.yml` ignores that package; the types publish per bun release, so a run before they exist fails at the add and the next run retries.

3. **Open or refresh a PR** on the `automation/refresh-release-pins` branch when anything moved; a bump across a major line leads the body with a callout. The commit runs under `HUSKY=0`, so the developer pre-commit hook never judges it on the runner; the PR's CI is its gate. When nothing moved and that PR is still open, main already carries its pins, so the PR is closed and its branch deleted.

Merging the PR moves the `stable` tag once its gate is green; the next sync rolls the pin out to the fleet.
