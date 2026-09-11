---
order: 250
group: Fleet operations
---

# Build provenance

How the `build` branch gets published, how a sync verifies the tip before consuming it, and which trusts remain. This document states the contract; each invariant is owned by exactly one script, named per section, whose header carries only what the code alone cannot show.

| Question | Owner |
| --- | --- |
| When does a publish happen, and what gates it? | [build-branches/publish.ts](../.github/scripts/build-branches/publish.ts) |
| How does a sync verify the tip's content before consuming it? | [sync/verify_build_provenance.ts](../.github/scripts/sync/verify_build_provenance.ts) |
| Why do producer and verifier hash the same tree? | [shared/stage_tree.ts](../.github/scripts/shared/stage_tree.ts) and [shared/rebuild_tree.ts](../.github/scripts/shared/rebuild_tree.ts) |
| Which workflows drive the flow? | [ci.yml](../.github/workflows/ci.yml) (the [all-green gate](all-green.md) + the post-green caller), [post-green.yml](../.github/workflows/post-green.yml) (the publish, on the call and on a dispatch) |

## Who can write `refs/heads/build`?

| Writer | When | What gates the write |
| --- | --- | --- |
| post-green.yml's publish-build job, called | After the `all-green` gate passes on a push to main | ci.yml's post-green job (needs-ordered behind the gate, same run) releases it, and publish.ts re-verifies the check at the source before any mutation. |
| post-green.yml's publish-build job, dispatched | A manual `workflow_dispatch` naming a green main commit's sha (the self-heal) | publish.ts's verification at the source - main history, completed successful `all-green` - is the SOLE gate there. |
| Anyone with push access, out of band | Any time | Nothing at write time: a user-repo ruleset blocks only force-pushes and deletion, so plain fast-forwards stay possible. Sync consumption is provenance-verified below; `uses:` execution trusts the ref (the residuals table). |

Nothing writes the branch on a push before the gate: the tree is assembled inside the post-green run, after `all-green`.

## The delivery flow: push to publish

A change merges to main as commit S. What happens, in order:

