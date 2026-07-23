#!/usr/bin/env bash
# Upgrade-path test: generate a project from the previous templates/v* build
# tag, add the local modifications a real repo carries, then update it to a
# freshly assembled build tree the way reusable-template-sync does - module
# selection via sync/modules.ts, live -d data, conflict resolution, and
# retired-file cleanup via retired_paths.ts. Asserts that files the template
# dropped are deleted while repo-owned content survives - including
# settings.yml, which is repo-owned wherever it exists (protected from
# cleanup and restored if copier de-renders it). A final leg proves the
# recover=recopy semantics on a corrupted _commit.
#
# Both template refs must live in ONE clone (copier re-renders the old
# version from _src_path), so build trees are committed to local orphan
# refs + tags. Until the first release exists, the old fixture is SYNTHETIC:
# built from the last pre-push-only commit on origin/main.
set -euo pipefail
GITHUB_WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

# Last main commit before the push-only rework: its render still contains
# template-sync.yml, the standalone pr-title/codeql callers, settings.yml,
# and the nested .repo-platform.yml. Obsolete once a real templates/v* tag
# exists - the tag branch below takes over and this pin can be removed.
OLD_FIXTURE_SHA=62653b669d40d3c88b6a0c713942d7e80ac4032d

PROJECT=/tmp/upgrade
WORK=/tmp/upgrade-work

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Idempotent local reruns: drop the artifacts of a previous run.
rm -rf "$PROJECT" "$WORK" /tmp/next /tmp/old-tree
mkdir -p "$WORK"
git worktree remove --force /tmp/wt 2>/dev/null || true
git worktree remove --force /tmp/old-src 2>/dev/null || true
git worktree prune
git branch -q -D ci-build 2>/dev/null || true
git tag -d templates/v0.0.0 2>/dev/null || true
git tag -d templates/v99.99.99 2>/dev/null || true

bun install --frozen-lockfile

# Commit a build tree as a commit + local tag in the workspace clone. With
# a parent ref the commit CHAINS onto it, mirroring the real append-only
# build branches; without one it starts an orphan line. The chain matters:
# copier versions our unparseable refs by dunamai's commit-count fallback
# (0.0.0.postN+hash), so the new build must have a higher count than the
# old or copier's downgrade check trips on hash ordering.
commit_build_tree() { # <tree-dir> <tag> [parent-ref]
  if [ -n "${3:-}" ]; then
    git worktree add --detach --quiet /tmp/wt "$3"
    git -C /tmp/wt switch --quiet -c ci-build
  else
    git worktree add --detach --quiet /tmp/wt HEAD
    git -C /tmp/wt switch --quiet --orphan ci-build
  fi
  rsync -a --delete --exclude=.git "$1/" /tmp/wt/
  git -C /tmp/wt add -A
  git -C /tmp/wt -c user.name=ci -c user.email=ci@localhost commit -q -m "build(ci): $2"
  git tag "$2" "$(git -C /tmp/wt rev-parse HEAD)"
  git worktree remove --force /tmp/wt
  git branch -q -D ci-build
}

git fetch --tags --quiet origin
prev="$(git tag --list 'templates/v*' --sort=-v:refname | sed -n 1p)"
synthetic=false
if [ -z "$prev" ]; then
  synthetic=true
  prev=templates/v0.0.0
  echo "No templates/v* build tag yet; building synthetic old fixture ${prev} from ${OLD_FIXTURE_SHA}"
  git worktree add --detach --quiet /tmp/old-src "$OLD_FIXTURE_SHA"
  # The fixture builds with ITS OWN build script (the pre-rework tree is
  # still python): uv reads the script's inline pyyaml dependency; plain
  # python3 covers environments where pyyaml is already installed.
  if command -v uv >/dev/null 2>&1; then
    (cd /tmp/old-src && uv run --no-project .github/scripts/build_branch_tree.py --dest /tmp/old-tree --channel latest --version v0.0.0)
  else
    (cd /tmp/old-src && python3 .github/scripts/build_branch_tree.py --dest /tmp/old-tree --channel latest --version v0.0.0)
  fi
  git worktree remove --force /tmp/old-src
  commit_build_tree /tmp/old-tree "$prev"
