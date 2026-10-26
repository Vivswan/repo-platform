---
order: 160
---

# Rust

Selecting the `rust` module gives a repository a `Cargo.toml` workspace-root starter carrying the fleet's lint floor ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/rust/Cargo.toml)), a managed `clippy.toml` with the floor's thresholds ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/rust/clippy.toml)), and the cargo steps that gate it ([the blocks](https://github.com/Vivswan/repo-platform/tree/main/files/rust/.github/workflows)). Each file says what it holds and why; this page says what they cannot.

## What the files cannot say

- **A threshold is never raised locally:** a tighter one forces splits that read worse, and the managed file's header says what happens to a local edit. A readability finding is fixed, or carried at the one item it names with the `#[expect]` form the starter describes.
- **The three threshold lints warn** (`too_many_arguments`, `too_many_lines`, `cognitive_complexity`): a threshold is a hint, and a forced split can read worse. `-D warnings` makes every warn-level lint an error whatever the flag order, so the starter's clippy line carries `--force-warn` for the three. A known case still rides `#[expect(clippy::<lint>, reason = "...")]`: the warning still prints, and a stale one still fails: the floor denies `unfulfilled_lint_expectations`.
- **A repository cannot make the three block in the starter's gate:** `--force-warn` overrides a crate's own `deny` or `forbid`. A clippy line of its own can.
- **A foreign `#[non_exhaustive]` enum** forces a `_` arm. The wildcard lint accepts it once every known variant is listed above it.
- **The toolchain version is the repository's own** ([toolchains.md](../toolchains.md#overriding-per-toolchain)); the starter's manifest states the floor it needs.

## How a repository takes it

The path depends on what the repository already has ([the writer's classes](../platform/sync/writer.md#classes)):

1. **A new repository:** `Cargo.toml` lands before any crate exists; its header says how a crate created inside the workspace inherits the floor.
2. **A repository that already owns `Cargo.toml`:** copy the lint tables into it by hand and give each member crate `[lints] workspace = true`; when the starter gains a row, copy the row the same way. Its workflows are starters too, so copy the cargo steps from the rust blocks into its `checks.yml`, `auto-format.yml`, and `copilot-setup-steps.yml` as well.
3. **Every repository:** the managed `clippy.toml` arrives at the root; a member crate that carries its own is the one case the file's header asks it to remove.
