# Toolchain version pins

A toolchain module can pin its runtime version fleet-wide through its manifest (`templates/<module>/module.yml`, `toolchain.pin: {file, version}`); the table below lists the pin-carrying modules. Modules without a pin (uv, rust) float on their setup actions' defaults. `bun run generate` emits `templates/<module>/<file>` containing exactly the version plus a newline, and the module's setup steps read that dotfile via the setup action's version-file input.

| Module | Version file | Pinned version |
|---|---|---|<!-- BEGIN GENERATED: toolchain-pins (scripts/generate.ts - edit module.yml manifests, not this block) -->
| `bun` | `.bun-version` | 1.4.0 |
| `node` | `.node-version` | 24.19.0 |
| `deno` | `.dvmrc` | 2.9.5 |<!-- END GENERATED: toolchain-pins -->

## How the pin reaches repositories

- The dotfiles are MANAGED files (deliberately not in copier.yml's `_skip_if_exists`), so every template sync updates them in every repo selecting the module. There is no copier question: the fleet shares one version per toolchain.
- Managed workflows and the repo-owned starters' initial render carry the matching version-file input (`bun-version-file: .bun-version`, `node-version-file: .node-version`, `deno-version-file: .dvmrc`).
- `reusable-pages.yml` checks the caller's source out into `production/` and `staging/` subdirectories, so its setup steps resolve the dotfile with a `hashFiles()` fallback expression: production's pin wins, then staging's, and an empty string (no dotfile in either tree) leaves the input unset - each setup action then floats on its default, the pre-pinning behavior.
- The validate-template action checks that a repo selecting a pinned module carries the dotfile with exactly the pinned version.
- repo-platform's own composite actions (under `actions/`) set up their bun WITHOUT a pin, by design: they run vendored scripts inside caller checkouts, where the repo's dotfile may not exist.

## Overrides and caveats

- Repo-owned bun/node workflows override the pin by passing the explicit version input (`bun-version:` on setup-bun, `node-version:` on setup-node): both actions prefer the explicit input over their version-file input.
- setup-deno resolves the other way around: a non-empty `deno-version-file` wins over `deno-version`, so a deno repo overrides by replacing (or removing) the `deno-version-file:` line in its repo-owned workflow.
- The dotfiles themselves are managed: a hand-edited or deliberately divergent copy (say a repo-local `.node-version`) is overwritten template-side on the next sync, with the change visible only in the sync PR - keep deliberate divergence in the workflow inputs above, not in the dotfile.
- Repo-owned starters (`auto-format.yml`, `copilot-setup-steps.yml`, `checks.yml` examples) are generated once and never resynced, so starters rendered BEFORE the pin landed keep floating on the actions' defaults until the repo adds the version-file input by hand. New renders carry it from the start.
- Once the dotfile pins the runtime, `package.json` should not also carry a `packageManager` field for it: setup-bun falls back to `packageManager`/`engines.bun` only when no version input or file matched, so a stale field is at best dead and at worst a second, disagreeing pin.

## Keeping the pins fresh

The refresh-toolchains workflow (weekly cron + manual dispatch, mirroring refresh-gitignore) fetches the latest upstream versions - bun's latest GitHub release, Node's newest LTS line from nodejs.org, Deno's latest stable release - rewrites the manifests' pin version lines, reruns `bun run generate` and `bun run dogfood`, and opens or refreshes a PR on the `automation/toolchain-refresh` branch when anything moved. Merging the PR rebuilds the build branch; the next sync rolls the pin out to the fleet.