fi
echo "Testing upgrade path ${prev} -> fresh build"

copier copy "$GITHUB_WORKSPACE" "$PROJECT" \
  --vcs-ref "$prev" --defaults --trust \
  -d project_name="Upgrade Test" \
  -d description="Upgrade-path project" \
  -d 'modules=[agents, uv, release-please, issue-templates, pr-title, auto-assign, settings-sync]' \
  -d channel="latest" \
  -d private="false"

# The fixture must actually contain the files whose deletion is under test.
cd "$PROJECT"
test -f .github/settings.yml || fail "fixture render is missing .github/settings.yml"
test -f .github/workflows/settings-sync.yml || fail "fixture render is missing settings-sync.yml"
if [ "$synthetic" = true ]; then
  test -f .github/workflows/template-sync.yml || fail "synthetic fixture is missing template-sync.yml"
  test -f .github/workflows/pr-title.yml || fail "synthetic fixture is missing the standalone pr-title.yml"
  test -f .github/workflows/codeql.yml || fail "synthetic fixture is missing the standalone codeql.yml"
  grep -q '^template:' .repo-platform.yml || fail "synthetic fixture should have the nested .repo-platform.yml shape"
fi
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# Local modifications a real repo carries into a sync:
# - settings.yml gains a line AND leaves the render (module deselected):
#   it is repo-owned and must SURVIVE with the edit (protected in
#   retired_paths.ts plus the preserve step below)
# - checks.yml is generated-once (_skip_if_exists): local edits must survive
# - src/keep_me.txt is repo-owned content the template never rendered
# - .repo-platform.yml drops settings-sync (the module-deselection edit a
#   repo merges before the sync)
echo "# local settings note" >> .github/settings.yml
echo "# local checks note" >> .github/workflows/checks.yml
mkdir -p src
echo "repo-owned sentinel" > src/keep_me.txt
sed 's/, "settings-sync"//' .repo-platform.yml > .repo-platform.yml.tmp
mv .repo-platform.yml.tmp .repo-platform.yml
if grep -q 'settings-sync' .repo-platform.yml; then
  fail "could not drop settings-sync from .repo-platform.yml"
fi
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: local modifications"

# Assemble the would-be next release INTO THE WORKSPACE CLONE, chained
# onto the previous build tag (see commit_build_tree) + a local tag.
cd "$GITHUB_WORKSPACE"
bun .github/scripts/build-branches/branch_tree.ts --dest /tmp/next --channel latest --version v99.99.99
commit_build_tree /tmp/next templates/v99.99.99 "$prev"
git show "${prev}:copier.yml" > "$WORK/copier-old.yml"
git show templates/v99.99.99:copier.yml > "$WORK/copier-new.yml"

# Module selection exactly as reusable-template-sync computes it: the
# target's .repo-platform.yml filtered against the new template's choices.
MODULES="$(bun .github/scripts/sync/modules.ts \
  --repo-file "$PROJECT/.repo-platform.yml" \
  --template-copier "$WORK/copier-new.yml" \
  --retired-summary "$WORK/retired-modules.txt")"
echo "selected modules: ${MODULES}"
case "$MODULES" in
  *settings-sync*) fail "sync/modules.ts kept settings-sync after the deselection" ;;
esac
export MODULES
export CHANNEL=latest
export PRIVATE=false
export DESCRIPTION="Upgraded description"

# The -d data mirrors reusable-template-sync: the update runs through the
# same apply_update.sh wrapper the workflow uses, with the filtered
# modules plus live channel/private/description, so drift in any of them
# re-renders.
export TARGET_DIR="$PROJECT"
export TARGET_REF=templates/v99.99.99
RECOVER="" bash .github/scripts/sync/apply_update.sh
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$WORK/dropped-local-hunks.md" --root "$PROJECT"

