#!/usr/bin/env bash
# Creates or refreshes the sync PR in the target and arms squash
# auto-merge on clean revisions (needs-review ones stay disarmed by the
# earlier disarm_pr.sh step). Invoked by reusable-template-sync.yml's
# "Create or refresh pull request" step.
#
# Env: TARGET, TARGET_DISPLAY (log label; falls back to TARGET),
# HIDE_DETAILS, CHANNEL, DISPLAY, BRANCH, BASE_BRANCH,
# VALIDATION, RESOLVED, RECOVER, DRIFT_FILE, SUMMARY_FILE,
# RETIRED_MODULES_FILE, REMOVED_PATHS_FILE, WITHHELD_FILE, GH_TOKEN,
# GITHUB_REPOSITORY, GITHUB_OUTPUT, RUNNER_TEMP.
set -euo pipefail

# From resolve_refs.sh via file (not a step output: the value is
# target-controlled and step outputs surface in env-group prints). This
# body ships to the private repo, so the raw value is fine HERE.
OLD_COMMIT="$(cat "$RUNNER_TEMP/old_commit.txt")"

# TARGET_REF is the verified commit on both channels (pinned by
# resolve_refs.sh), so the channel and DISPLAY (staging@<sha> or
# templates/vX.Y.Z) drive the source line.
if [ "$CHANNEL" = "staging" ]; then
  source_line="[\`${GITHUB_REPOSITORY}\`](https://github.com/${GITHUB_REPOSITORY}/tree/staging) (staging channel)"
else
  ver="${DISPLAY#templates/}"
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

# Out-of-band settings drift goes on TOP of the body: merging ratifies
# live values no human declared, so the reader must see that before
# anything else.
if [ -s "$DRIFT_FILE" ]; then
  body="$(cat "$DRIFT_FILE")

${body}"
fi

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
  validation_where="details in the sync run log"
  validation_extra=""
  if [ "${HIDE_DETAILS:-false}" = "true" ]; then
    # run_hidden.sh withheld the diagnostics from the public log; this
    # body ships to the private repo, so they belong here instead. The
    # post-withhold re-validation supersedes the full-tree run. The
    # filenames derive from the run_hidden labels - a check_ssot rule
    # pins the two sides. The promise of diagnostics below is only made
    # once a non-empty capture is actually in hand.
    validation_where="the public sync log hides the diagnostics (private repository); reproduce validation locally per docs/private-repos.md"
    for f in "$RUNNER_TEMP/hidden-post-withhold-re-validation.log" \
      "$RUNNER_TEMP/hidden-template-validation.log"; do
      if [ -s "$f" ]; then
        validation_where="the public sync log hides the diagnostics (private repository); they are below"
        # GitHub caps PR bodies at 64 KiB and gh fails outright past it,
        # which would strand the pushed branch with no PR - keep the
        # excerpt bounded like the conflicts summary.
        note=""
        if [ "$(wc -c <"$f")" -gt 20000 ]; then
          note="
(truncated; reproduce validation locally for the rest - docs/private-repos.md)"
        fi
        validation_extra="

\`\`\`\`text
$(head -c 20000 "$f")${note}
\`\`\`\`"
        break
      fi
    done
  fi
  body="${body}

> [!WARNING]
> Validation failed on the updated tree (${validation_where}). Fix it
> in this PR before merging.${validation_extra}"
fi

# Anything that needs human review - dropped local hunks, withheld
# workflow files, failed validation, a recovery re-render, out-of-band
# settings drift - stays manual; a clean update arms squash auto-merge
# below.
needs_review=false
if [ "$RESOLVED" = "true" ] || [ "$VALIDATION" = "failed" ] ||
  [ "$RECOVER" = "recopy" ] || [ -s "$WITHHELD_FILE" ] ||
  [ -s "$DRIFT_FILE" ]; then
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
    # gh's error text can name the target's rulesets and required checks.
    detail="$(cat "$RUNNER_TEMP/automerge.err")"
    if [ "${HIDE_DETAILS:-false}" = "true" ]; then
      detail="detail hidden: private repository"
    fi
    echo "::warning::${TARGET_DISPLAY:-$TARGET}: could not enable auto-merge on ${url}: ${detail}. Merge it manually; to fix this, allow auto-merge in the repo settings and keep a required check on the default branch."
  fi
else
  echo "auto-merge left off: this PR needs review (conflicts, withheld files, failed validation, out-of-band settings drift, or a recovery re-render)."
fi
