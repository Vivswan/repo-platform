#!/usr/bin/env bash
# Rewrites the target's recorded _src_path to the canonical template
# source before any copier command (the value is target-controlled and
# never trusted) and commits the rewrite so it rides the update branch
# into the sync PR. The recorded value can be a local filesystem path
# from wherever the repo was generated - target-derived, withheld for
# hide-details targets.
#
# Env: TARGET_DISPLAY, HIDE_DETAILS, GITHUB_REPOSITORY, GITHUB_OUTPUT,
# RUNNER_TEMP.
set -euo pipefail

canonical="gh:${GITHUB_REPOSITORY}"
if ! recorded="$(bun .github/scripts/sync/normalize_src_path.ts \
  --answers target/.copier-answers.yml --canonical "$canonical" \
  2>"$RUNNER_TEMP/normalize.err")"; then
  if [ "${HIDE_DETAILS:-false}" = "true" ]; then
    echo "::error::normalizing ${TARGET_DISPLAY}'s recorded template source failed (detail hidden: private repository). Reproduce the sync locally - see docs/private-repos.md."
  else
    cat "$RUNNER_TEMP/normalize.err" >&2
  fi
  exit 1
fi
if [ "$recorded" != "$canonical" ]; then
  # copier update refuses a dirty tree, so the rewrite is committed.
  git -C target -c user.name="repo-platform-sync" \
    -c user.email="repo-platform-sync@users.noreply.github.com" \
    commit -qam "chore: normalize the copier template source to ${canonical}"
  if [ "${HIDE_DETAILS:-false}" = "true" ]; then
    echo "::notice::${TARGET_DISPLAY}: _src_path was not the canonical template source (recorded value hidden: private repository); rewritten to '${canonical}' for this and future updates."
  else
    echo "::notice::${TARGET_DISPLAY}: _src_path was '${recorded}'; rewritten to '${canonical}' (the canonical template source) for this and future updates."
  fi
fi
echo "src_path=${canonical}" >>"$GITHUB_OUTPUT"
