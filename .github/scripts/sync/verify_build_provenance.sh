#!/usr/bin/env bash
# Proves a build ref is the build-branches workflow's own output before the
# sync templates it into managed repos. Invoked by sync/resolve_refs.sh
# after it parses the ref's source stamp, for both channels:
#
#   CHANNEL=staging - the staging branch tip. The staging ruleset only
#   blocks deletion and force-pushes, so anyone with push access can
#   fast-forward the branch.
#   CHANNEL=latest - the commit a templates/vX.Y.Z tag points at. The
#   build-tags ruleset freezes existing tags, but tag CREATION is open to
#   any writer, so the tag itself may be a pre-created impostor (publish.sh
#   refuses to be silently pre-empted, but a tag planted before a build
#   that never ran still resolves here).
#
# The stamp lines in the commit message (see shared/commit_stamp.sh) are
# plain text anyone can write. Checks, all hard failures:
#
#   1. The stamped source must be main history: publish.sh only ever stamps
#      builds with main-history shas (origin/main for staging, the release
#      tag's commit for latest), so anything else was not the builder.
#   2. Channel anchor.
#      staging - no rollback: no source stamped anywhere in the tip's
#      ancestry may be strictly newer than the tip's own stamped source.
#      The builder's sources only move forward and the branch is
#      append-only, so a replayed OLD build (old source plus its old
#      successful run) fails here even though it would pass every other
#      check.
#      latest - the stamped source must BE the vX.Y.Z release tag's commit
#      (publish.sh stamps a version build with exactly that sha, and the
#      release tag is itself frozen by the build-tags ruleset), and the
#      source must sit at the templates-tag frontier: no other templates
#      tag may stamp a strictly newer on-main source. Together these pin
#      the tag to its own version's source and reject a rebuild of an old
#      source minted under an unused version number - the tag-namespace
#      form of staging's rollback rule. Downgrades therefore never
#      re-ship an old tag; they go forward as a revert plus new release.
#   3. Run proof (defense in depth): the ref's "run:" line must name a
#      completed, successful build-branches.yml run of this repository whose
#      head sha is the stamped source.
#   4. Tree proof: rebuild the channel tree from the stamped source with
#      that commit's own build script, exactly as publish.sh does (latest
#      passes --version, which lands in BUILD_INFO.yml), and require the
#      rebuilt git tree hash to equal the ref's tree hash. branch_tree.ts
#      output is fully deterministic (no timestamps or source shas
#      in-tree), so a mismatch means the ref carries content the builder
#      never produced from that source.
#
# Env: CHANNEL (staging|latest), TIP_SHA (the fetched tip / tagged commit),
# SOURCE_SHA (its parsed source stamp), VERSION (latest only, vX.Y.Z),
# GH_TOKEN, GITHUB_REPOSITORY, RUNNER_TEMP.
set -euo pipefail

# shellcheck source=.github/scripts/shared/commit_stamp.sh
. "$(dirname "$0")/../shared/commit_stamp.sh"

fail() {
  echo "::error::$1"
  exit 1
}

case "$CHANNEL" in
  staging)
    subject="staging tip ${TIP_SHA:0:12}"
    unit="tip"
    carrier="branch"
    rebuild_hint="If staging was pushed by something other than the Build Branches workflow, reset it: dispatch Build Branches to rebuild staging from main, then re-run the sync."
    ;;
  latest)
    if [ -z "${VERSION:-}" ]; then
      fail "verify_build_provenance.sh: CHANNEL=latest needs VERSION (the vX.Y.Z release version)."
    fi
    subject="tag templates/${VERSION} (commit ${TIP_SHA:0:12})"
    unit="tag"
    carrier="tag"
    rebuild_hint="If templates/${VERSION} was created by something other than the Build Branches workflow, have an admin delete it (the build-tags ruleset blocks tag deletion for everyone, so temporarily disable it under Settings > Rules > Rulesets), dispatch Build Branches for ${VERSION}, then re-run the sync."
    ;;
  *)
    fail "verify_build_provenance.sh: unknown CHANNEL '${CHANNEL}' (must be staging or latest)."
    ;;
esac

if ! git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main; then
  fail "${subject} is stamped with source ${SOURCE_SHA:0:12}, which is not on main's history. The builder only stamps ${CHANNEL} with main commits, so this ${unit} is not its output. ${rebuild_hint}"
fi

if [ "$CHANNEL" = "staging" ]; then
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
      fail "${subject} is stamped with source ${SOURCE_SHA:0:12}, but its history already stamped the newer source ${ancestor_src:0:12} - the tip replays an older build. ${rebuild_hint}"
    fi
  done < <(git log --format=%B "$TIP_SHA" | commit_stamp_parse_all)
