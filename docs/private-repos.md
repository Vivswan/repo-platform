# Private repositories in fleet logs

repo-platform is public, and GitHub Actions has no log-level access
control: run logs, job names, step summaries, and job outputs are as
readable as the repository they run in. Without countermeasures, a Sync
Repos or Settings Repos run would print every private repo's name - in
the job list itself (`sync (Vivswan/hidden-server)`) - along with its
description, module selection, file paths, and whatever a failing tool
dumped. This page covers the redaction that closes that leak, what a
redacted run still shows, and how to work with it as the operator. The
design mirrors repo-settings-as-code's `private-repos: redact`, with one
difference: instead of anonymous `private repository #N` placeholders,
repo-platform shows a name hint, so you can tell the jobs apart.

## The hint

A redacted repo appears everywhere as a deterministic hint of its bare
name: each `-`/`_`/`.`-separated segment keeps its first character plus
`**`, and the final segment also keeps its last character when it has at
least five. `hidden-server` becomes `h**-s**r`; `myrepo` becomes `m**o`.
Two repos that hint alike get `#2`, `#3` suffixes. To map a hint back to
a name (or check what a repo would hint as):

```bash
bun .github/scripts/fleet/redact.ts hint hidden-server   # h**-s**r
```

Hints are pseudonymization for the operator, not encryption. A hint
always reveals segment initials, and a very short name is substantially
revealed (`ab` hints as `a**`, but `a-b` as `a**-b**` shows both letters).
The details protection below does not depend on the hint's strength.

## What is hidden, and from what

Discovery already knows each repo's visibility, and the decision fails
closed: a repo the discovery payload does not positively mark
`private: false` is treated as private - including a selected repo that
does not appear in discovery at all.

A private repo's redaction has two independent parts:

- **Name redaction**: the matrix row (which becomes the public job name
  and the auto-printed workflow inputs) carries the hint, never the slug.
  Inside the per-repo job, a resolve step recovers the real repository
  and registers its name with the runner's secret masker before anything
  else prints, so checkout logs, API error bodies, and PR URLs render it
  as `***`.
- **Details hiding**: target-derived values stay out of the public log.
  Tools that read the target's checkout (copier, the template validator,
  the retired-file cleanup) run behind a capture boundary that publishes
  only a generic outcome; module lists print as counts; drift warnings
  name the changed field but not the values; conflict dumps go to the PR
  body only. The full detail always exists somewhere private: the sync
  PR (and its CI) lives in the target repo itself.

Names already committed in this public repository cannot be un-published,
so redaction follows a self-disclosure rule, same as the reference
implementation's table:

| How the repo is named here | Name in logs | Details |
|---|---|---|
| wildcard discovery only | hint | hidden |
| explicit `managed:`/`exclude:`/`config:` entry in repos.yml | plain | hidden |
| `settings/repos/<name>.yml` central file | plain | hidden |
| public repo | plain | shown |

Only wildcard-discovered private repos get true non-disclosure. Today
every private repo in the fleet is wildcard-discovered (the registry's
committed entries name public repos), so in practice every private repo
is hinted.

## What a redacted run still shows

Coarse facts stay visible on purpose - they are what make the run
operable without the details: the hint, the channel, each step's outcome,
HTTP status codes on failed probes, the count of modules/conflicts/
retired files, and the template-version identifiers a sync moves between
(`staging@<sha>`, `templates/vX.Y.Z` - those name THIS repo's builds, not
the target). The settings action prints its own placeholders
(`private repository #N`) inside an apply leg; two redaction
vocabularies, one job, both safe.

## How the per-repo job finds its target

The plan job cannot put the slug in the matrix, so a redacted row carries
a resolution tag instead: an HMAC of the lowercased slug, keyed by a
value derived from the fleet PAT and bound to the run id. The tag is safe
to print (without the PAT it cannot be turned back into a name, and it
does not fingerprint the repo across runs); the per-repo job re-discovers
the fleet and takes the unique tag match.

