# Build provenance

How the `build` branch gets published, how a sync verifies the tip before consuming it, and which trusts remain. This document is the map, not the authority: every invariant here lives in exactly one code header, named per section, and the header is where the full reasoning stays.

| Question | Owner |
| --- | --- |
| When does a publish happen, and what gates it? | [build-branches/publish.ts](../.github/scripts/build-branches/publish.ts) |
| How does a sync know the tip is fresh? | [sync/wait_for_build.ts](../.github/scripts/sync/wait_for_build.ts) |
| How does a sync verify the tip's content before consuming it? | [sync/verify_build_provenance.ts](../.github/scripts/sync/verify_build_provenance.ts) |
| Why do producer and verifier hash the same tree? | [shared/stage_tree.ts](../.github/scripts/shared/stage_tree.ts) and [shared/rebuild_tree.ts](../.github/scripts/shared/rebuild_tree.ts) |
| Which workflows drive the flow? | [build-branches.yml](../.github/workflows/build-branches.yml), [ci.yml](../.github/workflows/ci.yml) (the [all-green gate](all-green.md) + post-green jobs), [post-green.yml](../.github/workflows/post-green.yml) |

## Who can write `refs/heads/build`?

| Writer | When | What gates the write |
| --- | --- | --- |
| post-green.yml's publish-build job | After the `all-green` gate passes on a push to main | ci.yml's post-green job (needs-ordered behind the gate, same run) releases it, and publish.ts re-verifies the check at the source before any mutation. |
| Build Branches' schedule and dispatch legs | Weekly cron, or manual dispatch (the self-heal) | publish.ts's all-green verification at the source is the SOLE green gate there. |
| Anyone with push access, out of band | Any time | Nothing at write time: a user-repo ruleset blocks only force-pushes and deletion, so plain fast-forwards stay possible. Sync consumption is provenance-verified below; `uses:` execution trusts the ref (the residuals table). |

Build Branches' push leg is deliberately NOT on this list: on every push to main it writes only the pending ref `build-pending/<sha>`, never the branch itself.

## The delivery flow: push to publish

A template change merges to main as commit S. What happens, in order:

| Step | Actor | What happens |
| --- | --- | --- |
| 1. Push to main | Build Branches' push leg ([build-branches.yml](../.github/workflows/build-branches.yml)) | Composes S's tree concurrently with CI and parks it, unpublished, at `refs/heads/build-pending/<S>` (`build_pending.ts`; `pending.ts` owns the ref grammar). |
| 2. The gating jobs finish | ci.yml's `all-green` job | Judges every needed result; its own check run IS the `all-green` check ([all-green.md](all-green.md)). |
| 3. Gate green on a main push | ci.yml's post-green job | Calls [post-green.yml](../.github/workflows/post-green.yml) with `github.sha` (same run - the judged commit by construction). |
| 4. Publish | post-green.yml's publish-build job | [publish.ts](../.github/scripts/build-branches/publish.ts) promotes the parked tree (composing as the fallback when the pending ref is missing) and chains a stamped commit onto the branch tip. |

The source composed and stamped is always SOURCE_SHA - the judged run's own commit on the green path, the trigger commit on schedule/dispatch - never a read of origin/main, which can already be a newer, even red, commit (publish.ts's header owns this discipline).

publish.ts hard-verifies the `all-green` check run at SOURCE_SHA before any mutation ([shared/all_green.ts](../.github/scripts/shared/all_green.ts)): defense in depth on the green path above, where the needs edge already gated entry, and the sole green gate on the self-heal legs below.

Build Branches' schedule and dispatch legs are the self-heal publishers: they compose and publish in one run, covering a publish that went missing after a green gate (a failed or evicted post-green run) and a stamp that needs recovery. Anything without a green `all-green` check at the source is not theirs to heal alone - re-run that commit's CI first (the gate job posts the check), then Build Branches (build-branches.yml's header).

The branch itself is an orphan, append-only: each build commit parents the previous build commit, never a main commit. So a main history rewrite can never invalidate it, and old build commits - each fleet repo's recorded `_commit`, needed by copier update's three-way merge - stay reachable forever.

The recorded `_commit` is the full 40-hex build commit sha, never git's 7-char abbreviation or a tag name: copier's own value is `git describe --tags --always`, so copier.yml's two hook lines pass `--commit {{ _copier_conf.vcs_ref_hash }}` (the template clone's `git rev-parse HEAD`) to [actions/shared/stamp_manifest.ts](../actions/shared/stamp_manifest.ts), which rewrites the `_commit:` line before stamping the manifest's provenance slot from it. The template owns the shape, so every producer records it - the sync, a plain `copier copy` at onboarding, the goldens, the harnesses - and the sync's apply step checks the written value against the commit it pinned copier to (apply_update.ts). A repo rendered before the hook rewrite carries the abbreviation until its next sync PR rewrites the file.

