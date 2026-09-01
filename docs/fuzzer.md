# The fuzzer module

Selecting the `fuzzer` module gives a repository a `nightly-fuzz.yml` starter workflow ([the template](../templates/fuzzer/.github/workflows/nightly-fuzz.yml.jinja)): a nightly cron plus a `workflow_dispatch` with `seed` and `iterations` inputs, your fuzz step in the middle, and shared reporting machinery around it. On a red night it uploads the failure artifacts and files a [tracking issue](tracking-issues.md) built from your failure reports; on a green night it closes the stream's open issues.

The starter is generated once and then repo-owned (`_skip_if_exists`): fuzzers and their toolchains differ too much across repos for the template to keep managing the file, so it carries the shared machinery and leaves the fuzz step itself to you. Issue lifecycle, release gating, label renaming, and the action pin's history are shared with the nightly module: [Tracking issues](tracking-issues.md).

## Module parameter (copier question)

| Question | Meaning | Default |
|---|---|---|
| `fuzzer_label` | Label identifying the tracking-issue stream; one open issue per label. A single label, no commas. | `fuzz-nightly` |

The label is a copier question rather than a starter edit because the settings layer must declare it too; [Tracking issues: the label is the stream](tracking-issues.md#the-label-is-the-stream) has the reasoning and the validator's reserved-name rules.

## Customizing the starter

- Replace the placeholder in the `Fuzz` step with your fuzzer, seeded from `$SEED` and bounded by `$ITERATIONS`. Until you do, the step is a green no-op that prints a warning; an uncustomized starter never files issues.
- Set up whatever toolchain the fuzzer needs in the steps above it (rust nightly and cargo-fuzz, a docker stack, a corpus cache), and point the upload and `artifacts-dir` paths at your failure-report directory.
- Bound the fuzz run itself below the job's `timeout-minutes` (a wall-clock flag, or a `timeout` wrapper). A job that hits its timeout is CANCELLED, not failed, and cancelled jobs skip the `if: failure()` steps: no artifact, no issue, a silent night for exactly the hang a fuzzer exists to find.

## The failure-report contract (v1)

The [fuzz-issue action](../actions/fuzz-issue/fuzz-issue.ts) knows nothing about any repository's fuzzer. Your fuzz step communicates failures through a directory (the action's `artifacts-dir` input, relative to the workspace):

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
- Recommended content after the replay block: the seed used, the crashing input's filename, a single-line base64 of the crashing input when it is 3,000 bytes or smaller (it outlives the artifact retention window; one line so head-truncation cannot cut it), and the [regression-pinning](#regression-pinning-and-why-auto-close-is-honest) instruction for your repo.

Size limits:

| Budget | Value |
|---|---|
| per failure, lines included | the heading plus the first 60 lines after it (keep the replay block near the top; the rest survives only in the artifact) |
| per failure, size | at most 8,000 characters |
| whole issue body | 60,000 characters; failures included oldest-first by directory mtime, then a note says how many were omitted |

Re-extracting artifacts (the [shard aggregation](#sharding) below) stamps fresh mtimes, so the ordering only means something when the reports are read where they were written.

## Regression pinning, and why auto-close is honest

A coverage-guided fuzzer that found a crash yesterday can miss it today, so one green night proves little by itself. The fix: when a crash is filed, pin its input into the corpus your fuzzer replays at startup (for cargo-fuzz, a committed seeds directory; for a scenario fuzzer, a pinned case in the corpus file). Have your report.md carry that instruction. Once the input is pinned, every future run replays it first, and a green night is evidence the crash is fixed rather than luck. For crashes nobody pinned, the close comment says the evidence is weaker, and the next red night opens a fresh issue.

## Sharding

The starter carries a commented-out shard matrix. Sharding multiplies nightly coverage at the same wall-clock cost, but the report and resolve steps must then move out of the matrixed job: as steps of each shard they race, and one shard's green resolve can close the issue another shard just filed. Put them in a separate `needs: fuzz` job with `if: always()` that first downloads every shard's failure artifact into one directory, decides red or green from the aggregate, and runs the action once. Also make sure a shared corpus cache is either per-shard or read-only under a matrix.
