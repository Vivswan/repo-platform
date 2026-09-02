# Toolchain version pins

One version per toolchain, fleet-wide. Each pin lives in the module manifest (`templates/<module>/module.yml`, `toolchain.pin: {file, version}`); `bun run generate` emits the dotfile containing exactly the version plus a newline, and template sync delivers it to every repo that selects the module.

## The pins

| Module | Version file | Pinned version |
|---|---|---|<!-- BEGIN GENERATED: toolchain-pins (scripts/generate.ts - edit module.yml manifests, not this block) -->
| `bun` | `.bun-version` | 1.4.0 |
| `node` | `.node-version` | 24.19.0 |
| `deno` | `.dvmrc` | 2.9.5 |<!-- END GENERATED: toolchain-pins -->

Modules without a pin: uv floats on its setup action's default, and rust ships no toolchain setup at all (its module.yml deliberately has no `toolchain` key), so rust version selection stays repository-owned.

## How the pin reaches repositories

- The dotfiles are MANAGED files (deliberately not `_skip_if_exists`): in a repo selecting the module, every template sync updates them, and there is no copier question - the fleet shares one version per toolchain.
- Managed workflows and the repo-owned starters' initial render pass the matching version-file input (`bun-version-file: .bun-version`, `node-version-file: .node-version`, `deno-version-file: .dvmrc`).
- The [pages module's](pages.md) `reusable-pages.yml` makes one full checkout and resolves each dotfile with a `hashFiles()` fallback at the checkout root - every tier (historical tags included) builds with that one pin, and no dotfile leaves the input unset (the setup action floats on its default).
- validate-template checks that a repo selecting a pinned module carries the dotfile with exactly the pinned version.
- repo-platform's own composite actions (under `actions/`) pin their bun too, from a generated action-local `.bun-version` beside each action.yml (their setup steps pass `bun-version-file` against `github.action_path`). They run vendored scripts and action-local lockfiles inside caller checkouts, so the CALLER's version resolution must never pick their bun: a repository pinning an older bun cannot parse the lockfiles repo-platform's bun writes. `bun run generate` emits the dotfiles from the same bun manifest pin, and the actions-bun-guard ssot rule keeps every setup step reading them.

## Overriding, per toolchain

To run one repo on a different version, override in a repo-owned workflow and leave the dotfile alone:

| Toolchain | Override |
|---|---|
| bun / node | pass the explicit version input (`bun-version:` on setup-bun, `node-version:` on setup-node) - both actions prefer it over their version-file input |
| deno | setup-deno resolves the other way around (a non-empty `deno-version-file` wins over `deno-version`), so replace or remove the `deno-version-file:` line instead |

Rules that follow:

- Never hand-edit the dotfile: it is managed, so the next sync overwrites it, with the change visible only in the sync PR. Keep deliberate divergence in the workflow inputs above.
- Repo-owned starters (`auto-format.yml`, `copilot-setup-steps.yml`, the `checks.yml` examples) are generated once and never resynced: starters rendered BEFORE the pin landed keep floating until the repo adds the version-file input by hand. New renders carry it from the start.
- Once the dotfile pins bun, drop any `packageManager` field for it from `package.json`: setup-bun falls back to `packageManager`/`engines.bun` only when no version input or file matched, so a stale field is at best dead and at worst a second, disagreeing pin.

## Keeping the pins fresh

The refresh-toolchains workflow (weekly cron plus manual dispatch, mirroring refresh-gitignore) bumps the pins when upstream moved:

1. Fetch the latest upstream versions: bun's latest GitHub release, Node's newest LTS line from nodejs.org, Deno's latest stable release.
2. Rewrite the manifests' pin version lines, then rerun `bun run generate` and `bun run dogfood`.
3. Open or refresh a PR on the `automation/toolchain-refresh` branch when anything moved.

Merging the PR rebuilds the build branch; the next sync rolls the pin out to the fleet.
