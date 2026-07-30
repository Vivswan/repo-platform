#!/usr/bin/env bash
# Proves the staging tip is the build-branches workflow's own output before
# the sync templates it into every staging-channel repo. Invoked by
# sync/resolve_refs.sh after it parses the tip's source stamp. The staging
# ruleset only blocks deletion and force-pushes, so anyone with push access
# can fast-forward the branch, and the stamp lines in the commit message
# (see shared/commit_stamp.sh) are plain text anyone can write. Four
# checks, all hard failures:
#
#   1. The stamped source must be main history: publish.sh only ever stamps
#      staging with origin/main's sha, so anything else was not the builder.
#   2. No rollback: no source stamped anywhere in the tip's ancestry may be
#      strictly newer than the tip's own stamped source. The builder's
#      sources only move forward and the branch is append-only, so a
#      replayed OLD build (old source plus its old successful run) fails
#      here even though it would pass every other check.
#   3. Run proof (defense in depth): the tip's "run:" line must name a
#      completed, successful build-branches.yml run of this repository whose
#      head sha is the stamped source.
#   4. Tree proof: rebuild the branch tree from the stamped source with that
#      commit's own build script, exactly as publish.sh does, and require
#      the rebuilt git tree hash to equal the tip's tree hash. branch_tree.ts
#      output is fully deterministic (no timestamps or source shas in-tree),
#      so a mismatch means the tip carries content the builder never
#      produced from that source.
#
# Env: STAGING_SHA (the fetched staging tip), SOURCE_SHA (its parsed source
# stamp), GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.
set -euo pipefail

# shellcheck source=.github/scripts/shared/commit_stamp.sh
. "$(dirname "$0")/../shared/commit_stamp.sh"

fail() {
  echo "::error::$1"
  exit 1
}
rebuild_hint="If staging was pushed by something other than the Build Branches workflow, reset it: dispatch Build Branches to rebuild staging from main, then re-run the sync."

if ! git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main; then
  fail "staging tip ${STAGING_SHA:0:12} is stamped with source ${SOURCE_SHA:0:12}, which is not on main's history. The builder only stamps staging with main commits, so this tip is not its output. ${rebuild_hint}"
fi

# The walk covers every ancestor through all parents (a merge tip cannot
# hide the previous tip from it) plus the tip itself, whose own stamp
# compares equal and passes. Only stamps that resolve AND sit on main's
# history order the comparison: an attacker who plants a stamp naming an
# off-main DESCENDANT of main's tip must not poison the branch against
# every legitimate build that follows, and stamps orphaned or de-mained
# by a main history rewrite must not block the builder's re-stamp (the
# rewrite-window replay this opens lasts only until the rewrite's own
# push triggers the next build, which re-stamps the tip on the new
# lineage).
while IFS= read -r ancestor_src; do
  ancestor_src="$(git rev-parse --verify --quiet "${ancestor_src}^{commit}")" || continue
  git merge-base --is-ancestor "$ancestor_src" refs/remotes/origin/main || continue
  if [ "$ancestor_src" != "$SOURCE_SHA" ] && git merge-base --is-ancestor "$SOURCE_SHA" "$ancestor_src"; then
    fail "staging tip ${STAGING_SHA:0:12} is stamped with source ${SOURCE_SHA:0:12}, but its history already stamped the newer source ${ancestor_src:0:12} - the tip replays an older build. ${rebuild_hint}"
  fi
done < <(git log --format=%B "$STAGING_SHA" | commit_stamp_parse_all)

run_id="$(git log -1 --format=%B "$STAGING_SHA" | commit_run_parse)"
case "$run_id" in
  '' | *[!0-9]*)
    fail "staging tip ${STAGING_SHA:0:12} carries no parseable 'run:' line, so the build run that produced it cannot be verified. ${rebuild_hint}"
    ;;
esac
if ! run_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}")"; then
  fail "staging tip ${STAGING_SHA:0:12} points at run ${run_id}, which cannot be read from ${GITHUB_REPOSITORY} - it does not exist there, so the stamp is not the builder's. ${rebuild_hint}"
fi
run_path="$(jq -r .path <<<"$run_json")"
run_status="$(jq -r .status <<<"$run_json")"
run_conclusion="$(jq -r .conclusion <<<"$run_json")"
run_head="$(jq -r .head_sha <<<"$run_json")"
if [ "$run_path" != ".github/workflows/build-branches.yml" ]; then
  fail "staging tip ${STAGING_SHA:0:12} points at run ${run_id}, which is '${run_path}', not build-branches.yml - the stamp is not the builder's. ${rebuild_hint}"
fi
if [ "$run_status" != "completed" ]; then
  fail "staging tip ${STAGING_SHA:0:12} was stamped by build run ${run_id}, which is still '${run_status}'. Wait for it to finish, then re-run the sync."
fi
if [ "$run_conclusion" != "success" ]; then
  fail "staging tip ${STAGING_SHA:0:12} was stamped by build run ${run_id}, which concluded '${run_conclusion}'. Re-run that build to green (gh run rerun ${run_id} -R ${GITHUB_REPOSITORY}) or dispatch Build Branches, then re-run the sync."
fi
if [ "$run_head" != "$SOURCE_SHA" ]; then
  fail "staging tip ${STAGING_SHA:0:12} is stamped with source ${SOURCE_SHA:0:12}, but build run ${run_id} ran at ${run_head:0:12} - the stamp does not match the run. ${rebuild_hint}"
fi

# Rebuild exactly as publish.sh does: the SOURCE commit's own script and
# dependencies, so the check reproduces that commit's composition.
work_dir="$(mktemp -d "${RUNNER_TEMP}/staging-provenance.XXXXXX")"
src_dir="$work_dir/src"
tree_dir="$work_dir/tree"
trap 'git worktree remove --force "$src_dir" 2>/dev/null || true; rm -rf "$work_dir"' EXIT
git worktree add --detach --quiet "$src_dir" "$SOURCE_SHA"
bun install --frozen-lockfile --cwd "$src_dir" --silent
bun "$src_dir/.github/scripts/build-branches/branch_tree.ts" \
  --dest "$tree_dir" --channel staging
# Hash the rebuilt tree the way publish.sh's commit did: a scratch git
# repo's index, so file modes and symlinks land in the comparison too.
git -C "$tree_dir" init --quiet
git -C "$tree_dir" add -A
built_tree="$(git -C "$tree_dir" write-tree)"
tip_tree="$(git rev-parse "${STAGING_SHA}^{tree}")"
if [ "$built_tree" != "$tip_tree" ]; then
  fail "staging tip ${STAGING_SHA:0:12} does not match its stamp: rebuilding the tree from stamped source ${SOURCE_SHA:0:12} gives tree ${built_tree}, but the tip's tree is ${tip_tree}. The branch carries content the builder never produced. ${rebuild_hint}"
fi
echo "staging tip ${STAGING_SHA:0:12} verified: tree ${tip_tree} rebuilds from ${SOURCE_SHA:0:12}, stamped by successful build run ${run_id}."
