# Golden renders

`tests/golden-renders/` holds committed snapshots of real copier output for a canonical matrix of module selections. A PR that leaves the goldens unchanged proves byte-identity of every rendered file in the matrix; a PR that changes them shows the exact rendered diff for review.

```
bun run renders          # rewrite tests/golden-renders/ (also part of bun run regen)
bun run renders:check    # render to temp and diff against the committed snapshots
```

CI's `golden-renders` job (and `bun run check` locally, via `renders:check`) fails when the committed snapshots drift from a fresh render. The runner is [scripts/render_goldens.ts](../scripts/render_goldens.ts); it needs `copier` and `bun` on PATH, builds one scratch build tree per run, and renders each selection with `--defaults` plus fixed answers.

## The matrix

| Golden | Modules | Why this selection |
| --- | --- | --- |
| `all-modules` | every module except `custom-license` | Covers every module's rendered files at once (no module pair conflicts). `custom-license` is left out: its whole effect is opting out of the fleet license render, which would hide the default path every other selection exercises. The list derives from the module manifests, so a new module joins automatically and trips the drift check. |
| `minimal` | none (`modules=[]`) | The smallest selection copier.yml's validators allow: the unconditional base render alone. |
| `uv-no-release-please` | `uv` | The dotfiles shape that exposed the compose anchor blank-line bug; its `.typography-allow` must end with exactly one newline (the composer's collapse guard). |

## Determinism contract

A golden changes if and only if rendered content changes. The volatile inputs are pinned at their sources; the full inventory lives in [scripts/render_goldens.ts](../scripts/render_goldens.ts)'s header. The essentials:

- The scratch build tree is content-deterministic by design (no timestamps or source SHAs in-tree), and its git commit uses a pinned identity, pinned dates, a fixed message, and neutralized global/system git config, so a user's autocrlf or gpg-signing setup cannot leak into blob hashes.
- copier runs from the scratch directory with a relative source path, so the recorded `_src_path` is the fixed string `./tree`, never a machine-specific temp path; `COPIER_SETTINGS_PATH` is pointed away from any user settings file so its answer defaults cannot leak into the render.
- The copier version itself is deliberately unpinned, matching the smoke legs and the fleet sync: a copier upgrade that changes rendered bytes is a real fleet-facing change and should surface here as golden drift.

## The sentinel

One normalization exists: the scratch commit sha is a pure function of the whole template content, so every template edit would move it. The runner rewrites exactly the two fields that carry it - the `_commit` answer in `.github/.copier-answers.yml` and the ownership manifest's provenance slot - to the sentinel (forty `x` characters, the width of the full sha the stamp hook records), and leaves every other byte verbatim.

- The sentinel is deliberately non-hex, so no honest commit sha can ever read as it.
- Only the true full sha is rewritten: any other value surfaces as drift - copier's 7-char abbreviation included, so a render whose hook rewrite did not run fails here - and a pre-stamped sentinel is rejected outright (it would false-match the committed goldens).
- The manifest is re-stamped against the normalized tree by the stamp hook itself - the manifest's only writer - after an idempotency check proves the hook stamped honestly, so a hook that stamped a lying provenance fails loudly instead of being silently healed.
- Both `bun run renders` and `renders:check` normalize in the same code path, so CI's fresh render agrees with the committed sentinel.

## What the comparison covers

Content, symlink targets, and the executable bit (the one mode distinction git tracks). The runner also refuses to write or accept a golden path that matches a git ignore rule - the repo's, or a rendered `.gitignore` inside a golden - because an ignored golden would silently drop from future `git add` runs.
