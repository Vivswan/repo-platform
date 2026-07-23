#!/usr/bin/env bash
# Decides which build branches to (re)build for this event. Invoked by
# build-branches.yml's "Plan builds" step.
#
# Env: EVENT_NAME, DISPATCH_CHANNEL, RELEASE_TAG, GH_TOKEN,
# GITHUB_REPOSITORY, GITHUB_OUTPUT.
set -euo pipefail

build_staging=false
build_latest=false
latest_ver=""
case "$EVENT_NAME" in
  push | schedule) build_staging=true ;;
  workflow_dispatch)
    case "${DISPATCH_CHANNEL:-both}" in
      both) build_staging=true ;;
      staging) build_staging=true ;;
    esac
    ;;
esac
if [ "$EVENT_NAME" = "release" ]; then
  build_latest=true
  latest_ver="$RELEASE_TAG"
elif [ "$EVENT_NAME" = "workflow_dispatch" ] && [ "${DISPATCH_CHANNEL:-both}" != "staging" ]; then
  # Manual dispatch rebuilds latest unconditionally (idempotent: unchanged
  # content appends nothing, existing tags are kept). gh api prints the
  # error body to stdout on 404; only keep output from a successful call.
  latest_ver="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>/dev/null)" || latest_ver=""
  if [ -n "$latest_ver" ]; then
    build_latest=true
  else
    echo "No release yet; latest branch not built."
  fi
elif [ "$EVENT_NAME" != "workflow_dispatch" ]; then
  # Self-heal: rebuild latest when its build tag or branch is missing.
  # gh api prints the error body to stdout on 404; only keep output from
  # a successful call.
  latest_ver="$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>/dev/null)" || latest_ver=""
  if [ -n "$latest_ver" ]; then
    if ! git ls-remote --exit-code origin "refs/tags/templates/${latest_ver}" >/dev/null 2>&1 ||
      ! git ls-remote --exit-code origin refs/heads/latest >/dev/null 2>&1; then
      build_latest=true
    fi
  else
    echo "No release yet; latest branch not built."
  fi
fi
{
  echo "staging=$build_staging"
  echo "latest=$build_latest"
  echo "version=$latest_ver"
} >>"$GITHUB_OUTPUT"
echo "plan: staging=$build_staging latest=$build_latest version=$latest_ver"
