# The fuzzer module

Selecting the `fuzzer` module gives a repository a `nightly-fuzz.yml` starter workflow. It is generated once and then repo-owned (`_skip_if_exists`): fuzzers and their toolchains differ too much across repos for the template to keep managing the file, so the starter carries the shared machinery and leaves the fuzz step itself to you.

What the machinery does:

- runs on a nightly cron plus a `workflow_dispatch` with `seed` and `iterations` inputs, so any night's configuration can be re-run on demand
- on failure, uploads the failure artifacts and files (or updates) a label-deduplicated tracking issue built from your failure reports, then dispatches auto-assign at it (when that module is selected)
- on a green run, comments on and closes every open issue carrying the tracking label

The issue filing and closing come from the `fuzz-issue` composite action in this repository (`actions/fuzz-issue`), pinned at the green-gated `build` delivery branch like every other managed action. The action needs `gh` on the runner: GitHub-hosted runners preinstall it, self-hosted runners must provide it. The same action serves the nightly module's plain-CI stream ([docs/nightly.md](nightly.md)); the artifacts contract below is what sets the fuzz stream apart.

## Module parameter (copier question)

| Question | Meaning | Default |
|---|---|---|
| `fuzzer_label` | Label identifying the tracking-issue stream; one open issue per label. A single label, no commas. | `fuzz-nightly` |

The label is a copier question, not a starter edit, because two more places must agree on it:

- The report and resolve steps: both dedup and auto-close by the label.
- The repository's settings labels: settings applies delete undeclared labels, and a tracking issue stripped of its label is invisible to both the dedup and the auto-close. The managed settings baseline declares it automatically - repo-platform resolves the recorded `fuzzer_label` answer at apply time ([docs/settings.md](settings.md)).

The question's validator rejects the label names the template already manages (the settings baseline, the release labels, the dependabot labels; GitHub label names are case-insensitive): reusing one would let a green night close unrelated issues carrying it and make every settings apply fight over the label's color and description. The validator runs on `copier update` too, so a repo whose recorded label later becomes reserved fails its next sync until the recorded `fuzzer_label` value in `.copier-answers.yml` is changed (and the starter's `label:` inputs with it, per the renaming section below).

## Customizing the starter

- Replace the placeholder in the `Fuzz` step with your fuzzer, seeded from `$SEED` and bounded by `$ITERATIONS`. Until you do, the step is a green no-op that prints a warning; an uncustomized starter never files issues.
- Set up whatever toolchain the fuzzer needs in the steps above it (rust nightly and cargo-fuzz, a docker stack, a corpus cache), and point the upload and `artifacts-dir` paths at your failure-report directory.
- Bound the fuzz run itself below the job's `timeout-minutes` (a wall-clock flag, or a `timeout` wrapper). A job that hits its timeout is CANCELLED, not failed, and cancelled jobs skip the `if: failure()` steps: no artifact, no issue, a silent night for exactly the hang a fuzzer exists to find.
- Because the file is repo-owned, template sync never re-renders it, so the `fuzz-issue` pin inside it stays whatever was last written. New renders pin `@build`; repos rendered when the pin was `@main` or the retired `@actions` had it ported in place by a one-run sync-side rewrite (`starter_pin_rollout.ts` - exact retired pins only, listed in the sync PR's transition note; a hand-changed pin is left alone and listed as skipped). A breaking change to the action's inputs still needs a manual edit here, announced loudly in the change's PR.

## The failure-report contract (v1)

The `fuzz-issue` action knows nothing about any repository's fuzzer. Your fuzz step communicates failures through a directory (the action's `artifacts-dir` input, relative to the workspace):

```
<artifacts-dir>/
  <failure-name>/     # one subdirectory per failure
    report.md         # line 1: "# <title>"; body: a fenced block with the replay command(s)
    crash-input.bin   # any other files ride along in the uploaded artifact; the action never reads them
  stray-file.txt      # files at the top level are ignored
```

- A failure subdirectory's name identifies the failure (the fuzz target, the suite) and must match `[A-Za-z0-9._-]+`.
- If the job fails and the directory is absent or empty, the action files a bare notice pointing at the run log; that covers failures outside the fuzz step itself.
- `report.md` line 1 is a markdown heading, `# <title>`; the action strips the `#` and uses the rest as the failure's section heading in the issue.
- The body must contain a fenced code block with the exact replay command(s), runnable from the repository root or starting with an explicit `cd`. The producer owns the replay command; the action never constructs one.
- Recommended content after the replay block: the seed used, the crashing input's filename, a single-line base64 of the crashing input when it is 3,000 bytes or smaller (it outlives the artifact retention window; one line so head-truncation cannot cut it), and the regression-pinning instruction for your repo.

Size limits:

| Budget | Value |
|---|---|
| per failure, lines included | the heading plus the first 60 lines after it (keep the replay block near the top; the rest survives only in the artifact) |
| per failure, size | at most 8,000 characters |
| whole issue body | 60,000 characters; failures included oldest-first by directory mtime, then a note says how many were omitted |

Re-extracting artifacts (the shard aggregation below) stamps fresh mtimes, so the ordering only means something when the reports are read where they were written.

## Issue lifecycle

- One open issue per label. A failing night comments on the open issue if one exists, otherwise creates it.
- A green night comments on and closes every open issue carrying the label, and the release gate blocks while ANY of them is open - so hand-labeling an issue into the stream makes the next green night close it; to block a release deliberately, use the `release-blocker` label instead ([docs/all-green.md](all-green.md)). When no issue is open, the resolve step does nothing.
- A manual green dispatch also closes the issue; the close comment links the run, so the provenance is visible.
- The action assigns the repository owner at creation - issues created with `GITHUB_TOKEN` fire no `issues: opened` event, so the auto-assign module cannot catch them - and a comment on a still-unassigned open issue picks the owner up too. Assignment is best-effort (an org owner is not assignable) and never fails the filing; the dispatched auto-assign workflow (when that module is selected) still layers the CODEOWNERS policy on top.

## Release gating

With the release-please module also selected, the release-health gate ties releases to fuzz health: while the tracking issue is open, the release PR's `release-health` CI job fails early and visibly, and the release pipeline's authoritative pre-flight blocks the cut itself. Every selected tracking-stream module gates this way - the rendered workflows pass each stream's label in the action's `tracking-labels` input, so the nightly module's issue blocks identically ([docs/nightly.md](nightly.md)). The gate self-scopes to release-cut pushes, so release-PR refreshes and ordinary main runs are never blocked.

Hand-closing the issue removes the block without waiting for a green run, but closing it re-triggers nothing: re-run the release PR's failed release-health job afterwards (the release path's pre-flight reads issue state fresh at release time). The next green nightly closes the issue automatically anyway. The `release-blocker` and `release-override` labels ([docs/all-green.md](all-green.md)) work independently of the fuzz stream.

