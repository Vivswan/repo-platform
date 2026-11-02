---
order: 210
group: Fleet operations
---

# Toolchain pins

One version per toolchain, fleet-wide, spelled once: a version dotfile under `files/<module>/` holds exactly the version plus a newline, every consumer reads that file, and the refresh below is its only writer.

## The pins

bun is the one pinned toolchain: [files/bun/.bun-version](../files/bun/.bun-version), read by the fleet's synced `.bun-version`, this repository's workflows, every composite action's bun-setup step, and `@types/bun` in every package declaring it. uv floats on its setup action's default, and the rust blocks' setup action installs the toolchain the repository's `rust-toolchain.toml` names (stable when there is none), so rust version selection stays repository-owned.

- **Dependabot's bun PRs** install with the lockfile Dependabot wrote; a PR whose frozen install fails is fixed by hand, or by re-running Dependabot on it.
- **A known limitation, accepted:** Dependabot's bun runner reads `bun.lock` lockfileVersion 1 only, while the bun the fleet pins writes version 2 ([dependabot-core#15848](https://github.com/dependabot/dependabot-core/issues/15848)), so a Dependabot bun PR that cannot be rebased is closed and the bump made by hand.

## The biome pin

biome is a tool pin, not a toolchain pin: one version spelled in the action's package.json, the root package.json, the floor's `$schema`, and the auto-format starter, held equal by a test, so a bump edits all four in one PR.

A starter is written once, so an existing `auto-format.yml` keeps the version it was written with until the repository edits it; the gate's biome is always the action's.

The fleet's yamllint step is not a module pin: the action's own requirements pin it, and dependabot bumps it there.

The fleet's ruff step is not a module pin either: the version is spelled inline in fleet.yml's `ruff` step and the uv starters' format lines, held to one value by a test, and bumped by hand, never by the refresh: a ruff minor can add rules to a selected family, so a bump changes the [Python lint floor](modules/python.md) and is reviewed as one.

## How the pin reaches repositories

- **Managed files:** the dotfiles are MANAGED files (deliberately not starters). In a repo selecting the module, every sync updates them, and no registration key overrides them: the fleet shares one version per toolchain.

- **Version-file inputs:** managed workflows and the repo-owned starters as first written pass the matching version-file input (`bun-version-file: .bun-version`).

- **The site hook:** the [site module's](modules/site.md) build hook is the repository's own composite action, so it installs whatever toolchain its steps name (the seeded example reads `.bun-version`); the fleet's docs build runs under the fleet's own bun, never the repository's pin.


## How the composite actions pin bun

repo-platform's own composite actions pin their bun from the root `.bun-version` the sync writes from the same file, through the shared [actions/bun-setup](../actions/bun-setup/action.yml) as their first step, and run that bun by path afterwards, never `bun` by name: a caller's older bun could not parse the lockfiles repo-platform's bun writes. The action's description carries the rest.

## Overriding, per toolchain

To run one repo on a different version, override in a repo-owned workflow and leave the dotfile alone:

| Toolchain | Override                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bun       | pass the explicit version input (`bun-version:` on setup-bun), which the action prefers over its version-file input                                                                  |
| rust      | commit a `rust-toolchain.toml` naming the channel ([rust.md](modules/rust.md)) and components; the setup action in the three rust blocks installs it, with no dotfile to leave alone |

Rules that follow:

- **Never hand-edit the dotfile:** it is managed, so the next sync overwrites it, with the change visible only in the sync PR. Keep deliberate divergence in the workflow inputs above.

- **Starters are written once:** repo-owned starters (`auto-format.yml`, `copilot-setup-steps.yml`, the `checks.yml` examples) are never resynced, so a later change to a starter reaches an existing copy only by hand.

- **Drop `packageManager`:** once the dotfile pins bun, drop any `packageManager` field for it from `package.json`. setup-bun falls back to `packageManager`/`engines.bun` only when no version input or file matched, so a stale field is at best dead and at worst a second, disagreeing pin.

## Keeping the pins fresh

A pinned module declares its pin in `files.yml` (`modules.<name>.pin`, its keys defined in [platform/sync/files.md](platform/sync/files.md#module-data)), data the refresh reads and never content the sync writes; bun's is the only one today.

[refresh-upstream.yml](../.github/workflows/refresh-upstream.yml) (weekly cron plus manual dispatch) runs `release` pins as one matrix leg beside the `commit` pins of [platform/sync/files.md](platform/sync/files.md#upstream-refs), each on its own PR branch, so a toolchain bump is never held behind a gitignore diff:

- **The latest release, never a prerelease,** is the pin's target; an unreachable source, or a "latest" older than the pin (a backport surfacing as latest), aborts the run, since such a view cannot tell "nothing moved" from "could not see upstream's newest".
- **A bun bump also pins `@types/bun`** to the same version in every package declaring it, which is why `.github/dependabot.yml` ignores that package; the types publish per bun release, so a run before they exist fails and the next run retries.
- **One PR on `automation/refresh-release-pins`** when anything moved, a major-line bump leading its body with a callout, and closed once main already carries its pins.

Merging the PR moves the `stable` tag once its gate is green; the next sync rolls the pin out to the fleet.

Dependabot reaches the root workflows alone, so a bump that touches a managed root copy (`.github/workflows/sync-branch.yml`, written from `files/base/.github/workflows/sync-branch.yml`) goes into the shipped copy under `files/` instead. The root copy stays on the recorded pin, which the managed-files check holds it to, and the self-sync after the merge writes the bump into it. The pin census (`tests/workflows/delivery_pins.test.ts`) judges a managed root copy under `files/` alone.
