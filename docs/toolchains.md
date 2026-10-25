---
order: 210
group: Fleet operations
---

# Toolchain pins

One version per toolchain, fleet-wide, spelled once: a version dotfile under `files/<module>/` holds exactly the version plus a newline, every consumer reads that file, and the refresh below is its only writer.

## The pins

| Toolchain | Pin | Readers |
|---|---|---|
| bun | [files/bun/.bun-version](../files/bun/.bun-version) | the fleet's synced `.bun-version`; this repository's workflows (`bun-version-file: files/bun/.bun-version`); every composite action's bun-setup step, through this repository's own synced root copy; `@types/bun` in every package declaring it, pinned exactly to it |

bun is the one pinned toolchain. uv floats on its setup action's default, and the rust blocks' setup action installs the toolchain the repository's `rust-toolchain.toml` names (stable when there is none), so rust version selection stays repository-owned.

- **Dependabot's bun PRs** install with the lockfile Dependabot wrote; a PR whose frozen install fails is fixed by hand, or by re-running Dependabot on it.
- **A known limitation, accepted:** Dependabot's bun runner reads `bun.lock` lockfileVersion 1 only, while bun 1.4 writes version 2 ([dependabot-core#15848](https://github.com/dependabot/dependabot-core/issues/15848)), so a Dependabot bun PR that cannot be rebased is closed and the bump made by hand.

## The biome pin

biome is a tool pin, not a toolchain pin: one version, spelled in four places, and `tests/files/biome_floor.test.ts` holds them equal. A bump edits all four in one PR.

| Where | Line |
|---|---|
| [actions/biome/package.json](../actions/biome/package.json) | the `@biomejs/biome` dependency: the one biome the fleet lints with |
| the root `package.json` | the same devDependency: the biome this repository lints itself with |
| [files/bun/biome.json](../files/bun/biome.json) and this repository's root copy | the version inside the `$schema` URL |
| [the auto-format starter](../files/bun/.github/workflows/auto-format.toolchain.yml) | `bun x @biomejs/biome@<version> check --write .`, so the formatter a repository runs is the linter's version |

A starter is written once, so an existing `auto-format.yml` keeps the version it was written with until the repository edits it; the gate's biome is always the action's.

The fleet's yamllint step is not a module pin: `actions/yamllint/requirements.txt` pins the yamllint the action installs, and dependabot's pip entry for that directory bumps it. The action is the one yamllint gate; this repository runs no yamllint locally, since the hook runs bun's own checks alone (fleet-guidelines, "Pre-commit hooks only check").

The fleet's ruff step is not a module pin either: the version is spelled inline, `uvx ruff@<version>`, in fleet.yml's `ruff` step and in the uv starters' format lines, and tests/files/ruff_floor.test.ts holds every site to one version. It is bumped by hand, never by the refresh: a ruff minor can add rules to a selected family, so a bump changes the [Python lint floor](modules/python.md) and is reviewed as one.

## How the pin reaches repositories

- **Managed files:** the dotfiles are MANAGED files (deliberately not starters). In a repo selecting the module, every sync updates them, and no registration key overrides them: the fleet shares one version per toolchain.

- **Version-file inputs:** managed workflows and the repo-owned starters as first written pass the matching version-file input (`bun-version-file: .bun-version`).

- **The site hook:** the [site module's](modules/site.md) build hook is the repository's own composite action, so it installs whatever toolchain its steps name (the seeded example reads `.bun-version`); the fleet's docs build runs under the fleet's own bun, never the repository's pin.

- **Parity:** validate-managed-files fails a repo whose dotfile differs from the one its recorded commit's sync writes ([platform/sync/manifest.md](platform/sync/manifest.md#judged-at-the-synced-commit)).

## How the composite actions pin bun

repo-platform's own composite actions (under `actions/`) pin their bun from the root `.bun-version` the sync writes from the same file, which every `uses:` fetch carries: it is the whole repository at the ref.

- Each action's first step calls the shared `actions/bun-setup` action (`uses: $/actions/bun-setup` with `from` set to `github.action_path`). It walks up from that directory to the nearest `.bun-version` (the root's synced copy) and fails when none exists; it reuses a bun on PATH at the pin or installs it with oven-sh/setup-bun (one retry for the known network flake), and records the absolute path of the bun that prints the pin as `path`.

