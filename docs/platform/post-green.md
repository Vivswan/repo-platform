---
order: 260
---

# The post-green run

This page is repo-platform's own run after its `all-green` gate: the tag mover, the fleet sync and settings legs, how the fleet-sync label is read, the bot that labels a platform PR by default, how the skeleton's static legs gate, and the gate's residuals. The gate, the lane rule, the hook every managed repository owns, and the label from a PR author's side are [all-green.md](../all-green.md).

## The run, leg by leg

```text
all-green -> post-green -> site
             post-green.yml: move-stable -> read-directives -> sync-fleet -> settings-fleet
```

**The `post-green` job** calls [post-green.yml](../../.github/workflows/post-green.yml), whose `move-stable` leg moves the `stable` tag, the fleet's delivery ref, to the judged commit in that run - re-verifying main history and the check at the commit before the push ([build-provenance.md](build-provenance.md)).

- post-green.yml's only other way in is a `workflow_dispatch` with a green main commit's `sha`, which runs the mover alone: the self-heal for a tag move that failed or was evicted after its gate passed (the next push heals it too; a sync meanwhile renders the commit the tag still names).
- The file's header has the coalescing contract every leg there must satisfy.

**The mover** ([post-green/move_stable.ts](../../.github/scripts/post-green/move_stable.ts)) re-verifies main history and the check at the sha, reads where the tag sits, and moves it with a lease push, the compare-and-swap that makes a racing mover lose loudly.

- It moves nothing when the tag already names the sha or a newer green commit's run already moved it past the sha (newest-green wins).
- The tag's ruleset ([.github/settings.local.yml](../../.github/settings.local.yml)) blocks deletion only: git treats any move of an existing tag as a forced update, so a force-push or update rule would block the mover itself.

**Repo-platform's own docs site** is the skeleton's `site` leg, carried by hand in its ci.yml, since this repository's ci.yml is its own, not the managed skeleton. The deploy runs after this run's mover, so a green move's theme is what `@stable` serves it. A red or skipped post-green does not hold it back: it deploys from the tag as it stands.

It calls reusable-site.yml by local path; the reusable plans the site configuration from this repository's registration, as it does for every fleet repository.

