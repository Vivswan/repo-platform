---
order: 6
---

# Private repositories

This page is the redaction model of the sync's public log: the four rules that keep a private repository's name and content out of it, what a run still shows, the settings apply that runs the same shape, and where the model stops.

repo-platform is public, and GitHub Actions has no log-level access control: run logs, job names, step headers, and annotations are as readable as the repository they run in. The operator therefore never lets a private repository's name or content reach that log. Four rules carry the whole model, and the job shape enforces them, not a per-step discipline.

| Rule | Where it lives |
| --- | --- |
| **Index-only names:** the matrix carries row indexes and opaque keys, and the job names row indexes (`sync (row 3)`), never repository names. | [sync-repos.yml](../../../.github/workflows/sync-repos.yml) |
| **Mask at the boundary:** one step per row finds its repository by key and registers every form of the name with the runner's masker before anything else prints. | [sync/resolve_row.ts](../../../.github/scripts/sync/resolve_row.ts), [sync/checkout_target.ts](../../../.github/scripts/sync/checkout_target.ts) |
| **Logs to files:** every later `run:` step writes its whole output to a `$RUNNER_TEMP` file. | the row job's step shape |
| **Details in the target repository:** the report becomes the sync PR's body, and a failure's log tails become one reused `[repo-platform] sync failed` issue there, both exactly as private as the repository. | [sync/deliver.ts](../../../.github/scripts/sync/deliver.ts) |

## How each rule is kept

- **The plan** names public repositories and counts private ones.
- **The row key** is an HMAC of the slug under the fleet token and the run id, in three-character groups (`edd~166~...`): opaque in the public log, so a private row is identified without being named. The runner drops a job output that carries a masked value, so no four characters of the matrix may spell a private name.
- **The masked forms:** the slug and the bare name, each lower-cased too. The masker matches substrings, so every URL spelling of the slug falls with it.
- **After the mask,** the name and its visibility ride `GITHUB_ENV` alone, which the next run step's preamble spells under `env:` already masked. The target is cloned by a script whose git output is captured, never by the checkout action.
- **Only the vocabulary prints:** the writer's report and the delivery log never touch stdout, so the only lines printed are the operator's vocabulary ([the operator](operator.md)).

The same job runs for public and private targets: nothing is conditional on visibility except the report's `Visibility` cell and a branch dispatch's job summary, which withholds a private repository's report ([syncing a branch](operator.md#syncing-a-branch)).

## What a run still shows

- `plan: <N> rows` and one `row <i>: ...` line per row.
- The delivery commit the run ships: it names THIS repository's main history, not a target.
- A step's exit status, and the red step's own error when a row failed before its target was resolved (nothing target-derived exists yet at that point).
- The plan job's selection line, which names public repositories in the clear and counts the private ones.

## When the settings apply runs

The settings apply ([settings-repos.yml](../../../.github/workflows/settings-repos.yml)) runs the same shape, with its own delivery ([settings-apply.md](../settings-apply.md#how-the-apply-works)):

- **The plan** names public targets and counts private ones, and masks every form of a private slug before anything prints. Its matrix carries keyed rows: an HMAC of the slug under the fleet token and the run id.
- **Each apply row** resolves its key against one listing of the owner's repositories and registers the name with the masker. Only then does the library's CLI run, on that one target.
- **The CLI** shows a private target as `private repository #N` (`--private-repos redact`). Its full report goes to a reused issue on the target itself, pinned by the `settings-as-code-report` label.

## Where the model stops

- **The masker is substring-based,** so a private repository's bare name is registered only from four characters (masking `api` would garble every innocent occurrence of those letters); the file-and-target rules do not depend on the mask.
- **Inside one row job,** an innocent occurrence of the repository's name (a dependency sharing it) renders as `***` too. Cosmetic, and scoped to that job.
- **Mask registration is a snapshot:** a repository renamed while its row runs surfaces under its new name, which no mask covers.
- **The `repo=` input** typed into a dispatch stays off the log: the plan reads it from the event payload, never from step env, and refusals count entries instead of quoting them.
- **The failure issue and the PR body are write-forward:** a report delivered while the repository was private stays in the issue's edit history forever. Flipping a repository public publishes it; delete the report issue before a deliberate flip.
- **The [site module](../../modules/site.md)** publishes a PUBLIC site even from a private repository, `<owner>.github.io/<repo>` included; that is outside this model entirely.
