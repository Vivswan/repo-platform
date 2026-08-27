# Golden renders

`tests/golden-renders/` holds committed snapshots of real copier output for a canonical matrix of module selections. They exist so any change to `templates/` or the composer proves its fleet-facing effect automatically: a PR that leaves the goldens unchanged proves byte-identity of every rendered file in the matrix for free, and a PR that changes them shows the exact rendered diff for review. CI's `golden-renders` job (and `bun run check` locally, via `renders:check`) fails when the committed snapshots drift from a fresh render.

## The matrix

| Golden | Modules | Why this selection |
| --- | --- | --- |
| `all-modules` | every module except `custom-license` | No module pair conflicts (copier.yml's multiselect allows any combination), so this covers every module's rendered files at once. `custom-license` is left out because its whole effect is opting out of the fleet license render (no `LICENSE.md`, no `copyright_holder` answer), which would hide the default path every other selection exercises. The list derives from the module manifests, so a new module joins automatically and trips the drift check. |
| `minimal` | none (`modules=[]`) | The smallest selection copier.yml's validators allow: the unconditional base render alone. |
| `uv-no-release-please` | `uv` | The dotfiles shape that exposed the compose anchor blank-line bug; its `.typography-allow` must end with exactly one newline (the composer's collapse guard). |

## Regenerating

```
bun run renders          # rewrite tests/golden-renders/ (also part of bun run regen)
bun run renders:check    # render to temp and diff against the committed snapshots
```

The runner is `scripts/render_goldens.ts`. It needs `copier` and `bun` on PATH, builds one scratch build tree per run (the smoke-render recipe), renders each selection with `--defaults` plus the fixed answers `project_name=Golden Render`, `description=Golden render fixture`, `private=false`, and snapshots the output verbatim - symlinks stay symlinks - except for one normalization: the scratch commit sha becomes a fixed sentinel (see the contract below).

## Determinism contract

A golden changes if and only if rendered content changes. The volatile inputs are pinned at their sources:

- The scratch build tree is content-deterministic by design (no timestamps or source SHAs in-tree), and its git commit uses a pinned identity, pinned author/committer dates, a fixed message, and `/dev/null` global/system git config (a user's autocrlf or gpg-signing config must not leak into blob hashes). The commit sha - recorded as `_commit` in `.copier-answers.yml` and stamped into the ownership manifest's provenance slot - is still a pure function of the whole template content, so every template edit would move it; the runner therefore substitutes the true sha, and any 7-plus-character prefix of it, with the fixed sentinel `0000000` across every rendered file and symlink target before writing or diffing. The keys carrying it stay in the goldens (dropping or renaming one still shows as drift), and only the true scratch sha passes: a render that stamps a wrong sha surfaces as drift, and one whose output already contains the sentinel is rejected outright (so a stamped sentinel cannot false-match). Because the manifest's stamp hook hashes each file before this substitution, the runner then re-runs the stamp hook against the normalized tree, recomputing every hash class (whole file, split half, symlink target) with the stamper's own semantics and re-reading the `_commit` provenance from the now-sentinel answers file - removing the manifest's indirect sha dependence and keeping the committed golden self-consistent. Both `bun run renders` and `renders:check` normalize in the same code path, so CI's fresh render agrees with the committed sentinel.
- copier runs from the scratch directory with a relative source path, so the recorded `_src_path` is the fixed string `./tree`, never a machine-specific temp path; copier's internal clone gets the same neutralized git config, and `COPIER_SETTINGS_PATH` is pointed away from any user settings file so its answer defaults cannot leak into the render.
- Everything else in the answers comes from copier.yml defaults or the fixed `-d` values above.
- The copier version itself is deliberately unpinned, matching the smoke legs and the fleet sync: a copier upgrade that changes rendered bytes is a real fleet-facing change and should surface here as golden drift.

The runner compares content, symlink targets, and the executable bit (the one mode distinction git tracks). It also refuses to write or accept a golden path that matches a git ignore rule (the repo's, or a rendered `.gitignore` inside a golden, which git applies to the committed tree): an ignored golden would silently drop from future `git add` runs.
