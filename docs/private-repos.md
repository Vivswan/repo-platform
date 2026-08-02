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
- A hidden step failure ("output hidden: private repository") is
  reproduced locally: check out the target repo and run the same copier
  update against `gh:Vivswan/repo-platform` (docs/new-repo.md has the
  copier invocations), or re-run the failing script from this repo with
  the target checked out under `target/`. One exception routes itself:
  failed validation diagnostics are appended to the sync PR body, which
  lives in the private repo.
- The `hint` subcommand above answers "which repo is this job?".

## Limits, stated plainly

- Run logs from BEFORE this redaction still contain slugs; delete old
  runs if that matters.
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
