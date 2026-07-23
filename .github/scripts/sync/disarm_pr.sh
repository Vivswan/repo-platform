#!/usr/bin/env bash
# Disarms auto-merge on the existing rolling PR BEFORE the branch is
# (re)pushed: the incoming revision may need review, and between a push
# and a later disarm an armed PR could merge it (or stay armed if the
# disarm call failed). open_pr.sh re-arms clean revisions after the
# push; a run that pushes nothing leaves the now-stale PR safely
# disarmed. Invoked by reusable-template-sync.yml's "Disarm auto-merge
# before the branch changes" step.
#
# Env: TARGET, BRANCH, GH_TOKEN.
set -euo pipefail

existing="$(gh pr list -R "$TARGET" --head "$BRANCH" --json number --jq '.[0].number // empty')"
if [ -z "$existing" ]; then
  exit 0
fi
# Query first so a real API failure fails the step instead of being
# mistaken for "already off"; only an actually armed PR gets disabled,
# and a failed disable fails the step before anything is pushed.
armed="$(gh pr view "$existing" -R "$TARGET" --json autoMergeRequest --jq '.autoMergeRequest != null')"
if [ "$armed" = "true" ]; then
  gh pr merge "$existing" -R "$TARGET" --disable-auto
  echo "auto-merge disarmed on PR #${existing} while the branch is regenerated"
else
  echo "PR #${existing} exists with auto-merge off; nothing to disarm"
fi
