---
order: 270
group: Fleet operations
---

# Ejecting a repository

This page detaches a repository from repo-platform management. To stop updates without detaching, see [Pause instead of eject](#pause-instead-of-eject).

Detaching is cheap by design: managed repos degrade to normal repos, not broken ones. Nothing at runtime depends on repo-platform except workflow `uses:` references, which keep working as long as repo-platform exists. Every reusable-workflow call (fleet CI, auto-assign, the site deploy) and every composite-action step is pinned at `@stable`, repo-platform's green-gated delivery tag ([build-provenance.md](build-provenance.md)).

Management is push-based, so ejecting starts in repo-platform, not in the repo: stop the machinery here, then optionally strip the managed files there.

## 1. Deregister in repo-platform

Leaving the fleet means revoking the fleet token's write access to the repo: remove the repo from the REPO_PLATFORM_TOKEN's repository access list.

- **The plan log:** a private repository disappears from discovery, and a public one stays listed with a notice ([what each case prints](#pause-instead-of-eject)).
- **Nothing is deleted** either way.
- **Nothing else to edit:** nothing in repo-platform lists the fleet.
- **Settings stop being applied too:** the central run only manages enrolled repos carrying a `.repo-platform.yml` and a rendered `.github/settings.yml` ([settings.md](settings.md)).

## 2. (Optional) Strip the managed files in the repo

1. Delete the management metadata:

   ```bash
   git rm .repo-platform.yml .github/repo-platform-manifest.json
   ```

2. Rewrite `.github/workflows/ci.yml`: the managed file is a thin caller of repo-platform's `fleet-ci.yml` reusable, and that call is all-or-nothing. Its `plan` step goes red once `.repo-platform.yml` (the registration it reads) is gone, and no input turns it off. Replace the `ci` job:

   | Part of ci.yml | What to do |
   |---|---|
   | the jobs you want | copy them out of `fleet-ci.yml` into ci.yml (the composite actions they call stay public), or write your own |
   | the copied `plan`, `validate`, and `managed-files` steps | drop them: they read the registration you deleted |
   | every copied step's condition | remove `steps.plan.outcome == 'success' &&` |
   | every copied job's `needs` list | remove `standard-checks` |
   | each `steps.plan.outputs.*` and `needs.standard-checks.outputs.*` condition and value | replace with your repo's literals (actionlint reports a read of the deleted step) |
   | the `release` and `site` legs | they need `ci` and read `needs.ci.outputs.*` in their conditions and inputs (`modules`, `tracking-labels`): delete the legs you do not keep, and replace every such read in the rest with your repo's literals |
   | the `site` job | it calls `reusable-site.yml`, which configures the deploy from `.repo-platform.yml` and takes no input but the commit `sha`. Replace the job with your own deploy that runs `.github/actions/site-build`, passes the pages-site action its `config` by hand, and uploads the output. The hook itself is already yours |
   | every job you remove | rewire each surviving job's `needs` to jobs that still exist (actionlint reports a dangling one) |
   | the `nightly` caller | it runs `fleet-nightly.yml` on the schedule in a public repository, and its plan job reads the registration too: delete the job, or inline the scan with literal configuration |
   | ci.yml's `all-green` job | it keeps judging whatever its needs list names; drop it too if you drop the `all-green` required check from your branch protection |

3. (Optional) Inline the reusable workflows. Skip this if repo-platform continues to exist: the pinned references keep working unchanged. Otherwise:

   | Reference | Replacement |
   |---|---|
   | each thin caller (`auto-assign.yml`, the `site` job's `reusable-site.yml` call, the `ci` job's `fleet-ci.yml` call) | a copy of the corresponding `reusable-*.yml`/fleet job from repo-platform |
   | the `all-green` job | nothing: it already runs a third-party action |
   | `uses: Vivswan/repo-platform/actions/...` steps | vendored copies of the action scripts |
   | CodeQL (runs inside fleet-ci's `codeql` matrix) | inline repo-platform's `reusable-codeql.yml` too if you want CodeQL without repo-platform |
   | the `pr-title.yml` workflow (one more `uses: Vivswan/repo-platform/actions/...` step: the `validate-commit-names` action with the PR title as its `title` input) | vendor it like the others, or delete the workflow and drop its required check from the `pr-title` ruleset |

4. (Optional) Strip the marker comments from `.gitignore`. The content keeps working either way.

5. Commit:

   ```bash
   git commit -m "chore: detach from repo-platform management"
   ```

Every remaining file is plain configuration that works standalone: the rendered settings.yml and your settings.local.yml, AGENTS.md, editorconfig, gitignore content, CI jobs. settings.yml is a complete github-settings-as-code document you can apply from the repo's own workflow.

## Pause instead of eject

To stop receiving sync PRs without detaching, do one of these, and undo it to resume updates. Both pauses also stop the central settings apply for the repo.

| Pause | How | In the plan log |
|---|---|---|
| a revoked public repo | revoke the fleet token's write access to the repo (fleet side: the same step as deregistering; re-grant it to resume) | stays listed, and every plan whose scope selects that repository prints one notice that the token cannot push to it |
| a revoked private repo | the same revoke | nothing (it is no longer discovered) |
| the deleted-file pause | delete `.repo-platform.yml` from the repo (the sync skips repos without it) | a notice that the repo is "skipped - no .repo-platform.yml on its default branch, so it has not adopted the platform" |

The token's repository access list is the authoritative view of which repos are paused.
