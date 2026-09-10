---
order: 260
group: Fleet operations
---

# Private repositories

repo-platform is public, and GitHub Actions has no log-level access control: run logs, job names, step headers, and annotations are as readable as the repository they run in. The fleet workflows therefore never let a private repository's name or content reach that log. Four rules carry the whole model; the job shape enforces them, not a per-step discipline.

| Rule | Where it lives |
| --- | --- |
| **Index-only names.** The matrix and the job names carry row indexes (`sync (row 3)`), never repository names. The plan prints a count. | [sync-repos.yml](../.github/workflows/sync-repos.yml); the `operator-verdict-only` rule pins it |
| **Mask at the boundary.** One step per row maps its index to a repository and registers every form of the name (slug, bare name, both URL spellings, lower-cased) with the runner's masker before anything else prints. The name then rides `GITHUB_ENV` alone, which the runner never echoes; the target is cloned by a script whose git output is captured, never by the checkout action. | [sync/resolve_row.ts](../.github/scripts/sync/resolve_row.ts), [sync/checkout_target.ts](../.github/scripts/sync/checkout_target.ts) |
| **Logs to files.** Every later `run:` step writes its whole output to a `$RUNNER_TEMP` file; the writer's report and the delivery log never touch stdout. The only lines printed are the operator's vocabulary ([sync.md](sync.md#the-operator)). | the row job's step shape |
| **Details in the target repository.** The report becomes the sync PR's body; a failure's log tails become one reused `[repo-platform] sync failed` issue there. Both are exactly as private as the repository. | [sync/deliver.ts](../.github/scripts/sync/deliver.ts) |

The same job runs for public and private targets: nothing is conditional on visibility except the report's `Visibility` cell.

## What a run still shows

- `plan: <N> rows` and one `row <i>: ...` line per row.
- The build commit the run ships and its stamped main commit: those name THIS repository's builds, not a target.
- A step's exit status, and the red step's own error when a row failed before its target was resolved (nothing target-derived exists yet at that point).
- The plan job's selection log, which names public repositories in the clear and private ones by a hint, as before.

## Settings

The settings apply ([settings-repos.yml](../.github/workflows/settings-repos.yml)) keeps its own model: github-settings-as-code's `private-repos: redact` placeholders inside the apply, and a report issue in the target for a redacted target's full report ([settings.md](settings.md)).

## Limits, stated plainly

- Run logs from before this model still contain slugs; delete old runs if that matters.
- The masker is substring-based, so a private repository's bare name is registered only from four characters (masking `api` would garble every innocent occurrence of those letters); the file-and-target rules do not depend on the mask.
- Inside one row job, an innocent occurrence of the repository's name (a dependency sharing it) renders as `***` too. Cosmetic, and scoped to that job.
- Mask registration is a snapshot: a repository renamed while its row runs surfaces under its new name, which no mask covers.
- The `repo=` input typed into a dispatch stays off the log: the plan reads it from the event payload, never from step env, and refusals count entries instead of quoting them.
- The failure issue and the PR body are write-forward: a report delivered while the repository was private stays in the issue's edit history forever. Flipping a repository public publishes it; delete the report issue before a deliberate flip.
- The [pages module](pages.md) publishes a PUBLIC site even from a private repository, `<owner>.github.io/<repo>` included; that is outside this model entirely.
