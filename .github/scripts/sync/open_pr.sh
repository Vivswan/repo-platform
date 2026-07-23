#!/usr/bin/env bash
# Creates or refreshes the sync PR in the target and arms (or disarms)
# squash auto-merge. Invoked by reusable-template-sync.yml's "Create or
# refresh pull request" step.
#
# Env: TARGET, TARGET_REF, OLD_COMMIT, DISPLAY, BRANCH, BASE_BRANCH,
# VALIDATION, RESOLVED, SUMMARY_FILE, RETIRED_MODULES_FILE,
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

existing="$(gh pr list -R "$TARGET" --head "$BRANCH" --json number --jq '.[0].number // empty')"
if [ -n "$existing" ]; then
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
# target's required checks (all-green) pass. Anything that needs human
# review - dropped local hunks, withheld workflow files, failed
# validation - stays manual, and a previously armed auto-merge is
# DISARMED (the rolling branch may have been clean on an earlier run).
if [ "$RESOLVED" != "true" ] && [ "$VALIDATION" != "failed" ] &&
  [ ! -s "$WITHHELD_FILE" ]; then
  if gh pr merge "$url" -R "$TARGET" --squash --auto 2>"$RUNNER_TEMP/automerge.err"; then
    echo "auto-merge armed for ${url}"
  else
    echo "::warning::${TARGET}: could not enable auto-merge on ${url}: $(cat "$RUNNER_TEMP/automerge.err"). Merge it manually; to fix this, allow auto-merge in the repo settings and keep a required check on the default branch."
  fi
else
  gh pr merge "$url" -R "$TARGET" --disable-auto 2>/dev/null &&
    echo "auto-merge disarmed: this revision needs review" ||
    echo "auto-merge left off: this PR needs review (conflicts, withheld files, or failed validation)."
fi
