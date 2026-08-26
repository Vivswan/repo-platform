# Agent brief: resolve and land the repo-platform template sync PR

Paste everything below the line into the agent working in each client repo (cwd'd in that repo, `gh` authenticated). Dispatcher notes: one agent per repo; the per-repo variance is item 2 (porting custom release logic); an agent reporting "no base to update from" or leftover conflict markers means that repo escalates to a `recover=recopy` dispatch on repo-platform instead of hand-fixing. This brief is one-time for the release-restructure onboarding wave; delete this file when the fleet is migrated.

---

Task: resolve and land the repo-platform template sync PR on this repo.

FIND YOUR OWN PR - you are not given a PR number. Work in the repository you are cwd'd in, and locate its sync PR yourself: `gh pr list --head automation/repo-platform-staging --json number,title,url` (if empty, also try `--head automation/repo-platform-latest`). It is titled `chore: update repo-platform template to ...`. Exactly one open sync PR should exist; if none exists or more than one does, stop and report that instead of guessing. This PR is a large, expected one-time restructure (release pipeline + ownership machinery); it is flagged manual-review, so it will NOT auto-merge. You resolve it fully - but DO NOT MERGE IT: merging is mine. Your job ends with the branch resolved, pushed, and green, plus your report.

Ground rules:

- NEVER MERGE THE PR - the human merges it. No `gh pr merge`, no enabling auto-merge, no approving reviews. Resolve, push, verify green, report.
- Never rebase or force-push the automation branch. Fix by checking it out fresh (`git fetch origin && git checkout -B automation/repo-platform-staging origin/automation/repo-platform-staging`), committing on top, and pushing.
- Never edit .copier-answers.yml underscore keys (_commit, _src_path).
- Once resolved, work fast to a green state: the branch is regenerated on the next sync run, and commits parked on it between runs are overwritten - flag readiness in your report so the human can merge before the next run.
- Read the PR body top to bottom FIRST - it itemizes every conflict, dropped local hunk, and retired file. Then classify EVERY file in the diff before merging; the reference is https://github.com/Vivswan/repo-platform/tree/main/skills/repo-platform-sync-pr

Expected changes in THIS PR and what to do with each:

1. `.github/workflows/release-please.yml` DELETED (retired). Expected. Confirm it was not locally repurposed; if custom jobs lived in it, save them for step 2.
2. `.github/workflows/release.yml` REWRITTEN to the managed pipeline (draft cut -> repo hook -> attested publish). This file was repo-owned before; any custom release logic in it is DROPPED toward the template and itemized in the PR body's conflict section. THE ONE REAL TASK: port those dropped hunks into `.github/workflows/update-release.yml` (new repo-owned starter, called with the tag between draft and publish). Asset uploads, release-note edits, publish-time side effects all go there. If there was nothing custom, the starter stays a no-op and that is fine.
3. New starters: `update-release.yml`, `update-release-pr.yml` (hook for release-PR refreshes). Repo-owned from now on; sync never touches them again.
4. New file `.github/repo-platform-manifest.json`: machine-written ownership map with per-file hashes. Never hand-edit it, now or later.
5. Comment-only churn across managed files (ownership headers, marker wording): accept as-is.
6. Split files (AGENTS.md, SECURITY.md, CONTRIBUTING.md, LICENSE.md, .gitattributes, .editorconfig, .github/CODEOWNERS): local content must survive BELOW the `repo-platform:local-section` marker. The resolver moves overlapping local hunks below the marker - verify placement. A deletion-dominant diff on any of these means local content loss: restore it below the marker before merging.
7. `.gitignore`: dropped local lines are NOT moved automatically - re-add them inside the BEGIN/END REPOSITORY LOCAL section from the PR body's list.
8. `.github/settings.yml` (three-way merged): restore ANY dropped hunk before merging - a key dropped toward the template is declared empty and the nightly settings apply will then CLEAR the live value (topics, homepage).
9. Toolchain pin bumps (.bun-version etc.): accept; never restore old versions.
10. Copilot (and any other bot) review comments on the PR: read them all (`gh pr view <number> --comments`, and the inline review comments via `gh api repos/{owner}/{repo}/pulls/<number>/comments`). Resolve each one: fix the valid ones on the branch, reply explaining why an invalid or inapplicable one is rejected, and include the disposition per comment in your report. Do not leave any comment unaddressed.
11. Anything the PR body and the modules list do NOT explain: stop and report it back to me instead of proceeding.

Done means: every changed file classified and cleared, dropped local content restored to its owned location, custom release logic ported to update-release.yml, every bot review comment fixed or answered, the branch pushed, and the repo's required `all-green` check green on it (the validate-template job is informational - a red there flags drift, it does not block). DO NOT MERGE. End your report with an explicit verdict line: "READY TO MERGE" when everything above holds, or "NOT READY: <what blocks it>". Also report: what you ported into update-release.yml, what local content you restored and where, the disposition of each bot comment, and anything unexplained you left open.
