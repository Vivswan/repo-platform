#!/usr/bin/env bash
# Commits the copier output and pushes the rolling automation branch to
# the target, withholding .github/workflows changes when the token lacks
# the Workflows scope. Invoked by reusable-template-sync.yml's "Commit and
# push" step from the repo-platform checkout root.
#
# Env: TARGET, BRANCH, DISPLAY, BASE_BRANCH, PAT, RUNNER_TEMP,
# GITHUB_OUTPUT.
set -euo pipefail

git -C target config user.name "repo-platform-sync"
git -C target config user.email "repo-platform-sync@users.noreply.github.com"
git -C target add --all
# The tree can be clean when the only change is the committed _src_path
# normalization; there is still a branch to push.
if [ -n "$(git -C target status --porcelain)" ]; then
  git -C target commit -qm "chore: update repo-platform template to ${DISPLAY}"
fi

# The checkout kept no credentials (persist-credentials: false);
# authenticate this push alone. The lease is captured ONCE and reused on
# the retry: the branch is regenerated every run, so remote commits are
# overwritten by design, but any push racing this run - including one
# landing between the two attempts - fails the lease loudly instead of
# vanishing.
push_url="https://x-access-token:${PAT}@github.com/${TARGET}.git"
lease_sha="$(git -C target ls-remote "$push_url" "refs/heads/${BRANCH}" | cut -f1)"
do_push() {
  # An empty lease sha means "expect the ref to be absent", so a branch
  # created concurrently also fails the lease.
  git -C target push --force-with-lease="${BRANCH}:${lease_sha}" "$push_url" "$BRANCH"
}

revalidate() {
  if bun validator/actions/validate-template/validate_generated_files.ts target; then
    echo "validation=ok" >>"$GITHUB_OUTPUT"
  else
    echo "validation=failed" >>"$GITHUB_OUTPUT"
  fi
}

: >"$RUNNER_TEMP/withheld-workflows.txt"
if do_push 2>"$RUNNER_TEMP/push.err"; then
  cat "$RUNNER_TEMP/push.err"
  echo "pushed=true" >>"$GITHUB_OUTPUT"
  exit 0
fi
cat "$RUNNER_TEMP/push.err"

# Permission-adaptive fallback: a token without the Workflows scope cannot
# create or update .github/workflows files. Withhold those changes,
# deliver the rest, and say so in the PR - the scope is optional by
# design, not an error.
if ! grep -qi "create or update workflow" "$RUNNER_TEMP/push.err"; then
  echo "::error::pushing to ${TARGET}#${BRANCH} failed (see the log above). The REPO_PLATFORM_TOKEN needs Contents read/write on ${TARGET}; grant it and re-run."
  exit 1
fi
base_sha="$(git -C target rev-parse "origin/${BASE_BRANCH}")"
# --no-renames: a rename into .github/workflows must count as an addition
# here, or its destination file would survive the restore and the retry
# would be rejected again.
git -C target diff --name-only --no-renames "$base_sha" HEAD -- .github/workflows \
  >"$RUNNER_TEMP/withheld-workflows.txt"
# Restore the workflow dir to the base state: modified/deleted files come
# back via checkout, newly added ones are removed.
git -C target checkout "$base_sha" -- .github/workflows 2>/dev/null || true
git -C target diff --name-only --no-renames --diff-filter=A "$base_sha" HEAD -- .github/workflows |
  while IFS= read -r f; do rm -f "target/$f"; done
# Retired workflow files were restored too - drop them from the PR body's
# deleted list so it stays truthful.
if [ -s "$RUNNER_TEMP/removed-paths.txt" ]; then
  grep -v '^\.github/workflows/' "$RUNNER_TEMP/removed-paths.txt" \
    >"$RUNNER_TEMP/removed-paths.filtered" || true
  mv "$RUNNER_TEMP/removed-paths.filtered" "$RUNNER_TEMP/removed-paths.txt"
fi
git -C target add --all
if git -C target diff --quiet "$base_sha"; then
  echo "::warning::${TARGET}: this update only changes .github/workflows files, and the REPO_PLATFORM_TOKEN lacks the Workflows scope, so nothing can be delivered. Grant Workflows read/write to sync workflow files, or ignore this if that is intentional."
  echo "pushed=false" >>"$GITHUB_OUTPUT"
  # The full-tree validation verdict no longer applies to anything pushed;
  # re-validate the restored tree (== the default branch) so a real
  # default-branch problem still surfaces.
  revalidate
  exit 0
fi
git -C target commit --amend --no-edit
do_push
echo "pushed=true" >>"$GITHUB_OUTPUT"
# The earlier validation judged the full tree including the withheld
# files; re-validate what was actually pushed.
revalidate
echo "::warning::${TARGET}: workflow-file changes were withheld because the REPO_PLATFORM_TOKEN lacks the Workflows scope (listed in the PR body). Grant Workflows read/write to include them; this is otherwise working as configured."
