#!/usr/bin/env bash
# Creates or refreshes the sync PR in the target and arms squash
# auto-merge on clean revisions (needs-review ones stay disarmed by the
# earlier disarm_pr.sh step). Invoked by reusable-template-sync.yml's
# "Create or refresh pull request" step.
#
# Env: TARGET, TARGET_REF, OLD_COMMIT, DISPLAY, BRANCH, BASE_BRANCH,
# VALIDATION, RESOLVED, RECOVER, SUMMARY_FILE, RETIRED_MODULES_FILE,
# REMOVED_PATHS_FILE, WITHHELD_FILE, GH_TOKEN, GITHUB_REPOSITORY,
# GITHUB_OUTPUT, RUNNER_TEMP.
set -euo pipefail

if [ "$TARGET_REF" = "staging" ]; then
  source_line="[\`${GITHUB_REPOSITORY}\`](https://github.com/${GITHUB_REPOSITORY}/tree/staging) (staging channel)"
else
  ver="${TARGET_REF#templates/}"
  source_line="[\`${GITHUB_REPOSITORY}\`](https://github.com/${GITHUB_REPOSITORY}/releases/tag/${ver})"
fi

title="chore: update repo-platform template to ${DISPLAY}"
body="Automated template update from ${source_line}.

- Previous: \`${OLD_COMMIT}\`
- New: \`${DISPLAY}\`

Review any merge conflicts and confirm repository-local sections were preserved before merging.

> [!NOTE]
> This branch is regenerated on every sync run; manual commits
> pushed to it are overwritten. Make fixes in a separate branch or
> after merging."

if [ "$RECOVER" = "recopy" ]; then
  body="${body}

> [!WARNING]
> RECOVERY RE-RENDER: this update was dispatched with recover=recopy
> because the recorded template base was unusable. There was no
> three-way merge - local edits to template-managed files are
> overwritten in this diff (repo-owned generated-once files and
> settings.yml survive), and retired-file cleanup was skipped.
> Review the whole diff before merging."
fi

if [ -s "$RETIRED_MODULES_FILE" ]; then
  body="${body}

Retired modules dropped from the selection: $(paste -sd ', ' "$RETIRED_MODULES_FILE")"
fi

if [ -s "$REMOVED_PATHS_FILE" ]; then
  body="${body}

The template retired these files; this update deletes them:

$(sed 's/^/- /' "$REMOVED_PATHS_FILE")"
fi

if [ -s "$WITHHELD_FILE" ]; then
  body="${body}

> [!WARNING]
> Workflow-file changes were WITHHELD from this update: the sync
> token lacks the Workflows scope. Grant Workflows read/write to
> the REPO_PLATFORM_TOKEN and re-run the sync to include them.

$(sed 's/^/- /' "$WITHHELD_FILE")"
fi

if [ "$RESOLVED" = "true" ]; then
  body="${body}

> [!WARNING]
> copier hit merge conflicts, resolved below in favor of the
> template where possible. Restore any dropped local lines that
> should stay, and hand-edit anything marked unresolved, before
> merging.

$(cat "$SUMMARY_FILE")"
fi

if [ "$VALIDATION" = "failed" ]; then
  body="${body}

> [!WARNING]
> Validation failed on the updated tree (details in the sync run
> log). Fix it in this PR before merging."
fi

# Anything that needs human review - dropped local hunks, withheld
# workflow files, failed validation, a recovery re-render - stays manual;
# a clean update arms squash auto-merge below.
needs_review=false
if [ "$RESOLVED" = "true" ] || [ "$VALIDATION" = "failed" ] ||
  [ "$RECOVER" = "recopy" ] || [ -s "$WITHHELD_FILE" ]; then
  needs_review=true
fi

existing="$(gh pr list -R "$TARGET" --head "$BRANCH" --json number --jq '.[0].number // empty')"
if [ -n "$existing" ]; then
  # Auto-merge was disarmed BEFORE the push (disarm_pr.sh); this step
  # only refreshes the PR and re-arms clean revisions below.
  # The rolling branch is force-pushed over; keep title/body honest.
  gh pr edit "$existing" -R "$TARGET" --title "$title" --body "$body"
  url="$(gh pr view "$existing" -R "$TARGET" --json url --jq .url)"
  echo "PR already exists for ${BRANCH}; refreshed ${url}"
else
  url="$(gh pr create -R "$TARGET" \
    --base "$BASE_BRANCH" \
    --head "$BRANCH" \
    --title "$title" \
    --body "$body")"
  echo "Created ${url}"
fi
echo "url=${url}" >>"$GITHUB_OUTPUT"

# Squash auto-merge on the CLEAN path: the PR merges itself once the
# target's required checks (all-green) pass. Needs-review revisions stay
# disarmed (disarm_pr.sh ran before the push; a fresh PR is never armed).
if [ "$needs_review" = false ]; then
  if gh pr merge "$url" -R "$TARGET" --squash --auto 2>"$RUNNER_TEMP/automerge.err"; then
    echo "auto-merge armed for ${url}"
  else
    echo "::warning::${TARGET}: could not enable auto-merge on ${url}: $(cat "$RUNNER_TEMP/automerge.err"). Merge it manually; to fix this, allow auto-merge in the repo settings and keep a required check on the default branch."
  fi
else
  echo "auto-merge left off: this PR needs review (conflicts, withheld files, failed validation, or a recovery re-render)."
fi
