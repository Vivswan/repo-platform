---
order: 160
group: Modules
---

# Rust

Selecting the `rust` module gives a repository a `Cargo.toml` workspace-root starter carrying the fleet's lint floor ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/rust/Cargo.toml)), and the cargo steps that make the floor a gate. This page is the floor's contract; the toolchain version stays the repository's own ([toolchains.md](toolchains.md#overriding-per-toolchain)).

## The floor

Every lint is `deny`. The starter carries each one with its reason beside it.

| Rule | Lints |
| --- | --- |
| One operation per `unsafe` block | `clippy::multiple_unsafe_ops_per_block`, `unsafe_op_in_unsafe_fn` |
| A `// SAFETY:` comment above every `unsafe` block, stating the invariant it relies on | `clippy::undocumented_unsafe_blocks`, `clippy::unnecessary_safety_comment` |
| Unsafe behind a safe API: denied everywhere, re-admitted per audited module, every public `unsafe fn` documenting its contract | `unsafe_code`, `clippy::missing_safety_doc`, `clippy::unnecessary_safety_doc` |
| A lint exception says why, and fails once its cause is gone | `clippy::allow_attributes`, `clippy::allow_attributes_without_reason` |
| Every assert says what broke | `clippy::missing_assert_message` |
| A new enum variant is a compile error at every match | `clippy::wildcard_enum_match_arm`, `clippy::match_wildcard_for_single_variants` |
| No idle `..` in a struct pattern that already binds every field | `clippy::rest_pat_in_fully_bound_structs` |
| ASCII identifiers, the fleet's typography rule | `non_ascii_idents` |
| No doc link to an item that is not there | `rustdoc::broken_intra_doc_links` |

The floor in code, the one module that may hold unsafe:

```rust
#![expect(unsafe_code, reason = "reads through the raw pointer the C side hands over")]

/// Reads one byte.
///
/// # Safety
/// `p` must be non-null, aligned, and point to a live `u8` for the call.
pub unsafe fn raw(p: *const u8) -> u8 {
    // SAFETY: the caller upholds the contract above.
    unsafe { *p }
}

pub fn read(p: &u8) -> u8 {
    // SAFETY: a shared reference is non-null, aligned, and live for its lifetime.
    unsafe { raw(p) }
}
```

- **`expect`, never `allow`:** an `#[allow]` anywhere is an error, and so is an `#[expect]` whose lint no longer fires.
- **A foreign `#[non_exhaustive]` enum** forces a `_` arm. The lint accepts it once every known variant is listed above it.

## How a repository takes it

A starter is written once ([sync.md](sync.md#classes)), so the path depends on what the repository already has:

1. **A new repository:** the sync writes `Cargo.toml` before any crate exists. `cargo new crates/<name>` inside the workspace adds the member and writes `[lints] workspace = true` into it, so every crate inherits the floor.
2. **A repository that already owns `Cargo.toml`:** copy the three lint tables into it by hand, and give each member crate `[lints] workspace = true`.

## The gate

The module's toolchain blocks ([sync.md](sync.md#filesyml-reference)) put these steps into the repo-owned `checks.yml`:

```yaml
- uses: actions-rust-lang/setup-rust-toolchain@<sha> # v2.0.0
  with:
    components: clippy, rustfmt
- run: cargo fmt --all --check
- run: cargo clippy --workspace --all-targets --locked -- -D warnings
- run: cargo test --workspace --locked
- run: cargo doc --workspace --no-deps --document-private-items --locked
```

- **`--locked`:** a stale or missing `Cargo.lock` fails. Commit the lockfile.
- **`-D warnings` on clippy alone:** it reaches every target, where a `RUSTFLAGS` variable would silence the repository's own `build.rustflags`.
- **`cargo doc`** fails on a broken doc link through the floor's rustdoc table.
- **`auto-format.yml`** runs `cargo fmt --all` on the `fix-lint` label, and **`copilot-setup-steps.yml`** installs the toolchain and runs `cargo fetch --locked`.
