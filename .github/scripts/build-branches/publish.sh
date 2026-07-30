#!/usr/bin/env bash
# Composes and publishes the planned build branches (append-only orphan
# branches; see build-branches.yml's header for the branch model).
# Invoked by build-branches.yml's "Build and publish" step.
#
# Env: BUILD_STAGING, BUILD_LATEST, VERSION, RUN_URL, GH_TOKEN,
# GITHUB_SERVER_URL, GITHUB_REPOSITORY.
set -euo pipefail

# shellcheck source=.github/scripts/shared/commit_stamp.sh
. "$(dirname "$0")/../shared/commit_stamp.sh"

git config user.name "repo-platform-build"
git config user.email "repo-platform-build@users.noreply.github.com"

# Prints a re-stamp reason when the branch tip's stamp would fail the
# sync's provenance checks, and nothing when the stamp is still good. The
# append-only branches only gain a commit on content change, so a fresh
# empty stamp commit from here is the ONLY way to heal a tip whose stamp
# is broken - without this, "dispatch Build Branches" could never clear a
# rejected tip. Staging gets the full battery its sync verification
# (sync/verify_staging_provenance.sh) enforces, including one rebuild of
# the stamped source when it lags the current one; latest is consumed via
# immutable templates/vX.Y.Z tags and only heals unparseable stamps.
restamp_reason() { # channel current-source-sha
  tip_msg="$(git -C "/tmp/pub-$1" log -1 --format=%B)"
  prev_src="$(commit_stamp_parse <<<"$tip_msg")"
  if [ -z "$prev_src" ]; then
    echo "re-stamp: tip carries no source stamp"
    return
  fi
  # A main history rewrite can orphan the stamp's source while leaving
  # the tree identical; downstream validation resolves that stamp.
  if ! git rev-parse --verify --quiet "${prev_src}^{commit}" >/dev/null; then
    echo "re-stamp: previous source ${prev_src:0:12} unreachable"
    return
  fi
  [ "$1" = "staging" ] || return 0
  if ! git merge-base --is-ancestor "$prev_src" origin/main; then
    echo "re-stamp: previous source ${prev_src:0:12} not on main history"
    return
  fi
  # A tip whose stamps are old-but-valid replays an older build; the
  # sync's rollback check rejects it, and only a fresh stamp from here
  # can heal the append-only branch. Same walk and same on-main filter
  # as the sync's: no on-main stamp anywhere in the tip's ancestry may
  # be newer than the tip's own.
  while IFS= read -r ancestor_src; do
    ancestor_src="$(git rev-parse --verify --quiet "${ancestor_src}^{commit}")" || continue
    git merge-base --is-ancestor "$ancestor_src" origin/main || continue
    if [ "$ancestor_src" != "$prev_src" ] && git merge-base --is-ancestor "$prev_src" "$ancestor_src"; then
      echo "re-stamp: tip source ${prev_src:0:12} is older than stamped ancestor ${ancestor_src:0:12}"
      return
    fi
  done < <(git -C "/tmp/pub-$1" log --format=%B HEAD | commit_stamp_parse_all)
  prev_run="$(commit_run_parse <<<"$tip_msg")"
  case "$prev_run" in
    '' | *[!0-9]*)
      echo "re-stamp: tip carries no parseable run line"
      return
      ;;
  esac
  if ! run_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${prev_run}")"; then
    echo "re-stamp: stamped run ${prev_run} is unreadable"
    return
  fi
  if [ "$(jq -r .path <<<"$run_json")" != ".github/workflows/build-branches.yml" ] ||
    [ "$(jq -r .conclusion <<<"$run_json")" != "success" ] ||
    [ "$(jq -r .head_sha <<<"$run_json")" != "$prev_src" ]; then
    echo "re-stamp: stamped run ${prev_run} does not vouch for source ${prev_src:0:12}"
    return
  fi
  # The stamps can be individually valid while the TREE is a different
  # source's build (a hand-push of the current build's exact tree over
  # the previous stamps): the sync's tree proof rejects that pair, so
  # prove the stamped source still rebuilds this tree and re-stamp when
  # it does not - or can no longer be rebuilt at all. Build noise goes
  # to stderr; stdout is the reason channel.
  if [ "$prev_src" != "$2" ]; then
    stamped_build_ok=true
    rm -rf "/tmp/prev-tree-$1"
    git worktree remove --force "/tmp/prev-src-$1" >/dev/null 2>&1 || true
    {
      git worktree add --detach "/tmp/prev-src-$1" "$prev_src" &&
        bun install --frozen-lockfile --cwd "/tmp/prev-src-$1" &&
        bun "/tmp/prev-src-$1/.github/scripts/build-branches/branch_tree.ts" \
          --dest "/tmp/prev-tree-$1" --channel "$1" &&
        diff -r -q --no-dereference --exclude=.git "/tmp/prev-tree-$1" "/tmp/pub-$1"
    } >&2 || stamped_build_ok=false
    git worktree remove --force "/tmp/prev-src-$1" >/dev/null 2>&1 || true
    rm -rf "/tmp/prev-tree-$1"
    if ! $stamped_build_ok; then
      echo "re-stamp: the tip tree is not the stamped ${prev_src:0:12} build"
      return
    fi
  fi
}

