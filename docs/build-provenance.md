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

Nothing writes the branch on a push before the gate: the compose happens inside the post-green run, after `all-green`.

## The delivery flow: push to publish

A template change merges to main as commit S. What happens, in order:

| Step | Actor | What happens |
| --- | --- | --- |
| 1. The gating jobs finish | ci.yml's `all-green` job | Judges every needed result; its own check run IS the `all-green` check ([all-green.md](all-green.md)). |
| 2. Gate green on a main push | ci.yml's post-green job | Calls [post-green.yml](../.github/workflows/post-green.yml) with `github.sha` (same run - the judged commit by construction). |
| 3. Publish | post-green.yml's publish-build job | [publish.ts](../.github/scripts/build-branches/publish.ts) composes S's tree with S's own script (a worktree at S, its frozen dependencies, `branch_tree.ts`) and chains a stamped commit onto the branch tip. Its `published` step output says whether the tip advanced. |
| 4. Redeploy this repository's docs | the same job, only when the tip advanced | Dispatches this repository's docs-site.yml on main, so the site built from `@build` never lags the theme the publish just shipped ([all-green.md](all-green.md#after-the-gate)). |

The source composed and stamped is always SOURCE_SHA - the judged run's own commit on the call, the operator's sha input on a dispatch - never a read of origin/main, which can already be a newer, even red, commit (publish.ts's header owns this discipline).

publish.ts hard-verifies SOURCE_SHA before any mutation: main history (the sync's stamp check 1 refuses anything else, so a dispatch naming a PR head would wedge every sync), then the `all-green` check run at that sha ([shared/all_green.ts](../.github/scripts/shared/all_green.ts)) - defense in depth on the call, where the needs edge already gated entry, and the sole gate on a dispatch.

A missing publish (a failed or evicted post-green run after a green gate) and a stamp that needs recovery heal two ways: the next push to main publishes the newer tree, or an operator dispatches post-green.yml with the green commit's sha. Until the heal, a sync renders from the tip as it stands - the previous tree after a missing publish (the residuals table; a sync PR, when one opens, records the build commit it rendered) - or fails resolve_refs.ts's stamp checks over a broken stamp. Anything without a green `all-green` check at the source is not publishable - re-run that commit's CI first (the gate job posts the check), then dispatch.

The branch itself is an orphan, append-only: each build commit parents the previous build commit, never a main commit. So a main history rewrite can never invalidate it, and old build commits - each fleet repo's recorded `_commit`, needed by copier update's three-way merge - stay reachable forever.

The recorded `_commit` is the full 40-hex build commit sha, never git's 7-char abbreviation or a tag name. copier's own value is `git describe --tags --always`, so the stamp hook rewrites it:

- copier.yml's two hook lines pass `--commit` with copier's `_copier_conf.vcs_ref_hash` (the template clone's `git rev-parse HEAD`) to [actions/shared/stamp_manifest.ts](../actions/shared/stamp_manifest.ts), which rewrites the `_commit:` line before stamping the manifest's provenance slot from it.
- The template owns the shape, so every producer records it: the sync, a plain `copier copy` at onboarding, the goldens, the harnesses. The sync's apply step resolves its target ref once, hands the sha to copier, and requires the written `_commit` to equal it (apply_update.ts).
- The hook is handed everything it needs and infers nothing. `--root .`: copier runs hooks with the destination as cwd, and `_copier_conf.dst_path` may be relative to the caller's cwd and would resolve inside the destination. `--commit`: the full hash. `--answers`: copier's active answers file, refused unless it is the template's declared `.github/.copier-answers.yml` (a render into another answers file would leave the default file stamped while the active one kept the abbreviation, so alternates are outside the contract).
- Both hook lines use copier's argv-list form: a string command runs through a shell, and the answers path is caller-controlled.
- Each render stamps the destination once: copier runs `_tasks` on an update's destination pass as well as the `after` migration, so the task stands down for updates (`_copier_operation != 'update'`).
- The write is all-or-nothing: the hook proves both files can take the stamp, marks each write attempted before it starts, reads both back structurally, and restores every attempted file on any failure.
- A repo rendered before the hook rewrite carries the abbreviation until its next sync PR rewrites the file.
- A render that bypasses the hook (`copier copy --skip-tasks`, or a build tree whose copier.yml lost the hook argument) keeps copier's abbreviated or tag-named value; such output is unsupported. Three checks catch it: the validator rejects a `_commit` that is not a full 40-hex sha, the `stamp-hook-path` ssot rule keeps a build tree from losing the argument without CI going red, and apply_update.ts's postcondition fails a sync whose render did not record the pinned commit.

## One publisher at a time

Every workflow publisher of `refs/heads/build` serializes in one repo-scoped concurrency lane, `build-branches-publish`, held by post-green.yml's publish job as a literal string: a called run and a dispatched run are runs of DIFFERENT workflows (the caller's and post-green.yml's), and a group derived from `github.workflow` would silently split the lane between them (post-green.yml's header).

The lane serializes only the workflows; out-of-band pushes are the residuals section's problem. Two mechanisms make the survivor rollback-proof anyway (publish.ts): a newest-green-wins staleness preflight against the tip's stamped source, decided before anything is composed, and the plain - never force - push, which doubles as the compare-and-swap on the exact tip the preflight read. The residual is staleness-only (an out-of-order eviction leaves the branch one push behind, never rolled back), healed by the next push or a dispatch with the newer commit's sha.

## The no-empty-commit law

In normal operation a publish commits only on a content change (publish.ts owns the law; the one exception closes the table):

| Event | Composed tree vs tip | Tip stamp | Result |
| --- | --- | --- | --- |
| A docs-only landing | identical | healthy | Nothing staged, nothing published. |
| Rerun of an already-published source | identical | healthy | Nothing published. |
| A content change lands green | differs | any | A new stamped commit. |
| A stale queued publisher runs after a newer main already published | any | healthy | Skip - newest-green wins (the staleness preflight reads the tip's stamp, before any compose or tree comparison). |
| Dispatch over a tampered or unparseable stamp | identical | broken | Stamp recovery: a freshly stamped, tree-identical commit. |

No commit means no fleet `_commit` bump and no content-free sync PRs.

Stamp recovery is the one exception that commits an identical tree, and the only reason `--allow-empty` appears in publish.ts: the no-change skip is guarded by the tip's stamp health ([shared/stamp_checks.ts](../.github/scripts/shared/stamp_checks.ts)), so a tree-identical tip with a broken stamp gets healed by dispatch instead of wedging every sync until the next content change.

## The provenance proof

[sync/verify_build_provenance.ts](../.github/scripts/sync/verify_build_provenance.ts) (invoked by resolve_refs.ts after parsing the tip's source stamp) verifies the tip's content is exactly what the builder produces from its stamped source - the strongest claim available, since the ruleset model cannot pin the ref to one workflow and the stamp lines are plain text anyone can write. Three checks anchor them, all hard failures:

| # | Check | What it catches |
| --- | --- | --- |
| 1 | The stamped source is main history ([shared/stamp_checks.ts](../.github/scripts/shared/stamp_checks.ts)). | A stamp naming anything else was not the builder. |
| 2 | No rollback: no stamp in the tip's ancestry is strictly newer than the tip's own (`shared/stamp_checks.ts`). | A replayed old build, whose tree rebuilds cleanly from its old source. |
| 3 | Tree proof: rebuild from the stamped source with that commit's own script and require tree-hash equality with the tip. | Content the builder never produced from that source. |

Checks 1 and 2 are the same battery publish.ts's no-change skip guard runs, shared so the two can never drift.

A fourth check - proving the stamped run a green publish run via the Actions API - existed and was retired: a tree that rebuilds byte-identically from a main-history, non-rollback stamp IS the builder's output of that source, and greenness is proven independently (resolve_refs.ts runs the all-green gate on the stamped source), so it anchored no content of its own while adding live-state trust (runs age out, workflows get renamed, so a valid tip could wedge every sync on a dead run id). The documented cost of its removal: actor provenance degraded from verified to advisory - the commit's `run:` line is a human breadcrumb, and a hand-pushed byte-identical tip is no longer distinguishable. A forensics loss, never a content-injection gain.

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

[shared/rebuild_tree.ts](../.github/scripts/shared/rebuild_tree.ts) reproduces the builder exactly - the source commit's own script and frozen-lockfile dependencies - and hashes through a scratch index's write-tree, so file modes and the `templates/base/` agent-file symlinks join the comparison too.

## Extraction safety: one branch, every consumer

The branch is both the copier source and the fleet's executable channel (`uses: ...@build`). Its root, assembled by [branch_tree.ts](https://github.com/Vivswan/repo-platform/blob/main/.github/scripts/build-branches/branch_tree.ts): `copier.yml` (a byte copy of this repository's, its generated `_exclude` region carrying the conditional-landing gates), the composed `template/`, `actions/` (sources and dependency manifests, no `node_modules`; the dependency-free `actions/shared/` library ships with them so the tarball stays install-free), `.github/workflows/` (the fleet-facing reusable workflows that rendered workflows call `@build`; a `uses:` fetches the file at the named ref, so a branch without them 404s every caller), `migrations/`, and a static `README.md`. Being one branch for both consumers constrains every path on it:

- Plain filenames only: a `uses:` ref downloads the whole branch tarball, and extraction dies on jinja-expression path segments, so conditional landing happens through copier.yml's generated `_exclude` region instead of filename gates.
- Nothing the builder publishes can run on the branch: [branch_tree.ts](../.github/scripts/build-branches/branch_tree.ts) hard-fails assembly if any shipped workflow carries a trigger other than `workflow_call` alone. PAT pushes can trigger workflows, so the safety is pinned by construction, not carried by omission; an out-of-band push bypasses the assembly guard entirely - the residuals section.
- The branch also carries `migrations/`, the [migration ladder](migrations.md)'s rung files verbatim: a sync walks the build commits between the target's recorded build and the delivered one and runs each rung that appeared, loading it from the newest build commit that carries it. Plain filenames outside `template/`, so copier never renders them.
- Rungs are executable code the sync runs from the build branch, like the stamp hook copier runs from the delivered tree; a rung that is still on the tip loads from the tip, which the provenance proof covers. Any rung absent from the verified tip loads from an older commit, and that commit is trusted as history: the branch is append-only under a ruleset that blocks force-pushes and deletion, the same trust every `uses: ...@build` ref already places in the branch (the residuals table).

## Residuals

| Residual | Why it stands | What bounds it |
| --- | --- | --- |
| `uses: ...@build` execution trusts the ref. | A user-repo ruleset cannot restrict other writers - plain fast-forwards stay possible; only force-pushes and deletion are blocked. | Sync consumption is provenance-verified; repo-platform's own CI gates every builder-published change to the executable channel (an out-of-band push bypasses both, the ref-trust residual in full). |
| Actor provenance is advisory. | The run-proof check was retired as live-state trust (above). | Checks 1-3 anchor the content; the `run:` line stays a breadcrumb. |
| A sync renders from the build tip as it stands: a hand dispatch seconds after a merge, or the Tuesday cron firing while a merge shortly before it is still in CI, renders the previous build, as does any sync while a publish is missing. | No freshness wait exists. The post-green call is needs-ordered behind the publish in the same run, so only a sync that wakes on its own (dispatch or cron) can meet the lag. | resolve_refs.ts runs the green gate and provenance checks on that tip, and a sync PR, when one opens, records the build commit it rendered; the next sync (the weekly cron, or a `[fleet-sync: public]` directive on the next merge - [all-green.md](all-green.md#after-the-gate)) consumes the publish once it lands, and a publish that never landed is healed by the next push or a dispatch with the green commit's sha. |
| A migration rung absent from the tip loads from a build commit the tree proof did not cover. | Only the tip is rebuilt and compared; older commits are trusted as append-only history, and an out-of-band fast-forward could park a rung in a middle commit that a lagging repository runs later. | The same write-access trust as `uses:` execution; a rung still on the tip loads from the verified tip, so the residual is confined to rungs the verified tip lacks ([migrations.md](migrations.md)). |