else
  # Header check 2 (latest anchor): the stamp must equal the frozen
  # vX.Y.Z release tag's commit, so no other build can replay under
  # this tag name.
  if ! release_sha="$(git rev-parse --verify --quiet "refs/tags/${VERSION}^{commit}")"; then
    fail "${subject} cannot be verified: release tag ${VERSION} does not resolve, so there is no release commit to check the stamp against. ${rebuild_hint}"
  fi
  if [ "$SOURCE_SHA" != "$release_sha" ]; then
    fail "${subject} is stamped with source ${SOURCE_SHA:0:12}, but release ${VERSION} tagged ${release_sha:0:12} - the builder only stamps templates/${VERSION} with that release's commit, so this tag is not its output. ${rebuild_hint}"
  fi
  # Header check 2 (frontier - staging's rollback rule in tag form):
  # anchoring alone is not enough - a writer can mint BOTH tags for an
  # unused version from an OLD main commit and pass every other proof,
  # shipping a fleet-wide downgrade. Genuine releases always move the
  # frontier forward, and a planted tag can only stamp a source that
  # already exists, so neither rejects the other. Unparseable,
  # unresolvable, or off-main stamps are skipped so junk tags cannot
  # brick verification.
  while IFS= read -r other_tag; do
    [ "$other_tag" != "templates/${VERSION}" ] || continue
    other_tip="$(git rev-list -n1 "refs/tags/${other_tag}" 2>/dev/null)" || continue
    other_src="$(git log -1 --format=%B "$other_tip" | commit_stamp_parse)"
    other_src="$(git rev-parse --verify --quiet "${other_src}^{commit}")" || continue
    git merge-base --is-ancestor "$other_src" refs/remotes/origin/main || continue
    if [ "$other_src" != "$SOURCE_SHA" ] && git merge-base --is-ancestor "$SOURCE_SHA" "$other_src"; then
      fail "${subject} is stamped with source ${SOURCE_SHA:0:12}, but ${other_tag} already stamped the strictly newer source ${other_src:0:12} - shipping it would roll the fleet back behind a build it was already offered. To downgrade on purpose, revert the template change on main and cut a NEW release; if ${other_tag} is itself an impostor, have an admin delete it (temporarily disable the build-tags ruleset - it blocks tag deletion), then re-run the sync."
    fi
  done < <(git for-each-ref "refs/tags/templates/*" --format='%(refname:lstrip=2)')
fi

run_id="$(git log -1 --format=%B "$TIP_SHA" | commit_run_parse)"
case "$run_id" in
  '' | *[!0-9]*)
    fail "${subject} carries no parseable 'run:' line, so the build run that produced it cannot be verified. ${rebuild_hint}"
    ;;
esac
if ! run_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}")"; then
  fail "${subject} points at run ${run_id}, which cannot be read from ${GITHUB_REPOSITORY} - it does not exist there, so the stamp is not the builder's. ${rebuild_hint}"
fi
run_path="$(jq -r .path <<<"$run_json")"
run_status="$(jq -r .status <<<"$run_json")"
run_conclusion="$(jq -r .conclusion <<<"$run_json")"
run_head="$(jq -r .head_sha <<<"$run_json")"
if [ "$run_path" != ".github/workflows/build-branches.yml" ]; then
  fail "${subject} points at run ${run_id}, which is '${run_path}', not build-branches.yml - the stamp is not the builder's. ${rebuild_hint}"
fi
if [ "$run_status" != "completed" ]; then
  fail "${subject} was stamped by build run ${run_id}, which is still '${run_status}'. Wait for it to finish, then re-run the sync."
fi
if [ "$run_conclusion" != "success" ]; then
  fail "${subject} was stamped by build run ${run_id}, which concluded '${run_conclusion}'. Re-run that build to green (gh run rerun ${run_id} -R ${GITHUB_REPOSITORY}) or dispatch Build Branches, then re-run the sync."
fi
if [ "$run_head" != "$SOURCE_SHA" ]; then
  fail "${subject} is stamped with source ${SOURCE_SHA:0:12}, but build run ${run_id} ran at ${run_head:0:12} - the stamp does not match the run. ${rebuild_hint}"
fi

# Rebuild exactly as publish.sh does: the SOURCE commit's own script and
# dependencies, so the check reproduces that commit's composition.
work_dir="$(mktemp -d "${RUNNER_TEMP}/${CHANNEL}-provenance.XXXXXX")"
src_dir="$work_dir/src"
tree_dir="$work_dir/tree"
trap 'git worktree remove --force "$src_dir" 2>/dev/null || true; rm -rf "$work_dir"' EXIT
git worktree add --detach --quiet "$src_dir" "$SOURCE_SHA"
bun install --frozen-lockfile --cwd "$src_dir" --silent
if [ "$CHANNEL" = "latest" ]; then
  bun "$src_dir/.github/scripts/build-branches/branch_tree.ts" \
    --dest "$tree_dir" --channel latest --version "$VERSION"
else
  bun "$src_dir/.github/scripts/build-branches/branch_tree.ts" \
    --dest "$tree_dir" --channel staging
fi
# Hash the rebuilt tree the way publish.sh's commit did: a scratch git
# repo's index, so file modes and symlinks land in the comparison too.
git -C "$tree_dir" init --quiet
git -C "$tree_dir" add -A
built_tree="$(git -C "$tree_dir" write-tree)"
tip_tree="$(git rev-parse "${TIP_SHA}^{tree}")"
if [ "$built_tree" != "$tip_tree" ]; then
  fail "${subject} does not match its stamp: rebuilding the tree from stamped source ${SOURCE_SHA:0:12} gives tree ${built_tree}, but the ${unit}'s tree is ${tip_tree}. The ${carrier} carries content the builder never produced. ${rebuild_hint}"
fi
echo "${subject} verified: tree ${tip_tree} rebuilds from ${SOURCE_SHA:0:12}, stamped by successful build run ${run_id}."
