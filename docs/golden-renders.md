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

The runner is `scripts/render_goldens.ts`. It needs `copier` and `bun` on PATH, builds one scratch build tree per run (the smoke-render recipe), renders each selection with `--defaults` plus the fixed answers `project_name=Golden Render`, `description=Golden render fixture`, `private=false`, and snapshots the output verbatim - symlinks stay symlinks - except for one normalization: the two provenance fields carrying the scratch commit sha become a fixed sentinel (see the contract below).

## Determinism contract

A golden changes if and only if rendered content changes. The volatile inputs are pinned at their sources:

- The scratch build tree is content-deterministic by design (no timestamps or source SHAs in-tree), and its git commit uses a pinned identity, pinned author/committer dates, a fixed message, and `/dev/null` global/system git config (a user's autocrlf or gpg-signing config must not leak into blob hashes). The commit sha - recorded as `_commit` in `.copier-answers.yml` and stamped into the ownership manifest's provenance slot - is still a pure function of the whole template content, so every template edit would move it; the runner therefore rewrites exactly the two fields that carry it, before writing or diffing, and leaves every other byte verbatim (a tree-wide substitution would corrupt unrelated content: 7-hex-char runs occur in English prose, like the "feedbac" in "feedback"). The `_commit` answer's value becomes the fixed sentinel `xxxxxxx` when it records the true sha or any 7-plus-character prefix of it (copier stamps the short form; the sentinel is deliberately non-hex, so no honest commit sha can ever read as it - a hex sentinel would reject a genuine commit starting with seven zeros); the key stays in the goldens, so dropping or renaming it still shows as drift, a value that is anything but the true sha is left alone and surfaces as drift, and a value already reading as the sentinel is rejected outright (a pre-stamped sentinel cannot false-match). The manifest is then produced by re-running the stamp hook against the normalized tree - the stamper is the manifest's only writer - which carries the sentinel into the commit slot and recomputes the answers file's hash, removing the manifest's direct and indirect sha dependence and keeping the committed golden self-consistent. That re-stamp is gated on honesty: re-stamping the rendered manifest against the pre-normalization tree must change nothing (the hook is idempotent on a manifest it stamped honestly), so a hook that stamped a lying provenance or hash fails loudly instead of being silently healed. Both `bun run renders` and `renders:check` normalize in the same code path, so CI's fresh render agrees with the committed sentinel.
- copier runs from the scratch directory with a relative source path, so the recorded `_src_path` is the fixed string `./tree`, never a machine-specific temp path; copier's internal clone gets the same neutralized git config, and `COPIER_SETTINGS_PATH` is pointed away from any user settings file so its answer defaults cannot leak into the render.
- Everything else in the answers comes from copier.yml defaults or the fixed `-d` values above.
- The copier version itself is deliberately unpinned, matching the smoke legs and the fleet sync: a copier upgrade that changes rendered bytes is a real fleet-facing change and should surface here as golden drift.

The runner compares content, symlink targets, and the executable bit (the one mode distinction git tracks). It also refuses to write or accept a golden path that matches a git ignore rule (the repo's, or a rendered `.gitignore` inside a golden, which git applies to the committed tree): an ignored golden would silently drop from future `git add` runs.
