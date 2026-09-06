# shellcheck shell=bash
# Helpers shared by upgrade_path_test.sh and its legs (sourced into the harness shell: $REPO_ROOT and the fixture variables are the entry's).

# The fleet LICENSE template carries its Required Notice and its
# local-section marker as jinja variables; comparisons against rendered
# projects substitute the copier defaults (independent of the code under
# test, like the rest of this harness). If the template gains a variable
# this oracle does not substitute, it fails HERE naming the leftover -
# not later as a confusing prefix/cmp mismatch far from the cause.
rendered_fleet_license() {
  local rendered leftover
  rendered="$(sed -e 's|{{ copyright_holder }}|Vivswan Shah (https://github.com/Vivswan)|g' \
    -e 's|{{ github_username }}|Vivswan|g' \
    "$GITHUB_WORKSPACE/templates/base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja")"
  case "$rendered" in
    *"{{"* | *"{%"*)
      # head picks the first MATCH (-m1 would only limit matched lines);
      # || true absorbs both a no-match grep and head's early-exit SIGPIPE.
      leftover="$(printf '%s\n' "$rendered" | grep -oE '\{\{[^}]*\}\}|\{%[^}]*%\}' | head -n 1 || true)"
      fail "rendered_fleet_license left an unrendered template expression (${leftover:-an unclosed jinja delimiter}); teach this oracle the substitution for it"
      ;;
  esac
  printf '%s\n' "$rendered"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# `git status --porcelain` with its exit code checked BEFORE its emptiness
# is trusted: a failed status prints nothing, which a bare [ -z ] would
# read as a clean tree.
assert_clean_tree() { # <dir> <failure message>
  local porcelain
  porcelain="$(git -C "$1" status --porcelain)" \
    || fail "git status failed in $1 (cannot judge whether the tree is clean)"
  [ -z "$porcelain" ] || fail "$2"
}

# modules.ts reports its failures on stdout, which the callers' $( )
# capture swallows; on a nonzero exit, surface the captured output before
# failing so the diagnostic is never exit-code-only.
select_modules() {
  local out
  if ! out="$(bun .github/scripts/sync/modules.ts "$@")"; then
    printf '%s\n' "$out" >&2
    fail "sync/modules.ts exited nonzero (its output is above)"
  fi
  printf '%s\n' "$out"
}

# Commit a build tree as a commit + local tag in the workspace clone. With
# a parent ref the commit CHAINS onto it, mirroring the real append-only
# build branches; without one it starts an orphan line. The chain matters:
# copier versions our unparseable refs by dunamai's commit-count fallback
# (0.0.0.postN+hash), so the new build must have a higher count than the
# old or copier's downgrade check trips on hash ordering.
commit_build_tree() { # <tree-dir> <tag> [parent-ref]
  if [ -n "${3:-}" ]; then
    git worktree add --detach --quiet "$WT" "$3"
    git -C "$WT" switch --quiet -c "$REF_NS"
  else
    git worktree add --detach --quiet "$WT" HEAD
    git -C "$WT" switch --quiet --orphan "$REF_NS"
  fi
  rsync -a --delete --exclude=.git "$1/" "$WT/"
  git -C "$WT" add -A
  git -C "$WT" -c user.name=ci -c user.email=ci@localhost commit -q -m "build(ci): $2"
  git tag "$2" "$(git -C "$WT" rev-parse HEAD)"
  git worktree remove --force "$WT"
  git branch -q -D "$REF_NS"
}

# Manifest readers: python3, independent of the stamping code under test.
mf() { # <path> <field> -> the entry's field, "null", "absent", or "missing"
  python3 -c 'import json, sys
entry = json.load(open(".github/repo-platform-manifest.json"))["files"].get(sys.argv[1])
value = "absent" if entry is None else entry.get(sys.argv[2], "missing")
print("null" if value is None else value)' "$1" "$2"
}
file_sha() { # <path> -> sha256 hex of the file's bytes
  python3 -c 'import hashlib, sys
print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
}