**The `read-directives` leg** reads the fleet-sync label of every pull request merged in its range ([which commits a run reads](#which-commits-a-run-reads)). When a PR in that range opted in, `sync-fleet` calls sync-repos.yml in the same run, holding the `sync-repos` lane the weekly cron also holds.

- The leg is ordered behind `move-stable` for its base and never stands down on the mover's word: a newer commit's run reads from its own base, exclusive, which can be this very commit, so only this commit's run is sure to read it.

- After a failed sync, re-run the FAILED jobs: the mover's `previous` output survives, so the whole range syncs. A re-run of every job finds the tag already moved and reads the original push's range alone, from its `before` to the judged commit, so an opt-in merged before that push waits for the weekly cron or a hand dispatch.

- The labels are [all-green.md's](../all-green.md#opting-a-pr-into-an-immediate-fleet-sync); how the leg reads them is [below](#how-the-leg-reads-the-label).

**The `settings-fleet` leg** calls settings-repos.yml for every target on every called run, with no diff deciding it. The apply is idempotent and reads each target's rendered `.github/settings.yml` beside its live state, so a run that changed no settings input is an early nightly heal: it fixes whatever out-of-band drift its targets carry and nothing else.

- It runs behind `sync-fleet` whatever that leg's result (skipped, green or red), so a repo whose sync PR merged is applied from its new render, and it holds the `settings-repos` lane the nightly cron also holds.
- The called run gates on the judged commit through the mover's bounded all-green poll ([settings-apply.md](settings-apply.md#the-green-commit-gate)).

**A red mover skips the sync** (the commit the tag names is stale), nothing else: the settings apply reads no delivery ref (each target's rendered `.github/settings.yml` sits in the target), so it still runs, exactly as it does on a call with no label. A mover that stands down because a newer commit already moved the tag exits green, and the sync then renders from that newer commit.

**Both fleet writers reach the fleet this way and never from a `push`:** their triggers are the schedule, a dispatch, and the post-green call, and the self-woken paths gate in-script (the sync writes only what the `stable` tag names, the settings apply refuses an ungreen commit).

**The fleet PAT** is a secret of the `fleet-operator` environment ([.github/settings.local.yml](../../.github/settings.local.yml)), whose branch policy admits main alone. Only a job declaring `environment: fleet-operator` in a main run can read `REPO_PLATFORM_TOKEN`, and GitHub holds that rule, not a check here.

- A caller job cannot declare an environment, so the writers' jobs declare it themselves.

- Each caller on the chain says `secrets: inherit`: a job reached through two calls reads the environment secret only when every caller on the chain inherits ([actions/runner#4453](https://github.com/actions/runner/issues/4453)).

- GitHub hands a job that cannot see the secret the empty string, so every declaring job's first read of it is the `Require the fleet token` step ([fleet/require_fleet_token.ts](../../.github/scripts/fleet/require_fleet_token.ts)). An empty read fails the job with the setup recipe, and no fleet write ever runs on `github.token`.

## How the leg reads the label

- **How the leg finds it:** the squash commit carries the PR title alone (the fleet override sets `squash_merge_commit_message: BLANK`), so `read-directives` looks up each commit's merged pull request through the API (`GITHUB_TOKEN`, read) and reads its labels ([post-green/fleet_sync_marker.ts](../../.github/scripts/post-green/fleet_sync_marker.ts)).

- **Where the labels are declared:** this repository's own settings overlay ([.github/settings.local.yml](../../.github/settings.local.yml)); only this repository's PRs carry them, so the fleet's baseline does not. The leg reads that list at run time, the suffix naming the scope.

- **Label names fold case,** as GitHub keeps them unique.

- **The scope grammar:** [fleet/sync_scope.ts](../../.github/scripts/fleet/sync_scope.ts) owns it for the dispatch input and both writers' plans, which expand the visibility tokens (`public`, `private`) against discovery.

## Which commits a run reads

The leg reads a range: from the commit the `stable` tag named before this run moved it (the mover's `previous` output), up to the judged commit ([post-green/judged_range.ts](../../.github/scripts/post-green/judged_range.ts)); not the judged commit alone. Three PRs merged within one minute, `fleet-sync:public` on the first only, and only the third's mover lands:

```text
::notice::fleet-sync label on <first merge>: public
::notice::<the tag's previous commit>..<third merge> opted in: syncing public now
```

Why a range: every push gets its own run, but the mover legs of neighbouring commits queue on the `stable-tag-move` lane under [the lane rule](../all-green.md#after-the-gate). A commit whose mover was replaced there never syncs from its own run, and its successor's own `before..sha` would miss it.

The tag's previous commit is a durable base: the range from it covers every commit since the last move, replaced movers included, so an opt-in survives its own mover being replaced at the lane.

- **When the mover reports no previous commit** (the tag did not move: it already named the sha or a newer commit, it did not exist yet, or the mover went red), the base is the push payload's `before`. A replay at the tag's own commit is such a case.

- **The base must be in the checkout** and a strict ancestor of the judged commit, or the leg fails naming it (a force-push, a foreign payload, or a tag moved out of band).

- **An all-zeros `before`** (a branch-creating push) reads the whole history from the empty tree.

- **Several opt-ins in the range union:** any `all` wins, otherwise `public`.

- **Refused labels by commit:** the judged commit's refused labels turn the leg red. An older commit's (its own run was red, or its mover was replaced at the lane) are a warning naming the commit and contribute nothing, and the next merge's correct label still syncs.

- **A merge never loses its own run** (push runs are keyed by the commit), but its mover leg is replaced when a third mover queues on the `stable-tag-move` lane while one runs and one waits. A running mover is never cancelled, and the surviving run's range still reads its label.

- **The `sync-repos` lane** replaces a pending sync the same way. When the tag had already moved past that merge, no later range covers its label: the next fleet-wide sync-repos.yml run (its cron, or a dispatch) heals it.

- **A failed lookup:** a pull request lookup that fails (the API down, a token without read access), or two pull requests claiming the commit as their merge, turns the leg red for the whole range, never a quiet `armed=false`.

The opt-in waits for the weekly sync cron (or a hand dispatch) when:

- no later green run reaches post-green before it
- the opt-in was merged before a push whose run's tag did not move (a re-run of every job after a failed sync included), since that run reads from the push's own `before` alone
- the leg went red on the commit's own run and a later mover moved the tag past it

## The default label: fleet-sync-default.yml

**The public sync by default, never a gate:** [fleet-sync-default.yml](../../.github/workflows/fleet-sync-default.yml) adds `fleet-sync:public` to a pull request of this repository that changes what a sync delivers and wears no fleet-sync label. It keeps one sticky comment saying so ([its script](../../.github/scripts/fleet/fleet_sync_default.ts)).

- **Watches the delivered surface:** `files.yml`, `files/`, `actions/`, `.github/scripts/sync/`, `.github/scripts/shared/`, `migrations/`, `bun.lock`, and `package.json` (`DELIVERED_SURFACE` in [its script](../../.github/scripts/fleet/fleet_sync_default.ts)), so a lockfile bump gets the label too.

- **Any other change** is live at `stable` on merge and gets no label. Whether that sync then moves a repository's judge is the stamp rule ([platform/sync/manifest.md](sync/manifest.md#when-the-judged-commit-moves)): a theme change syncs nothing and restamps nothing.

- **Not forced:** a human removing the label is final for that pull request (the comment then reads `removed by <login>; not re-adding it`), and a human's own fleet-sync label is never touched.

- **`fleet-sync:all` only when necessary** and approved by the repository owner: it bills private Actions minutes.

- **The bot withdraws its own label** when the paths leave the diff, the PR targets a branch other than the default, or a human picks another fleet-sync label; a label the merge would refuse is named in the comment.

- **Triggers:** opened, synchronize, reopened, edited (a retarget arrives as edited), labeled, and unlabeled; a closed PR is left as it is. GitHub runs no pull_request workflow on a conflicting PR, so the label catches up at the next push.

- **Outside the gate:** it sits outside `all-green`'s needs, and exits 0 on every path with a warning annotation: a fork's read-only token, a file listing GitHub capped at 3,000.

## How the static legs gate

The legs, what each does for a repository, and the release leg's known limits are [all-green.md's](../all-green.md#the-static-legs). What the managed ci.yml spells to get them:

- **`release` and `site` gate on fleet-ci's `modules` output,** each naming its own module: `contains(needs.ci.outputs.modules, '"release-please"')` and `contains(needs.ci.outputs.modules, '"site"')`, a substring test on the compact JSON array, hence the quoted name.

- **The release hooks** gate on the `release` job's outputs.

- A job reads outputs only from its direct dependencies, so `ci` sits in the needs list of `release` and `site`.

- **The cut's lane is keyed by the judged sha,** so no other run shares it and nothing can cancel a pending cut; a re-run of the same commit waits, then finds the release already cut.

- **The leg itself holds no lane:** a shared lane keeps one pending call and cancels the older one, so a release commit's call could be cancelled before it cuts.

## Residuals, stated

- **A PR can still gut a called workflow's content** (checks.yml is repo-owned) or hand-condition the managed `ci` caller away. validate-managed-files blocks any edit to the managed ci.yml, the caller's condition included, and review owns the rest - the same same-repo residual every check has.

- **Any workflow in this repository could mint a look-alike `all-green` check run** (the Actions app pin does not distinguish jobs). The repo is its own sole workflow author; review owns that surface.

- **A job-created `all-green` check from a pull_request run** judged the merge tree, not the sha, and would vouch for a sha that is also a main commit. Reachable only when a PR head becomes a main commit itself, which squash-only merges make contrived (an assessment, not a tested claim).

- **Copilot code review is advisory:** the `copilot_code_review` rule requests a review on every public-repo PR, but nothing blocks on it ([settings.md](../settings.md#copilot-code-review)).
