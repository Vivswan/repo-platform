#!/usr/bin/env bash
# Composes and publishes the planned build branches (append-only orphan
# branches; see build-branches.yml's header for the branch model).
# Invoked by build-branches.yml's "Build and publish" step.
#
# Env: BUILD_STAGING, BUILD_LATEST, VERSION, RUN_URL, GITHUB_SERVER_URL,
# GITHUB_REPOSITORY.
set -euo pipefail

git config user.name "repo-platform-build"
git config user.email "repo-platform-build@users.noreply.github.com"

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
  rsync -a --delete --exclude=.git "/tmp/tree-$ch/" "/tmp/pub-$ch/"
  git -C "/tmp/pub-$ch" add -A
  if ! git -C "/tmp/pub-$ch" diff --cached --quiet; then
    note="content change"
  else
    # A main history rewrite can orphan the previous stamp's source while
    # leaving the tree identical. Downstream validation resolves that
    # stamp, so re-stamp with an empty commit instead of skipping.
    prev_src="$(git -C "/tmp/pub-$ch" log -1 --format=%B | sed -n 's|^source: .*/commit/||p' | head -1)"
    if [ -n "$prev_src" ] && ! git rev-parse --verify --quiet "${prev_src}^{commit}" >/dev/null; then
      note="re-stamp: previous source ${prev_src:0:12} unreachable"
    else
      note=""
    fi
  fi
  if [ -n "$note" ]; then
    git -C "/tmp/pub-$ch" commit -q --allow-empty \
      -m "build($ch): ${ver:-main} from ${src:0:12}" \
      -m "source: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/commit/$src" \
      -m "run: $RUN_URL"
    # Plain push, never force: the branches are append-only.
    git -C "/tmp/pub-$ch" push origin "HEAD:refs/heads/$ch"
    echo "$ch: pushed $(git -C "/tmp/pub-$ch" rev-parse --short HEAD) (${note})"
  else
    echo "$ch: no content change"
  fi
  if [ -n "$ver" ] && ! git ls-remote --exit-code origin "refs/tags/templates/$ver" >/dev/null 2>&1; then
    git fetch --quiet origin "$ch"
    git tag "templates/$ver" "origin/$ch"
    git push origin "refs/tags/templates/$ver"
    echo "$ch: tagged templates/$ver"
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