## Regression pinning, and why auto-close is honest

A coverage-guided fuzzer that found a crash yesterday can miss it today, so one green night proves little by itself. The fix: when a crash is filed, pin its input into the corpus your fuzzer replays at startup (for cargo-fuzz, a committed seeds directory; for a scenario fuzzer, a pinned case in the corpus file). Have your report.md carry that instruction. Once the input is pinned, every future run replays it first, and a green night is evidence the crash is fixed rather than luck. For crashes nobody pinned, the close comment says the evidence is weaker, and the next red night opens a fresh issue.

## Renaming the label, deselecting the module

Two lifecycle edges follow from the starter being repo-owned while the label reaches settings from the recorded answer, read fresh on every apply:

- Renaming `fuzzer_label` changes the label the NEXT settings apply declares (no sync needed) - but never the repo-owned `nightly-fuzz.yml`. The rename is a default-branch PR editing the `fuzzer_label` value key in `.copier-answers.yml` (the sync loads recorded values from there; the underscore keys stay untouched). Update the workflow's two `label:` inputs in the same change, or it keeps filing under the old name while the settings apply deletes it.
- Deselecting the module removes the label declaration, but `_skip_if_exists` files are never deleted by sync: the nightly workflow keeps running. When you drop the module, also delete `.github/workflows/nightly-fuzz.yml` (or keep the label declared in your settings if you keep the workflow).

## Sharding

The starter carries a commented-out shard matrix. Sharding multiplies nightly coverage at the same wall-clock cost, but the report and resolve steps must then move out of the matrixed job: as steps of each shard they race, and one shard's green resolve can close the issue another shard just filed. Put them in a separate `needs: fuzz` job with `if: always()` that first downloads every shard's failure artifact into one directory, decides red or green from the aggregate, and runs the action once. Also make sure a shared corpus cache is either per-shard or read-only under a matrix.
