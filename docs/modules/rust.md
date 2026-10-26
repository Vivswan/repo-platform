---
order: 160
---

# Rust

Selecting the `rust` module gives a repository a `Cargo.toml` workspace-root starter carrying the fleet's lint floor ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/rust/Cargo.toml)), a managed `clippy.toml` with the floor's thresholds ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/rust/clippy.toml)), and the cargo steps that gate it ([the blocks](https://github.com/Vivswan/repo-platform/tree/main/files/rust/.github/workflows)). Each file says what it holds and why; this page says what they cannot.

## What the files cannot say

- **A threshold is never raised locally:** a tighter one forces splits that read worse, and the managed file's header says what happens to a local edit. A readability finding is fixed, or carried at the one item it names with the `#[expect]` form the starter describes.
- **A foreign `#[non_exhaustive]` enum** forces a `_` arm. The wildcard lint accepts it once every known variant is listed above it.
- **The toolchain version is the repository's own** ([toolchains.md](../toolchains.md#overriding-per-toolchain)); the starter's manifest states the floor it needs.

## How a repository takes it

The path depends on what the repository already has ([the writer's classes](../platform/sync/writer.md#classes)):

1. **A new repository:** `Cargo.toml` lands before any crate exists; its header says how a crate created inside the workspace inherits the floor.
2. **A repository that already owns `Cargo.toml`:** copy the lint tables into it by hand and give each member crate `[lints] workspace = true`; when the starter gains a row, copy the row the same way. Its workflows are starters too, so copy the cargo steps from the rust blocks into its `checks.yml`, `auto-format.yml`, and `copilot-setup-steps.yml` as well.
3. **Every repository:** the managed `clippy.toml` arrives at the root; a member crate that carries its own is the one case the file's header asks it to remove.
