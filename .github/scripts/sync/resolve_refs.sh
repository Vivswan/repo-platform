#!/usr/bin/env bash
# Resolves the sync's channel, template refs, and the two template
# copier.yml snapshots. Invoked by reusable-template-sync.yml's "Resolve
# channel, refs, and template copier configs" step from the repo-platform
# checkout root (the target repo is checked out under target/).
#
# Env: TARGET, CHANNEL_INPUT, REQUESTED, RECOVER, GH_TOKEN,
# GITHUB_REPOSITORY, GITHUB_OUTPUT, RUNNER_TEMP.
set -euo pipefail

# shellcheck source=.github/scripts/shared/commit_stamp.sh
. "$(dirname "$0")/../shared/commit_stamp.sh"
# shellcheck source=.github/scripts/sync/resolve_channel.sh
. "$(dirname "$0")/resolve_channel.sh"

case "$RECOVER" in
  "" | recopy) ;;
  *)
    echo "::error::unknown recover mode '${RECOVER}': the only supported value is 'recopy' (full re-render through a manual-review PR)."
    exit 1
    ;;
esac

# Build refs live only on origin; the default checkout is main-only.
# main is refreshed too: a build published after the checkout can stamp a
# main commit the checkout has not seen yet.
git fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main"
git fetch --quiet origin "+refs/tags/templates/*:refs/tags/templates/*"
git fetch --quiet origin "+refs/heads/staging:refs/remotes/origin/staging" || true
git fetch --quiet origin "+refs/heads/latest:refs/remotes/origin/latest" || true

channel="$(resolve_channel "$CHANNEL_INPUT" target/.copier-answers.yml)"
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
  # Staging validates with the SOURCE commit the staging build was
  # assembled from (stamped in its commit message), so validator rules
  # match the rendered tree even when main moved since. The stamp is
  # required: only the builder writes it, and an unstamped tip is a
  # hand-pushed one. A main history rewrite can orphan the stamped
  # commit; the builder re-stamps staging on its next run, so refuse to
  # guess here.
  validate_ref="$(git log -1 --format=%B "$target_sha" | commit_stamp_parse)"
  if [ -z "$validate_ref" ]; then
    echo "::error::staging's tip ${target_sha:0:12} carries no source stamp, so the Build Branches workflow did not push it and the sync will not ship it. Dispatch Build Branches to rebuild staging from main, then re-run."
    exit 1
  fi
  if ! git rev-parse --verify --quiet "${validate_ref}^{commit}" >/dev/null; then
    echo "::error::staging's stamped source commit ${validate_ref} is unreachable (main history rewrite). Dispatch the Build Branches workflow - it re-stamps staging - then re-run."
    exit 1
  fi
  # The stamp lines are plain text anyone with push access can write, and
  # the staging ruleset allows fast-forward pushes from any writer - so
  # prove the tip is really the builder's output of that source before it
  # is templated fleet-wide.
  STAGING_SHA="$target_sha" SOURCE_SHA="$validate_ref" \
    bash "$(dirname "$0")/verify_staging_provenance.sh"
  # copier consumes target_ref, and the branch name would be re-resolved
  # from origin AFTER this verification - a push in that window would ship
  # unverified content. Pin copier to the verified commit itself.
  target_ref="$target_sha"
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

# Recovery exists precisely because the recorded base may be unusable:
# resolve it best-effort there, and hard-error everywhere else - the
# update has no base without it.
if ! old_sha="$(git rev-parse --verify --quiet "${old_commit}^{commit}")"; then
  if [ "$RECOVER" = "recopy" ]; then
    old_sha=""
  else
    echo "::error::${TARGET}'s recorded _commit '${old_commit}' does not resolve on ${GITHUB_REPOSITORY}'s build branches, so there is no base to update from. Fix the _commit in its .copier-answers.yml, or dispatch Sync Repos with repo=${TARGET} and recover=recopy to regenerate the repo through a manual-review PR."
    exit 1
  fi
fi
git show "${target_sha}:copier.yml" >"$RUNNER_TEMP/copier-new.yml"
if [ -n "$old_sha" ]; then
  git show "${old_sha}:copier.yml" >"$RUNNER_TEMP/copier-old.yml"
fi

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