# Retired-file cleanup, mirroring the workflow's invocation: render the old
# template with the answers recorded BEFORE the update and the new template
# with the live data on top, then delete what retired_paths.ts computes.
git -C "$PROJECT" show HEAD:.copier-answers.yml > "$WORK/answers-old.yml"
export WORK
src_path="$(bun -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const { parse, stringify } = require("yaml");
  const work = process.env.WORK;
  const answers = parse(readFileSync(work + "/answers-old.yml", "utf-8"));
  const data = Object.fromEntries(
    Object.entries(answers).filter(([key]) => !key.startsWith("_")),
  );
  writeFileSync(work + "/data-old.yml", stringify(data));
  writeFileSync(work + "/data-new.yml", stringify({
    ...data,
    modules: JSON.parse(process.env.MODULES),
    channel: process.env.CHANNEL,
    private: process.env.PRIVATE === "true",
    description: process.env.DESCRIPTION,
  }));
  console.log(answers._src_path ?? "");
')"
test -n "$src_path" || fail ".copier-answers.yml records no _src_path"
old_commit="$(awk '$1 == "_commit:" { print $2 }' "$WORK/answers-old.yml")"
[ "$old_commit" = "$prev" ] || fail "recorded _commit '${old_commit}' is not ${prev}"
old_sha="$(git rev-parse "${prev}^{commit}")"
copier copy --vcs-ref "$old_sha" --defaults --trust \
  --data-file "$WORK/data-old.yml" "$src_path" "$WORK/render-old"
copier copy --vcs-ref templates/v99.99.99 --defaults --trust \
  --data-file "$WORK/data-new.yml" "$src_path" "$WORK/render-new"
bun .github/scripts/sync/retired_paths.ts \
  --old-render "$WORK/render-old" \
  --new-render "$WORK/render-new" \
  --old-copier "$WORK/copier-old.yml" \
  --new-copier "$WORK/copier-new.yml" > "$WORK/retired-paths.json"
if grep -qF '.github/settings.yml' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the repo-owned settings.yml (PROTECTED_PATHS)"
fi
if grep -qF 'checks.yml' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the generated-once checks.yml"
fi
while IFS= read -r path; do
  if [ -e "$PROJECT/${path}" ] || [ -L "$PROJECT/${path}" ]; then
    rm -f "$PROJECT/${path}"
    echo "removed retired file: ${path}"
  fi
done < <(jq -r '.[]' "$WORK/retired-paths.json")

# Mirror the workflow's preserve step: settings.yml is repo-owned; if the
# update de-rendered and deleted it, it comes back from the base commit.
if git -C "$PROJECT" cat-file -e "HEAD:.github/settings.yml" 2>/dev/null \
    && [ ! -e "$PROJECT/.github/settings.yml" ]; then
  git -C "$PROJECT" checkout HEAD -- .github/settings.yml
  echo "preserved repo-owned .github/settings.yml"
fi

bun install --frozen-lockfile --cwd "$GITHUB_WORKSPACE/actions/validate-template"
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$PROJECT"

cd "$PROJECT"
# _commit must record the build tag (git describe lands exactly on it).
grep -qF "_commit: templates/v99.99.99" .copier-answers.yml \
  || fail ".copier-answers.yml does not record templates/v99.99.99"
# Files the template retired must be gone.
for f in \
  .github/workflows/template-sync.yml \
  .github/workflows/settings-sync.yml \
  .github/workflows/pr-title.yml \
  .github/workflows/codeql.yml
do
  test ! -e "$f" || fail "retired file survived the update: $f"
done
# settings.yml is repo-owned (PROTECTED_PATHS + the preserve step):
# deselecting the module
# must leave the file AND its local edit alone.
test -f .github/settings.yml || fail "repo-owned settings.yml was deleted"
grep -qF "# local settings note" .github/settings.yml \
  || fail "repo-owned settings.yml lost its local modification"
