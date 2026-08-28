# Golden renders

`tests/golden-renders/` holds committed snapshots of real copier output for a canonical matrix of module selections:

```
bun run renders          # rewrite tests/golden-renders/ (also part of bun run regen)
bun run renders:check    # render to temp and diff against the committed snapshots
```

Any change to `templates/` or the composer proves its fleet-facing effect here: a PR that leaves the goldens unchanged proves byte-identity of every rendered file in the matrix, and a PR that changes them shows the exact rendered diff for review. CI's `golden-renders` job (and `bun run check` locally, via `renders:check`) fails when the committed snapshots drift from a fresh render.

## The matrix

| Golden | Modules | Why this selection |
| --- | --- | --- |
| `all-modules` | every module except `custom-license` | Covers every module's rendered files at once (no module pair conflicts). `custom-license` is left out: its whole effect is opting out of the fleet license render, which would hide the default path every other selection exercises. The list derives from the module manifests, so a new module joins automatically and trips the drift check. |
| `minimal` | none (`modules=[]`) | The smallest selection copier.yml's validators allow: the unconditional base render alone. |
| `uv-no-release-please` | `uv` | The dotfiles shape that exposed the compose anchor blank-line bug; its `.typography-allow` must end with exactly one newline (the composer's collapse guard). |

## How a render is made

The runner is `scripts/render_goldens.ts`; it needs `copier` and `bun` on PATH. Per run it:

- builds one scratch build tree (the smoke-render recipe)
- renders each selection with `--defaults` plus the fixed answers `project_name=Golden Render`, `description=Golden render fixture`, `private=false`
- snapshots the output verbatim - symlinks stay symlinks - except for one normalization: the two provenance fields carrying the scratch commit sha become a fixed sentinel

## Determinism contract

A golden changes if and only if rendered content changes. The volatile inputs are pinned at their sources:

- The scratch build tree is content-deterministic by design (no timestamps or source SHAs in-tree). Its git commit uses a pinned identity, pinned author/committer dates, a fixed message, and `/dev/null` global/system git config, so a user's autocrlf or gpg-signing config cannot leak into blob hashes.
- The commit sha is still a pure function of the whole template content (recorded as `_commit` in `.copier-answers.yml`, stamped into the ownership manifest's provenance slot), so every template edit would move it. The runner rewrites exactly those two fields before writing or diffing and leaves every other byte verbatim - a tree-wide substitution would corrupt unrelated content, since 7-hex-char runs occur in English prose (the "feedbac" in "feedback").
- copier runs from the scratch directory with a relative source path, so the recorded `_src_path` is the fixed string `./tree`, never a machine-specific temp path. Copier's internal clone gets the same neutralized git config, and `COPIER_SETTINGS_PATH` is pointed away from any user settings file so its answer defaults cannot leak into the render.
- Everything else in the answers comes from copier.yml defaults or the fixed `-d` values above.
- The copier version itself is deliberately unpinned, matching the smoke legs and the fleet sync: a copier upgrade that changes rendered bytes is a real fleet-facing change and should surface here as golden drift.

### The sentinel, precisely

- The `_commit` answer's value becomes `xxxxxxx` when it records the true sha or any 7-plus-character prefix of it (copier stamps the short form).
- The sentinel is deliberately non-hex, so no honest commit sha can ever read as it - a hex sentinel would reject a genuine commit starting with seven zeros.
- The key stays in the goldens: dropping or renaming it still shows as drift.
- A value that is anything but the true sha is left alone and surfaces as drift; a value already reading as the sentinel is rejected outright (a pre-stamped sentinel would false-match the committed goldens).
- The manifest is then produced by re-running the stamp hook against the normalized tree - the stamper is the manifest's only writer - which carries the sentinel into the commit slot and recomputes the answers file's hash, keeping the committed golden self-consistent.
- That re-stamp is gated on honesty: re-stamping the rendered manifest against the pre-normalization tree must change nothing (the hook is idempotent on a manifest it stamped honestly), so a hook that stamped a lying provenance or hash fails loudly instead of being silently healed.
- Both `bun run renders` and `renders:check` normalize in the same code path, so CI's fresh render agrees with the committed sentinel.

## What the comparison covers

- Content, symlink targets, and the executable bit (the one mode distinction git tracks).
- The runner refuses to write or accept a golden path that matches a git ignore rule - the repo's, or a rendered `.gitignore` inside a golden, which git applies to the committed tree. An ignored golden would silently drop from future `git add` runs.