When resolution fails, the job goes red with an error naming only the
hint. The causes are all fail-closed: the repo was renamed or deleted,
the token's grant was revoked, or REPO_PLATFORM_TOKEN was rotated between
the plan job and this one (a rotated PAT derives a different key). The
remediation is the one the error states: re-run the whole workflow, not
just the failed job.

## Seeing the full detail

- The sync PR in the target repo carries everything the public log hides:
  dropped conflict hunks, removed paths, drift values, withheld workflow
  files. Its checks run in the private repo, where logs are private.
- A private target's settings apply report has its own channel:
  `settings-repos.yml` runs repo-settings-as-code with
  `private-report: issue`, so for a redacted target the action's
  visibility probe proves private or internal, the full unredacted
  failure/drift report becomes a marker-labelled issue on the target
  repo itself - reused forever, open while the apply fails or drifts,
  closed (latest report inside) when healthy. Best-effort: an unproven
  visibility stays redacted without an issue, and a failed delivery
  warns without failing the run.
- A hidden sync step failure ("output hidden: private repository")
  routes its captured output privately. When the run has a sync PR,
  failed validation diagnostics are appended to the PR body; when no PR
  carries them (a copier or cleanup crash, or a validation failure with
  nothing delivered), a bounded excerpt of each capture (the body notes
  any truncation) becomes the body of a reused issue on the target repo
  titled
  `[automated] repo-platform sync: private failure report` - found by
  that exact title, not a marker label, because the settings apply
  deletes undeclared labels. One issue per repo, forever: each delivery
  replaces the body (earlier reports stay in the edit history), open
  means the sync needs attention, and the next fully healthy run closes
  it. Unlike the settings channel, delivery does not wait for a proven
  private visibility: hide-details is fail-closed, so a public repo
  missing from discovery can get its excerpt posted to its own public
  issue tracker - which never widens access, since the issue's readers
  are exactly the repo's readers, the same audience an un-hidden run
  log would have had. Delivery is best-effort; if it warns instead,
  reproduce locally:
  check out the target repo and run the same copier update against
  `gh:Vivswan/repo-platform` (docs/new-repo.md has the copier
  invocations), or re-run the failing script from this repo with the
  target checked out under `target/`.
- The `hint` subcommand above answers "which repo is this job?".

## Limits, stated plainly

- Run logs from BEFORE this redaction still contain slugs; delete old
  runs if that matters.
- Both report-issue channels (settings and sync) are write-forward: a
  report delivered while the repo was private stays in the issue body
  and its edit history forever - closing or replacing the issue removes
  nothing. Flipping the repo public publishes all of it, so delete the
  report issues before a deliberate visibility flip.
- The settings action decides report delivery from the pre-apply
  visibility, so the heal that reverts an out-of-band private flip (the
  settings file declares `private: false`) can deliver that run's full
  report into the repo it just made public again. Reverting such flips
  promptly, or deleting the report issue after one, bounds the exposure.
- The `repo=` input you type into a workflow dispatch stays out of the
  public log: the plan job reads it from the runner's event payload
  rather than step env (which the runner would print), and GitHub's
  workflow-run API does not return dispatch inputs. A dispatched private
  repo appears only as its hint - even a mistyped one is withheld from
  the no-match error.
- A repo flipped private after a run started (or after years of being
  public) cannot retract what earlier runs already published.
- The masker is substring-based: a private repo's bare name is only
  registered when it is at least four characters (masking `api` would
  garble every innocent occurrence of those letters in the job's log).
  Short-named repos lean entirely on the details hiding, which does not
  depend on masking.
- Inside one redacted job, any innocent occurrence of the repo's bare
  name, its non-default branch name, or its description text (a
  dependency sharing the name, a common word the description happens to
  contain) renders as `***` too. Cosmetic, and scoped to that job.