| Step | Actor | What happens |
| --- | --- | --- |
| 1. The gating jobs finish | ci.yml's `all-green` job | Judges every needed result; its own check run IS the `all-green` check ([all-green.md](all-green.md)). |
| 2. Gate green on a main push | ci.yml's post-green job | Calls [post-green.yml](../.github/workflows/post-green.yml) with `github.sha` (same run - the judged commit by construction). |
| 3. Publish | post-green.yml's publish-build job | [publish.ts](../.github/scripts/build-branches/publish.ts) assembles S's tree with S's own script (a worktree at S, its frozen dependencies, `branch_tree.ts`) and chains a stamped commit onto the branch tip. |
| 4. Deploy this repository's docs | ci.yml's `docs-site` job, ordered behind post-green | The docs-site module's leg, carried by hand in this repository's ci.yml: calls reusable-pages.yml with `github.sha` after the publish, so the site built from `@build` ships the theme that publish landed ([all-green.md](all-green.md#after-the-gate)). Gated on the all-green result alone under `!cancelled()`: a red post-green never holds the site back, and its own failure shows as its own red job. |

The source assembled and stamped is always SOURCE_SHA - the judged run's own commit on the call, the operator's sha input on a dispatch - never a read of origin/main, which can already be a newer, even red, commit (publish.ts's header owns this discipline).

publish.ts hard-verifies SOURCE_SHA before any mutation: main history (the sync's stamp check 1 refuses anything else, so a dispatch naming a PR head would wedge every sync), then the `all-green` check run at that sha ([shared/all_green.ts](../.github/scripts/shared/all_green.ts)) - defense in depth on the call, where the needs edge already gated entry, and the sole gate on a dispatch.

A missing publish (a failed or evicted post-green run after a green gate) and a stamp that needs recovery heal two ways: the next push to main publishes the newer tree, or an operator dispatches post-green.yml with the green commit's sha. Until the heal, a sync copies from the tip as it stands - the previous tree after a missing publish (the residuals table; a sync PR, when one opens, records the build commit it copied) - or fails resolve_build.ts's stamp checks over a broken stamp. Anything without a green `all-green` check at the source is not publishable - re-run that commit's CI first (the gate job posts the check), then dispatch.

The branch itself is an orphan, append-only: each build commit parents the previous build commit, never a main commit. So a main history rewrite can never invalidate it, and old build commits - each fleet repo's recorded build, the `commit` of its manifest's own entry - stay reachable forever.

The recorded build is the full 40-hex build commit sha: the writer takes it from the operator's `--build` argument (the tip resolve_build.ts resolved for the whole run) and writes it into the manifest's own entry ([sync.md](sync.md#the-manifest)), so every repository names the exact build its files came from.

## One publisher at a time

Every workflow publisher of `refs/heads/build` serializes in one repo-scoped concurrency lane, `build-branches-publish`, held by post-green.yml's publish job as a literal string: a called run and a dispatched run are runs of DIFFERENT workflows (the caller's and post-green.yml's), and a group derived from `github.workflow` would silently split the lane between them (post-green.yml's header).

The lane serializes only the workflows; out-of-band pushes are the residuals section's problem. Two mechanisms make the survivor rollback-proof anyway (publish.ts): a newest-green-wins staleness preflight against the tip's stamped source, decided before anything is assembled, and the plain - never force - push, which doubles as the compare-and-swap on the exact tip the preflight read. The residual is staleness-only (an out-of-order eviction leaves the branch one push behind, never rolled back), healed by the next push or a dispatch with the newer commit's sha.

## The no-empty-commit law

In normal operation a publish commits only on a content change (publish.ts owns the law; the one exception closes the table):

| Event | Assembled tree vs tip | Tip stamp | Result |
| --- | --- | --- | --- |
| A docs-only landing | identical | healthy | Nothing staged, nothing published. |
| Rerun of an already-published source | identical | healthy | Nothing published. |
| A content change lands green | differs | any | A new stamped commit. |
| A stale queued publisher runs after a newer main already published | any | healthy | Skip - newest-green wins (the staleness preflight reads the tip's stamp, before any assembly or tree comparison). |
| Dispatch over a tampered or unparsable stamp | identical | broken | Stamp recovery: a freshly stamped, tree-identical commit. |

No commit means no recorded-build bump in the fleet and no content-free sync PRs.

Stamp recovery is the one exception that commits an identical tree, and the only reason `--allow-empty` appears in publish.ts: the no-change skip is guarded by the tip's stamp health ([shared/stamp_checks.ts](../.github/scripts/shared/stamp_checks.ts)), so a tree-identical tip with a broken stamp gets healed by dispatch instead of wedging every sync until the next content change.

## The provenance proof

[sync/verify_build_provenance.ts](../.github/scripts/sync/verify_build_provenance.ts) (invoked by [sync/resolve_build.ts](../.github/scripts/sync/resolve_build.ts) after parsing the tip's source stamp) verifies the tip's content is exactly what the builder produces from its stamped source - the strongest claim available, since the ruleset model cannot pin the ref to one workflow and the stamp lines are plain text anyone can write. Three checks anchor them, all hard failures:

| # | Check | What it catches |
| --- | --- | --- |
| 1 | The stamped source is main history ([shared/stamp_checks.ts](../.github/scripts/shared/stamp_checks.ts)). | A stamp naming anything else was not the builder. |
| 2 | No rollback: no stamp in the tip's ancestry is strictly newer than the tip's own (`shared/stamp_checks.ts`). | A replayed old build, whose tree rebuilds cleanly from its old source. |
| 3 | Tree proof: rebuild from the stamped source with that commit's own script and require tree-hash equality with the tip. | Content the builder never produced from that source. |

Checks 1 and 2 are the same battery publish.ts's no-change skip guard runs, shared so the two can never drift.

A fourth check - proving the stamped run a green publish run via the Actions API - existed and was retired: a tree that rebuilds byte-identically from a main-history, non-rollback stamp IS the builder's output of that source, and greenness is proven independently (resolve_build.ts runs the all-green gate on the stamped source), so it anchored no content of its own while adding live-state trust (runs age out, workflows get renamed, so a valid tip could wedge every sync on a dead run id). The documented cost of its removal: actor provenance degraded from verified to advisory - the commit's `run:` line is a human breadcrumb, and a hand-pushed byte-identical tip is no longer distinguishable. A forensics loss, never a content-injection gain.

## Hermetic staging: one function of the bytes

The tree proof compares a scratch rebuild's hash against the tip's, so producers and verifier must stage identically - or the skew reads as a false tamper accusation.

[shared/stage_tree.ts](../.github/scripts/shared/stage_tree.ts) owns the one staging argv every site runs (`publish.ts`, and `rebuild_tree.ts` for the verifier). It neutralizes two config vectors:

| Vector | Neutralizer |
| --- | --- |
| Ignore rules silently dropping staged files: an in-tree `.gitignore`, a machine-global excludesFile, a planted `info/exclude`, the producer checkout's own exclude. | `add -A --force` |
| Blob rewriting at add time: a global `* text` attributes filter, a machine-global `core.autocrlf`. | `-c core.attributesFile=/dev/null -c core.autocrlf=false` |

`$GIT_DIR/info/attributes` is the one axis no flag can close (git reads it regardless of `core.attributesFile`); no site plants one, fresh checkouts and scratch repos carry none, so it stays a documented residual, not a covered vector. Any further rewrite axis git grows lands in this same class until a flag pins it: `core.autocrlf` sat here, measured live, before its override landed.

Hooks an `init.templateDir` plants are a residual of the same kind: `init` fires none, `add` and `write-tree` fire only `post-index-change` once the index is written, and no site plants one, so they stay documented, not neutralized.

Guards of this class - defenses against environmental hazards a hermetic test can never trip by accident - each ship with a hostile-fixture test that stages the hazard and forces the guard's failure branch, so a guard that stopped guarding goes red in the suite rather than silently passing.

[shared/rebuild_tree.ts](../.github/scripts/shared/rebuild_tree.ts) reproduces the builder exactly - the source commit's own script and frozen-lockfile dependencies - and hashes through a scratch index's write-tree, so file modes join the comparison too.

## Extraction safety: one branch, every consumer

The branch is both the writer's source and the fleet's executable channel (`uses: ...@build`). Its root, assembled by [branch_tree.ts](https://github.com/Vivswan/repo-platform/blob/main/.github/scripts/build-branches/branch_tree.ts): `files.yml` and `files/` (byte copies of this repository's), `actions/` (sources and dependency manifests, no `node_modules`; the dependency-free `actions/shared/` library ships with them so the tarball stays install-free), `.github/workflows/` (the fleet-facing reusable workflows the written workflows call `@build`; a `uses:` fetches the file at the named ref, so a branch without them 404s every caller), `reserved-labels.yml` (the label names the settings layers manage, derived from `files.yml`, which the plan action refuses as tracking labels), and a static `README.md`. Being one branch for both consumers constrains every path on it:

- Plain filenames only: a `uses:` ref downloads the whole branch tarball, so nothing on the branch may carry a name extraction cannot write; conditional landing is `files.yml`'s `when` clauses, never a filename.
- Nothing the builder publishes can run on the branch: [branch_tree.ts](../.github/scripts/build-branches/branch_tree.ts) hard-fails assembly if any shipped workflow carries a trigger other than `workflow_call` alone. PAT pushes can trigger workflows, so the safety is pinned by construction, not carried by omission; an out-of-band push bypasses the assembly guard entirely - the residuals section.
- The writer runs from this repository's checkout, never from the branch: the branch carries data the writer reads (`files.yml`, `files/`) and code the fleet's workflows execute (`actions/`, the reusable workflows), and the provenance proof covers both.

## Residuals

| Residual | Why it stands | What bounds it |
| --- | --- | --- |
| `uses: ...@build` execution trusts the ref. | A user-repo ruleset cannot restrict other writers - plain fast-forwards stay possible; only force-pushes and deletion are blocked. | Sync consumption is provenance-verified; repo-platform's own CI gates every builder-published change to the executable channel (an out-of-band push bypasses both, the ref-trust residual in full). |
| Actor provenance is advisory. | The run-proof check was retired as live-state trust (above). | Checks 1-3 anchor the content; the `run:` line stays a breadcrumb. |
| A sync copies from the build tip as it stands: a hand dispatch seconds after a merge, or the Tuesday cron (paused until the fleet cutover re-arms it) firing while a merge shortly before it is still in CI, copies the previous build, as does any sync while a publish is missing. | No freshness wait exists. The post-green call is needs-ordered behind the publish in the same run, so only a sync that wakes on its own (dispatch or cron) can meet the lag. | resolve_build.ts runs the green gate and provenance checks on that tip, and a sync PR, when one opens, records the build commit it copied; the next sync (the weekly cron, or a `[fleet-sync: public]` directive on the next merge - [all-green.md](all-green.md#after-the-gate)) consumes the publish once it lands, and a publish that never landed is healed by the next push or a dispatch with the green commit's sha. |