# .repo-platform.yml is rewritten to the slimmed shape without settings-sync.
grep -q '^modules:' .repo-platform.yml \
  || fail ".repo-platform.yml has no top-level modules key"
if grep -qE '^(template|update):' .repo-platform.yml; then
  fail ".repo-platform.yml still carries the legacy template/update keys"
fi
if grep -q 'settings-sync' .repo-platform.yml; then
  fail ".repo-platform.yml still lists settings-sync"
fi
# Repo-owned sentinels survive untouched.
[ "$(cat src/keep_me.txt)" = "repo-owned sentinel" ] \
  || fail "repo-owned src/keep_me.txt was modified"
grep -qF "# local checks note" .github/workflows/checks.yml \
  || fail "generated-once checks.yml lost its local modification"
# The update must PRESERVE the repo's configuration, not reset it.
grep -qF -- "## Python " .gitignore || fail ".gitignore lost the uv module section"
grep -qF -- 'package-ecosystem: "uv"' .github/dependabot.yml \
  || fail "dependabot.yml lost the uv module entry"
grep -qF -- "pr-title:" .github/workflows/ci.yml \
  || fail "ci.yml is missing the pr-title gate job"
test -f AGENTS.md || fail "AGENTS.md is missing"
grep -qF "description: Upgraded description" .copier-answers.yml \
  || fail "the live description was not applied"
# No copier leftovers: neither inline conflict markers nor .rej files.
marker="$(printf '<%.0s' 1 2 3 4 5 6 7) before updating"
if grep -rIqF "$marker" . --exclude-dir=.git; then
  fail "unresolved copier conflict markers remain"
fi
if find . -name '*.rej' -not -path './.git/*' | grep -q .; then
  fail "copier left .rej files behind"
fi
echo "upgrade path OK: retired files deleted, sentinels preserved, configuration kept"

# --- Recovery mode (recover=recopy) -----------------------------------
# A repo whose recorded _commit is unusable gets a full re-render via
# sync/apply_update.sh. Prove the copier semantics that path relies on:
# `copier recopy --overwrite` runs without a resolvable _commit, respects
# _skip_if_exists (generated-once files keep local edits), deletes
# nothing, overwrites template-managed files, and re-records _commit.
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: template update"

# Corrupt the recorded base the way a lost build branch would, and add a
# local edit to a template-managed file (recovery legitimately drops it).
sed 's/^_commit: .*/_commit: deadbeef/' .copier-answers.yml > .copier-answers.yml.tmp
mv .copier-answers.yml.tmp .copier-answers.yml
echo "# local ci note" >> .github/workflows/ci.yml
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: corrupt the base"

# The recovery leg also runs through the workflow's wrapper (TARGET_DIR
# is still exported), proving its RECOVER routing along with the copier
# semantics.
RECOVER=recopy bash "$GITHUB_WORKSPACE/.github/scripts/sync/apply_update.sh"
# Mirror the workflow's preserve step in recovery mode: settings.yml is
# repo-owned, so it is restored outright after the re-render.
if git cat-file -e "HEAD:.github/settings.yml" 2>/dev/null; then
  git checkout HEAD -- .github/settings.yml
fi

grep -qF "_commit: templates/v99.99.99" .copier-answers.yml \
  || fail "recovery did not re-record _commit as templates/v99.99.99"
grep -qF "# local checks note" .github/workflows/checks.yml \
  || fail "recovery overwrote the generated-once checks.yml (_skip_if_exists must hold under recopy --overwrite)"
[ "$(cat src/keep_me.txt)" = "repo-owned sentinel" ] \
  || fail "recovery touched the repo-owned src/keep_me.txt"
grep -qF "# local settings note" .github/settings.yml \
  || fail "recovery lost the repo-owned settings.yml edit (preserve step)"
if grep -qF "# local ci note" .github/workflows/ci.yml; then
  fail "recovery kept a local edit in the template-managed ci.yml (recopy must overwrite it)"
fi
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$PROJECT"
echo "recovery recopy OK: skip_if_exists and repo-owned files preserved, managed files re-rendered"