## One publisher at a time

Both workflow publishers of `refs/heads/build` serialize in one repo-scoped concurrency lane, `build-branches-publish`, shared as a literal string between post-green.yml's publish job and Build Branches' self-heal leg (a group derived from `github.workflow` would silently split the lane inside a `workflow_call`'d workflow - post-green.yml's header).

The lane serializes only the workflows; out-of-band pushes are the residuals section's problem. Two mechanisms make the survivor rollback-proof anyway (publish.ts): a newest-green-wins staleness preflight against the tip's stamped source (`pending.ts` owns the rule), and the plain - never force - push, which doubles as the compare-and-swap on the exact tip the preflight read. The residuals are staleness-only, healed by the next push or the weekly cron (build-branches.yml's concurrency comment enumerates them).

## The no-empty-commit law

In normal operation a publish commits only on a content change (publish.ts owns the law; the one exception closes the table):

| Event | Composed tree vs tip | Tip stamp | Result |
| --- | --- | --- | --- |
| A quiet week's cron | identical | healthy | Nothing staged, nothing published. |
| Rerun of an already-published source | identical | healthy | Nothing published. |
| A content change lands green | differs | any | A new stamped commit. |
| A stale queued publisher runs after a newer main already published | any | any | Skip - newest-green wins (the staleness preflight, before any tree comparison). |
| Dispatch over a tampered or unparseable stamp | identical | broken | Stamp recovery: a freshly stamped, tree-identical commit. |

No commit means no fleet `_commit` bump and no content-free sync PRs; freshness needs no commit either, because the sync computes it (next section) instead of trusting a marker ref or a filler commit.

Stamp recovery is the one exception that commits an identical tree, and the only reason `--allow-empty` appears in publish.ts: the no-change skip is guarded by the tip's stamp health ([shared/stamp_checks.ts](../.github/scripts/shared/stamp_checks.ts)), so a tree-identical tip with a broken stamp gets healed by dispatch instead of wedging every sync until the next content change.

## Freshness: two paths, neither trusting live state

[sync/wait_for_build.ts](../.github/scripts/sync/wait_for_build.ts) bounds the wait between a merge and a consumable build tip. The target is main's live HEAD on cron and dispatch runs; a sync called from post-green ([all-green.md](all-green.md#after-the-gate)) passes the judged commit instead, since main may already hold a later merge whose own run is queued behind that one. "HEAD" below means whichever target applies:

| Path | What ends the wait | When it decides |
| --- | --- | --- |
| Fast | The tip's source stamp names main's HEAD - deliberately stamp-only, the tree unread (a tampered tree under a HEAD stamp goes red at the provenance verify instead). | After any publish stamped with HEAD: a content change, or a stamp recovery. |
| Slow | Rebuild the composed tree at main's HEAD ([shared/rebuild_tree.ts](../.github/scripts/shared/rebuild_tree.ts)) and compare tree hashes with the tip, counted only under a healthy tip stamp. | The common path: after a docs-only or quiet landing the stamp never moves, so computed equality is the only freshness proof. |

A green build-branches run at HEAD is deliberately not trusted as freshness: the push leg only parks a pending tree, so a green run there proves nothing about what the branch tip carries.

The rebuild runs once, before the poll loop; any rebuild failure degrades to the stamp-only poll under the script's warn-and-continue contract. A timeout only warns, and the sync proceeds against the previous build tip - script/template skew, exactly the state a pre-gate sync always ran in - which every downstream gate still judges: `sync/resolve_refs.ts` re-runs the green gate on that tip's stamped source and the provenance checks below. The wait is a freshness aid; the gates live elsewhere.

## The provenance proof

[sync/verify_build_provenance.ts](../.github/scripts/sync/verify_build_provenance.ts) (invoked by resolve_refs.ts after parsing the tip's source stamp) verifies the tip's content is exactly what the builder produces from its stamped source - the strongest claim available, since the ruleset model cannot pin the ref to one workflow and the stamp lines are plain text anyone can write. Three checks anchor them, all hard failures:

| # | Check | What it catches |
| --- | --- | --- |
| 1 | The stamped source is main history ([shared/stamp_checks.ts](../.github/scripts/shared/stamp_checks.ts)). | A stamp naming anything else was not the builder. |
| 2 | No rollback: no stamp in the tip's ancestry is strictly newer than the tip's own (`shared/stamp_checks.ts`). | A replayed old build, whose tree rebuilds cleanly from its old source. |
| 3 | Tree proof: rebuild from the stamped source with that commit's own script and require tree-hash equality with the tip. | Content the builder never produced from that source. |

Checks 1 and 2 are the same battery publish.ts's no-change skip guard runs, shared so the two can never drift.

A fourth check - proving the stamped run a green build-branches run via the Actions API - existed and was retired: it anchored no content of its own while adding live-state trust (runs age out, workflows get renamed, so a valid tip could wedge every sync on a dead run id). The documented cost of its removal: actor provenance degraded from verified to advisory - the commit's `run:` line is a human breadcrumb, and a hand-pushed byte-identical tip is no longer distinguishable. A forensics loss, never a content-injection gain; the full argument is verify_build_provenance.ts's header.

## Hermetic staging: one function of the bytes

The tree proof and the freshness slow path both compare a scratch rebuild's hash against the tip's, so producers and verifier must stage identically - or the skew reads as a false tamper accusation in the proof and a permanent "not fresh" in the slow path.

[shared/stage_tree.ts](../.github/scripts/shared/stage_tree.ts) owns the one staging argv all four sites run (`build_pending.ts`, `publish.ts`, and `rebuild_tree.ts` for both consumers). It neutralizes two config vectors:

| Vector | Neutralizer |
| --- | --- |
| Ignore rules silently dropping staged files: an in-tree `.gitignore`, a machine-global excludesFile, a planted `info/exclude`, the producer checkout's own exclude. | `add -A --force` |
| Blob rewriting at add time: a global `* text` attributes filter, a machine-global `core.autocrlf`. | `-c core.attributesFile=/dev/null -c core.autocrlf=false` |

`$GIT_DIR/info/attributes` is the one axis no flag can close; no site plants one, so it stays a documented residual, not a covered vector (stage_tree.ts's header).

Guards of this class - defenses against environmental hazards a hermetic test can never trip by accident - are registered in [scripts/guard_registry.ts](../scripts/guard_registry.ts), each bound to the hostile-fixture test that forces its failure branch: `bun run guards:binding` proves the binding on every commit, and the weekly [audit-guards.yml](../.github/workflows/audit-guards.yml) proves the arming by unarming each guard in a scratch clone and requiring the named test red. The registry header has the rules.

[shared/rebuild_tree.ts](../.github/scripts/shared/rebuild_tree.ts) reproduces the builder exactly - the source commit's own script and frozen-lockfile dependencies - and hashes through a scratch index's write-tree, so file modes and the `templates/agents/` symlinks join the comparison too.

## Extraction safety: one branch, every consumer

The branch is both the copier source and the fleet's executable channel (`uses: ...@build`), which constrains every path on it:

- Plain filenames only: a `uses:` ref downloads the whole branch tarball, and extraction dies on jinja-expression path segments, so conditional landing happens through copier.yml's generated `_exclude` region instead of filename gates.
- Nothing the builder publishes can run on the branch: [branch_tree.ts](../.github/scripts/build-branches/branch_tree.ts) hard-fails assembly if any shipped workflow carries a trigger other than `workflow_call` alone. PAT pushes can trigger workflows, so the safety is pinned by construction, not carried by omission (build-branches.yml's header); an out-of-band push bypasses the assembly guard entirely - the residuals section.

## The settings self-apply's two-hop

Every fleet-rendered reference to this repository rides `@build` (the `fleet-refs-ride-build` rule in scripts/check_ssot.ts is the categorical law), and the branch ships only workflow files, actions, and the composed template - never the repo scripts. [reusable-apply-settings.yml](../.github/workflows/reusable-apply-settings.yml) needs those scripts, so it hops twice: the workflow FILE resolves at the caller's `@build` pin, and its resolve step reads that build commit's provenance stamp and checks the scripts out at the stamped source - the exact green main commit the tree was composed from, so green-gating holds end to end. A stampless sha is used only when it is provably main history (a pre-two-hop caller pin); anything else fails closed (tests/fleet/apply_settings_scripts_ref.test.ts forces the refusal). Like every `uses:`, both hops trust the ref they resolved - the residuals table's first row covers them.

## Residuals

| Residual | Why it stands | What bounds it |
| --- | --- | --- |
| `uses: ...@build` execution trusts the ref. | A user-repo ruleset cannot restrict other writers - plain fast-forwards stay possible; only force-pushes and deletion are blocked. | Sync consumption is provenance-verified; repo-platform's own CI gates every builder-published change to the executable channel (an out-of-band push bypasses both, the ref-trust residual in full). |
| Actor provenance is advisory. | The run-proof check was retired as live-state trust (above). | Checks 1-3 anchor the content; the `run:` line stays a breadcrumb. |
| Parking a poisoned pending tree is as powerful as fast-forwarding `refs/heads/build`. | Pending refs cannot be ruleset-scoped to the publisher on user repositories (`pending.ts`'s header). | The sync's provenance rebuild bounds template consumption; publish.ts's shape guard bounds what a malformed pending tree can publish. |
| A freshness timeout lets the sync proceed on the previous build tip. | The bounded wait is an aid, not the gate. | resolve_refs.ts still runs the green gate and provenance checks on that tip; the weekly cron heals the miss (or a `[fleet-sync]` directive on the next merge runs the sync at once - [all-green.md](all-green.md#after-the-gate)). |