- Every later step runs that path, never `bun` by name, because a later setup-bun can put another bun first on PATH.

- A bun still missing after the setup and its retry fails the action, naming the pin: no action reports around a missing bun.

- The actions run vendored scripts and action-local lockfiles inside caller checkouts, so the CALLER's version resolution must never pick their bun: a repository pinning an older bun cannot parse the lockfiles repo-platform's bun writes. `tests/actions/bun_setup_first.test.ts` asserts that shape of every action shipping a bun.lock: the setup step first, no bare `bun` line.

- ci.yml's bun-setup-smoke job puts the pinned bun on the runner, then calls the shared action from the working tree once per planted pin (that version, reused; an earlier release, installed) and judges both calls' outputs.

- The validator script directory inside validate-managed-files (`actions/validate-managed-files/validator`) is part of that action's one package, so the action's pin covers it: the action runs the validator on its own bun.

## Overriding, per toolchain

To run one repo on a different version, override in a repo-owned workflow and leave the dotfile alone:

| Toolchain | Override |
|---|---|
| bun | pass the explicit version input (`bun-version:` on setup-bun), which the action prefers over its version-file input |
| rust | commit a `rust-toolchain.toml` naming the channel (1.84 or newer, [rust.md](modules/rust.md#the-floor)) and components; the setup action in the three rust blocks installs it, with no dotfile to leave alone |

Rules that follow:

- **Never hand-edit the dotfile:** it is managed, so the next sync overwrites it, with the change visible only in the sync PR. Keep deliberate divergence in the workflow inputs above.

- **Starters are written once:** repo-owned starters (`auto-format.yml`, `copilot-setup-steps.yml`, the `checks.yml` examples) are never resynced, so a later change to a starter reaches an existing copy only by hand.

- **Drop `packageManager`:** once the dotfile pins bun, drop any `packageManager` field for it from `package.json`. setup-bun falls back to `packageManager`/`engines.bun` only when no version input or file matched, so a stale field is at best dead and at worst a second, disagreeing pin.

## Keeping the pins fresh

A pinned module declares its pin in `files.yml` (`modules.<name>.pin`, its keys defined in [platform/sync/files.md](platform/sync/files.md#module-data)), data the refresh reads and never content the sync writes. bun's, the only one today:

| Key | bun |
|---|---|
| `file` | `files/bun/.bun-version` |
| `repository` | `oven-sh/bun` |
| `tag` | `bun-v{version}` |

[refresh-upstream.yml](../.github/workflows/refresh-upstream.yml) (weekly cron plus manual dispatch) runs `release` pins as one matrix leg beside the `commit` pins of [platform/sync/files.md](platform/sync/files.md#upstream-refs), each on its own PR branch, so a toolchain bump is never held behind a gitignore diff:

1. **Fetch each pin's latest release** (`releases/latest`, never a prerelease) and read the version through `tag`; a tag of another shape is refused. An unreachable source, or a "latest" older than the pin (a backport surfacing as latest), aborts the run: such a view cannot tell "nothing moved" from "could not see upstream's newest".

2. **Write the dotfile** of each pin that moved. A bun bump also pins `@types/bun` to the same version in every package declaring it (`bun add --dev --exact`), which is why `.github/dependabot.yml` ignores that package; the types publish per bun release, so a run before they exist fails at the add and the next run retries.

3. **Open or refresh a PR** on the `automation/refresh-release-pins` branch when anything moved; a bump across a major line leads the body with a callout. The PR's CI is the commit's gate.

4. **Close a PR main already carries:** when nothing moved and that PR is still open, main already carries its pins, so the PR is closed and its branch deleted.

Merging the PR moves the `stable` tag once its gate is green; the next sync rolls the pin out to the fleet.
