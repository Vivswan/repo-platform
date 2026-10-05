---
order: 150
---

# Fuzzer

Selecting the `fuzzer` module gives a repository a `nightly-fuzz.yml` starter workflow ([the source](https://github.com/Vivswan/repo-platform/blob/main/files/fuzzer/.github/workflows/nightly-fuzz.yml)): a nightly cron plus a `workflow_dispatch` with `seed` and `iterations` inputs, your fuzz step in the middle, and shared reporting machinery around it.

- **A red night** uploads the failure artifacts, and the `report` job files or refreshes a [tracking issue](tracking-issues.md) built from your failure reports; that page owns the issue lifecycle, release gating, and label renaming.
- **A green night** closes the stream's open issues.
- **Red means failed or cancelled:** the `report` job runs with `needs: [fuzz]` and judges `needs.fuzz.result`, so a fuzz job that hits its `timeout-minutes` (cancelled, not failed) still files the issue, and the upload step runs on `failure() || cancelled()` so the reports a hung run wrote ride along. A human cancelling the run files an issue too, which the next green night closes.
- **The `.gitignore` region:** the module also adds `/.fuzz-failures/` to the managed region of the repository's `.gitignore`, so the failure directory a run leaves behind is never committed.

**Repo-owned:** the starter is written once and then repo-owned. Fuzzers and their toolchains differ too much across repos for the platform to keep managing the file, so it carries the shared machinery and leaves the fuzz step itself to you. Repo-owned also means a fix to the starter never reaches repos that already received it.

## Module parameter (registration key)

| Key in `.repo-platform.yml` | Meaning | Default |
|---|---|---|
| `labels.fuzzer` | Label identifying the tracking-issue stream; one open issue per label. A single label, no commas. | the fuzzer module's `tracking_label` default in [files.yml](../../files.yml) |

The label is a registration key rather than a starter edit alone because the settings layer must declare it too; [Tracking issues: the label is the stream](tracking-issues.md#the-label-is-the-stream) has the reasoning and the reserved-name rules.

## Customizing the starter

- **Replace the placeholder** in the `Fuzz` step with your fuzzer, seeded from `$SEED` and bounded by `$ITERATIONS`. Until you do, the step is a green no-op that prints a warning; an uncustomized starter never files issues.

- **Set up the toolchain** the fuzzer needs in the steps above it (rust nightly and cargo-fuzz, a docker stack, a corpus cache), and point the upload step's `path` at your failure-report directory. The artifact carries the failure directories themselves, so the `report` job's download path and `artifacts-dir` stay as they are.

- **The `report` job is the machinery:** it downloads every `fuzz-failures-*` artifact of the run into `.fuzz-failures` (a pattern download of nothing succeeds, so a night that wrote no artifact files the bare notice) and runs the action once. Leave it as it is; only [sharding](#sharding) touches its `artifact-name`.

- **Hidden files in the upload:** the upload step sets `include-hidden-files: true`. Since v4.4, `actions/upload-artifact` skips hidden paths such as `.fuzz-failures/` by default. Without the flag the step finds no files and uploads nothing, and `if-no-files-found: ignore` keeps that silent.

## The failure-report contract (v1)

The [fuzz-issue action](../../actions/fuzz-issue/fuzz-issue.ts) knows nothing about any repository's fuzzer. Your fuzz step communicates failures through a directory (the action's `artifacts-dir` input, relative to the workspace):

```
<artifacts-dir>/
  <failure-name>/     # one subdirectory per failure
    report.md         # line 1: "# <title>"; body: a fenced block with the replay command(s)
    crash-input.bin   # any other files ride along in the uploaded artifact; the action never reads them
  stray-file.txt      # files at the top level are ignored
```

- **The failure subdirectory's name** identifies the failure (the fuzz target, the suite) and must match `DIR_NAME` in [actions/fuzz-issue/fuzz-issue.ts](../../actions/fuzz-issue/fuzz-issue.ts): letters, digits, dots, underscores, dashes.

- **An absent or empty directory** on a failed job makes the action file a bare notice pointing at the run log; that covers failures outside the fuzz step itself.

- **`report.md` line 1** is a markdown heading, `# <title>`; the action strips the `#` and uses the rest as the failure's section heading in the issue.

- **The body** must contain a fenced code block with the exact replay command(s), runnable from the repository root or starting with an explicit `cd`. The producer owns the replay command; the action never constructs one.

- **Recommended content after the replay block:** the seed used, the crashing input's filename, and the [regression-pinning](#regression-pinning-and-why-auto-close-is-honest) instruction for your repo. Add a base64 copy of the crashing input when it is 3,000 bytes or smaller: it outlives the artifact retention window. Keep it on a single line, so head-truncation cannot cut it.

Size limits:

| Budget | Value |
|---|---|
| per failure, lines included | the heading plus the first `REPORT_LINES` lines after it |
| per failure, size | at most `MAX_BLOCK_CHARS` characters |
| without an `artifact-name` | no per-failure cap: the body is the only record, so every report rides whole, each cut at its share of the body budget with a count of the lines missing |
| whole issue body | `MAX_BODY` characters, under GitHub's cap; failures included oldest-first by directory mtime (meaningful only where the reports were written: re-extracting artifacts, as the [shard aggregation](#sharding) does, stamps fresh mtimes), then a note says how many were omitted |

The three constants live in [actions/fuzz-issue/fuzz-issue.ts](../../actions/fuzz-issue/fuzz-issue.ts). Keep the replay block near the top of `report.md`: lines past `REPORT_LINES` survive only in the artifact.

## Regression pinning, and why auto-close is honest

A coverage-guided fuzzer that found a crash yesterday can miss it today, so one green night proves little by itself.

**The fix:** when a crash is filed, pin its input into the corpus your fuzzer replays at startup (for cargo-fuzz, a committed seeds directory; for a scenario fuzzer, a pinned case in the corpus file). Have your report.md carry that instruction.

**The effect:** once the input is pinned, every future run replays it first, and a green night is evidence the crash is fixed rather than luck. For crashes nobody pinned, the close comment says the evidence is weaker, and the next red night opens a fresh issue.

## Sharding

The starter carries a commented-out shard matrix. Sharding multiplies nightly coverage at the same wall-clock cost, and the `report` job already sits outside the fuzz job: it merges every shard's `fuzz-failures-*` artifact into one directory and judges the matrix's aggregate result, so no shard's green resolve can close the issue another shard just filed.

1. Uncomment the matrix.
2. Append the shard from the matrix to the upload's artifact name, since two uploads cannot share a name, and set the report step's `artifact-name` to the download's pattern, `fuzz-failures-*`: the action prints that name verbatim in the issue body, so the pointer covers every shard's artifact (left alone, it names an artifact no shard uploaded).
3. Put the shard in each failure directory's name: the merge keeps one copy of a path two shards both wrote.
4. Keep a shared corpus cache per-shard or read-only.
