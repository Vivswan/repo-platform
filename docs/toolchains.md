# Toolchain version pins

One version per toolchain, fleet-wide:

| Module | Version file | Pinned version |
|---|---|---|<!-- BEGIN GENERATED: toolchain-pins (scripts/generate.ts - edit module.yml manifests, not this block) -->
| `bun` | `.bun-version` | 1.4.0 |
| `node` | `.node-version` | 24.19.0 |
| `deno` | `.dvmrc` | 2.9.5 |<!-- END GENERATED: toolchain-pins -->

The pin lives in the module manifest (`templates/<module>/module.yml`, `toolchain.pin: {file, version}`); `bun run generate` emits `templates/<module>/<file>` containing exactly the version plus a newline. Modules without a pin: uv floats on its setup action's default, and rust ships no toolchain setup at all (its module.yml deliberately has no `toolchain` key), so rust version selection stays repository-owned.

## How the pin reaches repositories

- The dotfiles are MANAGED files (deliberately not `_skip_if_exists`): every template sync updates them, and there is no copier question - the fleet shares one version per toolchain.
- Managed workflows and the repo-owned starters' initial render pass the matching version-file input (`bun-version-file: .bun-version`, `node-version-file: .node-version`, `deno-version-file: .dvmrc`).
- `reusable-pages.yml` checks the caller out into `production/` and `staging/`, so its setup steps resolve the dotfile with a `hashFiles()` fallback: production's pin wins, then staging's, and no dotfile in either tree leaves the input unset (the setup action floats on its default).
- validate-template checks that a repo selecting a pinned module carries the dotfile with exactly the pinned version.
- repo-platform's own composite actions (under `actions/`) set up their bun WITHOUT a pin, by design: they run vendored scripts inside caller checkouts, where the repo's dotfile may not exist.

## Overriding, per toolchain

- bun/node: pass the explicit version input (`bun-version:` on setup-bun, `node-version:` on setup-node) in a repo-owned workflow - both actions prefer the explicit input over their version-file input.
- deno: setup-deno resolves the other way around (a non-empty `deno-version-file` wins over `deno-version`), so replace or remove the `deno-version-file:` line in the repo-owned workflow instead.
- Never hand-edit the dotfile: it is managed, so the next sync overwrites it, with the change visible only in the sync PR. Keep deliberate divergence in the workflow inputs above.
- Repo-owned starters (`auto-format.yml`, `copilot-setup-steps.yml`, `checks.yml` examples) are generated once and never resynced: starters rendered BEFORE the pin landed keep floating until the repo adds the version-file input by hand. New renders carry it from the start.
- Once the dotfile pins bun, drop any `packageManager` field for it from `package.json`: setup-bun falls back to `packageManager`/`engines.bun` only when no version input or file matched, so a stale field is at best dead and at worst a second, disagreeing pin.

## Keeping the pins fresh

The refresh-toolchains workflow (weekly cron + manual dispatch, mirroring refresh-gitignore) bumps the pins when upstream moved:

1. Fetch the latest upstream versions: bun's latest GitHub release, Node's newest LTS line from nodejs.org, Deno's latest stable release.
2. Rewrite the manifests' pin version lines, then rerun `bun run generate` and `bun run dogfood`.
3. Open or refresh a PR on the `automation/toolchain-refresh` branch when anything moved.

Merging the PR rebuilds the build branch; the next sync rolls the pin out to the fleet.
