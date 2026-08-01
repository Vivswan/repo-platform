#!/usr/bin/env bash
# Reads the target's live repo data for the sync: default branch and
# private flag to GITHUB_OUTPUT, description to a RUNNER_TEMP file (step
# outputs ride into later steps' env-group prints, and a hidden target's
# description must not). For hide-details targets the description and any
# non-default branch name are registered with the masker BEFORE either
# value is written anywhere.
#
# Env: TARGET, TARGET_DISPLAY, HIDE_DETAILS, GH_TOKEN, RUNNER_TEMP,
# GITHUB_OUTPUT.
set -euo pipefail

if ! info="$(gh api "repos/${TARGET}")"; then
  echo "::error::cannot read ${TARGET_DISPLAY}: the REPO_PLATFORM_TOKEN cannot access it. Grant the PAT access to ${TARGET_DISPLAY} (repository access list) with Contents and Pull requests read/write, then re-run."
  exit 1
fi
branch="$(jq -r .default_branch <<<"$info")"
jq -r '.description // ""' <<<"$info" >"$RUNNER_TEMP/description.txt"
if [ "${HIDE_DETAILS:-false}" = "true" ]; then
  # Workflow-command data must be single-line with %/CR/LF escaped, or
  # the runner misparses the command and the raw value hits the log.
  # GitHub descriptions cannot hold real newlines, but this must not
  # depend on that staying true.
  escape_data() {
    local v="$1"
    v="${v//'%'/%25}"
    v="${v//$'\r'/%0D}"
    v="${v//$'\n'/%0A}"
    printf '%s' "$v"
  }
  desc="$(cat "$RUNNER_TEMP/description.txt")"
  if [ "${#desc}" -ge 4 ]; then
    echo "::add-mask::$(escape_data "$desc")"
  fi
  # An unusual branch name is target-derived, whatever its length; only
  # main/master stay unmasked (masking those would garble every log line
  # containing them, and they disclose nothing).
  case "$branch" in
    main | master) ;;
    *) echo "::add-mask::$(escape_data "$branch")" ;;
  esac
fi
{
  echo "default_branch=${branch}"
  echo "private=$(jq -r .private <<<"$info")"
} >>"$GITHUB_OUTPUT"
