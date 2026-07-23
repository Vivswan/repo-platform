#!/usr/bin/env bash
# Resolves the sync's channel, template refs, and the two template
# copier.yml snapshots. Invoked by reusable-template-sync.yml's "Resolve
# channel, refs, and template copier configs" step from the repo-platform
# checkout root (the target repo is checked out under target/).
#
# Env: TARGET, CHANNEL_INPUT, REQUESTED, GH_TOKEN, GITHUB_REPOSITORY,
# GITHUB_OUTPUT, RUNNER_TEMP.
set -euo pipefail

# Build refs live only on origin; the default checkout is main-only.
git fetch --quiet origin "+refs/tags/templates/*:refs/tags/templates/*"
git fetch --quiet origin "+refs/heads/staging:refs/remotes/origin/staging" || true
git fetch --quiet origin "+refs/heads/latest:refs/remotes/origin/latest" || true

channel="$CHANNEL_INPUT"
if [ -z "$channel" ]; then
  channel="$(awk '$1 == "channel:" { print $2 }' target/.copier-answers.yml)"
fi
channel="${channel:-latest}"
case "$channel" in
  staging | latest) ;;
  *)
    echo "::error::unknown channel '${channel}' for ${TARGET}: it must be staging or latest. Fix the channel in repos.yml (or the repo's recorded copier answer)."
    exit 1
    ;;
esac

old_commit="$(awk '$1 == "_commit:" { print $2 }' target/.copier-answers.yml)"
# copier's to_nice_yaml quotes ambiguous scalars (a digit-only short sha
# renders as '1234567'); strip the quotes.
old_commit="${old_commit#\'}"
old_commit="${old_commit%\'}"
old_commit="${old_commit#\"}"
old_commit="${old_commit%\"}"

if [ "$channel" = "staging" ]; then
  if ! target_sha="$(git rev-parse --verify --quiet refs/remotes/origin/staging)"; then
    echo "::error::cannot resolve the staging target: ${GITHUB_REPOSITORY} has no staging branch, so there is nothing to sync from. Dispatch the Build Branches workflow, then re-run."
    exit 1
  fi
  target_ref="staging"
  # Staging validates with the SOURCE commit the staging build was
  # assembled from (stamped in its commit message), so validator rules
  # match the rendered tree even when main moved since. A main history
  # rewrite can orphan that commit; the builder re-stamps staging on its
  # next run, so refuse to guess here. GITHUB_SHA is not main on release
  # events, hence the explicit resolve for the no-stamp fallback.
  main_sha="$(git rev-parse refs/remotes/origin/main)"
  validate_ref="$(git log -1 --format=%B "$target_sha" | sed -n 's|^source: .*/commit/||p' | head -1)"
  if [ -n "$validate_ref" ] && ! git rev-parse --verify --quiet "${validate_ref}^{commit}" >/dev/null; then
    echo "::error::staging's stamped source commit ${validate_ref} is unreachable (main history rewrite). Dispatch the Build Branches workflow - it re-stamps staging - then re-run."
    exit 1
  fi
  validate_ref="${validate_ref:-$main_sha}"
  display="staging@${target_sha:0:12}"
else
  if [ -n "$REQUESTED" ]; then
    ver="${REQUESTED#templates/}"
    ver="v${ver#v}"
  elif ! ver="$(gh api "repos/${GITHUB_REPOSITORY}/releases/latest" --jq .tag_name)"; then
    echo "::error::cannot sync ${TARGET} on the latest channel: ${GITHUB_REPOSITORY} has no release yet. Cut a release (or pass a version input), then re-run."
    exit 1
  fi
  target_ref="templates/${ver}"
  if ! target_sha="$(git rev-parse --verify --quiet "refs/tags/${target_ref}")"; then
    echo "::error::cannot sync to ${target_ref}: the tag does not exist because the ${ver} build has not run yet (or failed). Dispatch the Build Branches workflow, then re-run."
    exit 1
  fi
  # The build tag holds no actions/; validation code lives on main
  # history at the release tag of the same version.
  validate_ref="$ver"
  display="$target_ref"
fi

if ! old_sha="$(git rev-parse --verify --quiet "${old_commit}^{commit}")"; then
  echo "::error::${TARGET}'s recorded _commit '${old_commit}' does not resolve on ${GITHUB_REPOSITORY}'s build branches, so there is no base to update from. If the build branches were rebuilt from scratch, regenerate the repo with copier copy."
  exit 1
fi
git show "${target_sha}:copier.yml" >"$RUNNER_TEMP/copier-new.yml"
git show "${old_sha}:copier.yml" >"$RUNNER_TEMP/copier-old.yml"

{
  echo "channel=${channel}"
  echo "old_commit=${old_commit}"
  echo "old_sha=${old_sha}"
  echo "target_ref=${target_ref}"
  echo "validate_ref=${validate_ref}"
  echo "branch=automation/repo-platform-${channel}"
  echo "display=${display}"
} >>"$GITHUB_OUTPUT"
echo "Updating ${TARGET} (${channel}) from ${old_commit} to ${display}"
