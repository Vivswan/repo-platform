---
order: 210
group: Fleet operations
---

# Toolchain pins

One version per toolchain, fleet-wide. Each pin lives in `files.yml` (`modules.<module>.pin: {file, version}`); `bun run pins` writes the dotfile containing exactly the version plus a newline under `files/<module>/`, and the sync delivers it to every repo that selects the module.

## The pins

The pinned versions are the `pin` entries of the `bun` and `deno` modules in [files.yml](../files.yml) (`{file, version}`: `.bun-version`, `.dvmrc`); nothing else records them, so the file is the roster and the refresh below is the only writer.

Modules without a pin: uv floats on its setup action's default, and rust ships no toolchain setup in CI (its module data deliberately carries no `pin`), so rust version selection stays repository-owned.

## How the pin reaches repositories

- The dotfiles are MANAGED files (deliberately not starters): in a repo selecting the module, every sync updates them, and no registration key overrides them - the fleet shares one version per toolchain.
- Managed workflows and the repo-owned starters as first written pass the matching version-file input (`bun-version-file: .bun-version`, `deno-version-file: .dvmrc`).
- The [site module's](site.md) build hook is the repository's own composite action, so it installs whatever toolchain its steps name (the seeded example reads `.bun-version`); the fleet's docs build runs under the fleet's own bun, never the repository's pin.
- validate-managed-files' parity check fails a repo whose dotfile differs from the one its last sync wrote.
- repo-platform's own composite actions (under `actions/`) pin their bun too, from an action-local `.bun-version` beside each action.yml that `bun run pins` writes from the same pin:
  - Each action carries one step calling the shared `actions/bun-setup` action, ahead of any step that uses an action or touches bun (`uses: Vivswan/repo-platform/actions/bun-setup@stable` with `pin` set to the action's own `.bun-version`, resolved against `github.action_path`): it reuses a bun already on PATH at the pin, installs it with oven-sh/setup-bun otherwise (one retry for the known network flake), and records the absolute path of the bun that prints the pin as `path`. Every later step runs that path, never `bun` by name, because a later setup-bun can put another bun first on PATH.
  - validate-managed-files passes `required: "false"` and gates its legs on the `ready` output, so its report step still runs and reports a missing bun instead of the action dying before it.
  - The actions run vendored scripts and action-local lockfiles inside caller checkouts, so the CALLER's version resolution must never pick their bun: a repository pinning an older bun cannot parse the lockfiles repo-platform's bun writes. The actions-bun-guard ssot rule demands exactly that bun-setup step of every action that runs bun, ahead of any other step that uses an action or touches bun; keeps any setup-bun step of the action's own reading its pin (the shared action's `pin` input, or a tree the action fetched itself); refuses a dangling `steps.<id>.outputs.path`; and refuses a bare `bun` line.
  - ci.yml's bun-setup-smoke job puts the pinned bun on the runner, then calls the shared action from the working tree once per planted pin (that version, reused; an earlier release, installed) and judges both calls' outputs.
  - The validator script directory inside validate-managed-files (`actions/validate-managed-files/validator`) is part of that action's one package, so the action's pin covers it: the action runs the validator on its own bun.

## Overriding, per toolchain

To run one repo on a different version, override in a repo-owned workflow and leave the dotfile alone:

| Toolchain | Override |
|---|---|
| bun | pass the explicit version input (`bun-version:` on setup-bun), which the action prefers over its version-file input |
| deno | setup-deno resolves the other way around (a non-empty `deno-version-file` wins over `deno-version`), so replace or remove the `deno-version-file:` line instead |

Rules that follow:

- Never hand-edit the dotfile: it is managed, so the next sync overwrites it, with the change visible only in the sync PR. Keep deliberate divergence in the workflow inputs above.
- Repo-owned starters (`auto-format.yml`, `copilot-setup-steps.yml`, the `checks.yml` examples) are written once and never resynced: starters written BEFORE the pin landed keep floating until the repo adds the version-file input by hand. New repositories carry it from the start.
- Once the dotfile pins bun, drop any `packageManager` field for it from `package.json`: setup-bun falls back to `packageManager`/`engines.bun` only when no version input or file matched, so a stale field is at best dead and at worst a second, disagreeing pin.

## Keeping the pins fresh

The refresh-toolchains workflow (weekly cron plus manual dispatch, mirroring refresh-gitignore) bumps the pins when upstream moved:

1. Fetch the latest upstream versions: bun's latest GitHub release, Deno's latest stable release.
2. Rewrite the `modules.<module>.pin` entries in `files.yml` in place, then rerun `bun run pins`, which writes the version dotfiles under `files/`, beside the actions, and at this repository's root (`bun run pins:check` is the offline gate against drift).
3. Open or refresh a PR on the `automation/toolchain-refresh` branch when anything moved.

Merging the PR moves the `stable` tag once its gate is green; the next sync rolls the pin out to the fleet.