publish() { # channel source_sha [version]
  ch="$1"
  src="$2"
  ver="${3:-}"
  echo "::group::build $ch from ${src:0:12} ${ver:+($ver)}"
  rm -rf "/tmp/src-$ch" "/tmp/tree-$ch" "/tmp/pub-$ch"
  # Compose with the SOURCE ref's own script + sources, so a rebuild of an
  # old tag reproduces that tag's composition. The script's dependencies
  # must resolve from that tree, not this checkout.
  git worktree add --detach "/tmp/src-$ch" "$src"
  bun install --frozen-lockfile --cwd "/tmp/src-$ch"
  if [ -n "$ver" ]; then
    bun "/tmp/src-$ch/.github/scripts/build-branches/branch_tree.ts" \
      --dest "/tmp/tree-$ch" --channel "$ch" --version "$ver"
  else
    bun "/tmp/src-$ch/.github/scripts/build-branches/branch_tree.ts" \
      --dest "/tmp/tree-$ch" --channel "$ch"
  fi
  if git ls-remote --exit-code origin "refs/heads/$ch" >/dev/null 2>&1; then
    git fetch --quiet origin "$ch"
    git worktree add --detach "/tmp/pub-$ch" "origin/$ch"
  else
    git worktree add --detach "/tmp/pub-$ch" "$src"
    git -C "/tmp/pub-$ch" switch --orphan "build-$ch"
  fi
  # --checksum: the quick size+mtime check can miss a changed file when
  # both trees were written in the same second and the content is
  # same-size (BUILD_INFO.yml's version line across releases) - and every
  # decision below trusts this tree, including what gets tagged.
  rsync -a --delete --checksum --exclude=.git "/tmp/tree-$ch/" "/tmp/pub-$ch/"
  git -C "/tmp/pub-$ch" add -A
  if ! git -C "/tmp/pub-$ch" diff --cached --quiet; then
    note="content change"
  else
    note="$(restamp_reason "$ch" "$src")"
  fi
  if [ -n "$note" ]; then
    git -C "/tmp/pub-$ch" commit -q --allow-empty \
      -m "build($ch): ${ver:-main} from ${src:0:12}" \
      -m "$(commit_stamp_write "$GITHUB_SERVER_URL" "$GITHUB_REPOSITORY" "$src")" \
      -m "$(commit_run_write "$RUN_URL")"
    # Plain push, never force: the branches are append-only.
    git -C "/tmp/pub-$ch" push origin "HEAD:refs/heads/$ch"
    echo "$ch: pushed $(git -C "/tmp/pub-$ch" rev-parse --short HEAD) (${note})"
  else
    echo "$ch: no content change"
  fi
  # The build-tags ruleset freezes templates/* tags once they exist
  # (update/delete/non-fast-forward are blocked for everyone), but tag
  # CREATION is open to any writer. A tag that already exists here is
  # therefore either this build re-run (fine, skip) or a pre-created
  # impostor that the ruleset would freeze forever - so prove which by
  # tree hash before skipping, and never skip silently.
  if [ -n "$ver" ]; then
    if git ls-remote --exit-code origin "refs/tags/templates/$ver" >/dev/null 2>&1; then
      git fetch --quiet origin "+refs/tags/templates/$ver:refs/tags/templates/$ver"
      tag_tree="$(git rev-parse "refs/tags/templates/${ver}^{tree}")"
      built_tree="$(git -C "/tmp/pub-$ch" write-tree)"
      if [ "$tag_tree" = "$built_tree" ]; then
        echo "$ch: tag templates/$ver already carries this build's tree ${built_tree}; skipping (idempotent re-run)"
      else
        echo "::error::tag templates/$ver already exists with tree ${tag_tree}, but building ${ver} from ${src:0:12} produces tree ${built_tree} - the tag is not this builder's output, and the build-tags ruleset has frozen it. Have an admin delete the tag (the ruleset blocks tag deletion for everyone, so temporarily disable build-tags under Settings > Rules > Rulesets, delete it, re-enable), then re-run this build."
        exit 1
      fi
    else
      # Tag the exact commit this run built or verified (the pub tree's
      # HEAD). Re-resolving origin/$ch here would tag whatever the branch
      # points at NOW - a fast-forward pushed into that window would be
      # frozen by the ruleset under this version's name.
      git tag "templates/$ver" "$(git -C "/tmp/pub-$ch" rev-parse HEAD)"
      git push origin "refs/tags/templates/$ver"
      echo "$ch: tagged templates/$ver"
    fi
  fi
  echo "::endgroup::"
}

if [ "$BUILD_STAGING" = "true" ]; then
  publish staging "$(git rev-parse origin/main)"
fi
if [ "$BUILD_LATEST" = "true" ]; then
  git fetch --quiet --tags origin
  src="$(git rev-list -n1 "refs/tags/$VERSION")"
  publish latest "$src" "$VERSION"
fi
