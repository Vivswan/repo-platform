#!/usr/bin/env bash
# Upgrade-path test: generate a project from the previous templates/v* build
# tag, add the local modifications a real repo carries, then update it to a
# freshly assembled build tree the way reusable-template-sync does - module
# selection via sync/modules.ts, live -d data via sync/apply_update.ts,
# conflict resolution, retired-file cleanup via sync/retired_cleanup.ts,
# and the settings preserve step via sync/preserve_repo_owned.ts. Asserts
# that files the template dropped are deleted while repo-owned content
# survives - including settings.yml, which is repo-owned wherever it exists
# (protected from cleanup and restored if copier de-renders it). A second
# leg proves the recover=recopy semantics on a corrupted _commit, and a
# third runs an update where visibility flips public -> private (its own
# fixture, so this leg's settings-sync deselection coverage stays intact).
#
# Both template refs must live in ONE clone (copier re-renders the old
# version from _src_path), so build trees are committed to local orphan
# refs + tags. Until the first release exists, the old fixture is SYNTHETIC:
# the current templates assembled at v0.0.0 by the current tooling, plus a
# sentinel file the new build no longer renders.
set -euo pipefail
GITHUB_WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"

PROJECT=/tmp/upgrade
WORK=/tmp/upgrade-work

# The fleet LICENSE template carries its Required Notice and its
# local-section marker as jinja variables; comparisons against rendered
# projects substitute the copier defaults (independent of the code under
# test, like the rest of this harness).
rendered_fleet_license() {
  sed -e 's|{{ copyright_holder }}|Vivswan Shah (https://github.com/Vivswan)|g' \
    -e 's|{{ github_username }}|Vivswan|g' \
    "$GITHUB_WORKSPACE/templates/base/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja"
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Idempotent local reruns: drop the artifacts of a previous run.
rm -rf "$PROJECT" "$WORK" /tmp/next /tmp/old-tree /tmp/upgrade-vis /tmp/upgrade-vis-work /tmp/upgrade-del /tmp/upgrade-del-hunks.md
mkdir -p "$WORK"
git worktree remove --force /tmp/wt 2>/dev/null || true
git worktree prune
git branch -q -D ci-build 2>/dev/null || true
git tag -d templates/v0.0.0 2>/dev/null || true
git tag -d templates/v99.99.99 2>/dev/null || true

# ... and never leave the fixture tags behind either: locally they land in
# the real repo's tag namespace, where templates/v* names are load-bearing.
# The script cd's around, so pin cleanup to the repo root.
REPO_ROOT="$(pwd)"
cleanup() {
  git -C "$REPO_ROOT" worktree remove --force /tmp/wt 2>/dev/null || true
  git -C "$REPO_ROOT" branch -q -D ci-build 2>/dev/null || true
  git -C "$REPO_ROOT" tag -d templates/v0.0.0 templates/v99.99.99 2>/dev/null || true
}
trap cleanup EXIT

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
  echo "No templates/v* build tag yet; building synthetic old fixture ${prev}"
  # Same templates, same tooling: the fixture is the current tree assembled
  # at v0.0.0, plus one extra template-managed file the new build does not
  # render. It is the retirement case retired_cleanup.ts exists for; the
  # test resurrects it after the update (see below) so the deletion loop
  # runs against a real file regardless of copier's own delete behavior.
  bun .github/scripts/build-branches/branch_tree.ts --dest /tmp/old-tree --channel latest --version v0.0.0
  echo "retired sentinel" > /tmp/old-tree/template/.github/retired-sentinel.txt
  # Model the historical fleet state the relicensing migrates away from: the
  # old template shipped a different LICENSE, ungated and listed in
  # _skip_if_exists. Without this the synthetic fixture would already carry
  # the current license and the transition assertions below would be
  # vacuous.
  rm "/tmp/old-tree/template/{% if 'custom-license' not in modules %}LICENSE.md{% endif %}.jinja"
  echo "Old fleet license (pre-relicense fixture)" > /tmp/old-tree/template/LICENSE
  awk '{print} /^_skip_if_exists:/{print "  - LICENSE"}' /tmp/old-tree/copier.yml \
    > /tmp/old-tree/copier.yml.tmp
  mv /tmp/old-tree/copier.yml.tmp /tmp/old-tree/copier.yml
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
  test -f .github/retired-sentinel.txt || fail "synthetic fixture is missing the retired sentinel"
  [ "$(cat LICENSE)" = "Old fleet license (pre-relicense fixture)" ] \
    || fail "synthetic fixture did not render the old fleet license"
fi
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# Local modifications a real repo carries into a sync:
# - settings.yml gains a line AND leaves the render (module deselected):
#   it is repo-owned and must SURVIVE with the edit (protected in
#   retired_paths.ts plus the preserve step below)
# - checks.yml is generated-once (_skip_if_exists): local edits must survive
# - bug_report.yml is generated-once (_skip_if_exists issue forms): local
#   tailoring must survive the update
# - LICENSE.md swaps to a repo-owned license and .repo-platform.yml gains
#   the custom-license module (the opt-out a repo merges before the sync):
#   the divergent content must survive the update, the de-render, and the
#   retired-file cleanup (protectedPaths)
# - retired-sentinel.txt (synthetic fixture) left the render between the
#   builds; it is resurrected after the update so its deletion provably
#   comes from retired_cleanup.ts
# - src/keep_me.txt is repo-owned content the template never rendered
# - .repo-platform.yml drops settings-sync (the module-deselection edit a
#   repo merges before the sync)
echo "# local settings note" >> .github/settings.yml
echo "# local checks note" >> .github/workflows/checks.yml
echo "# local issue form note" >> .github/ISSUE_TEMPLATE/bug_report.yml
echo "Repo-owned custom license" > LICENSE
# Adopting custom-license REPLACES the fleet license: a repo drops the
# rendered LICENSE.md in the same commit (the one-license rule; the
# synthetic old build renders the extensionless spelling, which the echo
# above already overwrote).
if [ -e LICENSE.md ]; then
  git rm -q LICENSE.md
fi
if [ "$synthetic" = true ]; then
  echo "# local sentinel note" >> .github/retired-sentinel.txt
fi
mkdir -p src
echo "repo-owned sentinel" > src/keep_me.txt
sed -e 's/, "settings-sync"//' -e 's/]$/, "custom-license"]/' \
  .repo-platform.yml > .repo-platform.yml.tmp
mv .repo-platform.yml.tmp .repo-platform.yml
if grep -q 'settings-sync' .repo-platform.yml; then
  fail "could not drop settings-sync from .repo-platform.yml"
fi
grep -q 'custom-license' .repo-platform.yml \
  || fail "could not add custom-license to .repo-platform.yml"
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
case "$MODULES" in
  *custom-license*) : ;;
  *) fail "sync/modules.ts dropped the newly selected custom-license" ;;
esac
export MODULES
export CHANNEL=latest
export PRIVATE=false
export DESCRIPTION="Upgraded description"

# The -d data mirrors reusable-template-sync: the update runs through the
# same apply_update.ts wrapper the workflow uses, with the filtered
# modules plus live channel/private/description, so drift in any of them
# re-renders.
export TARGET_DIR="$PROJECT"
export TARGET_REF=templates/v99.99.99
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$WORK/dropped-local-hunks.md" --root "$PROJECT"

# Retired-file cleanup runs the workflow's own script, pointed at the
# project through TARGET_DIR, with RUNNER_TEMP set to $WORK where the
# copier.yml snapshots already sit (resolve_refs.ts writes them there in
# the workflow).
answers_old="$(git -C "$PROJECT" show HEAD:.copier-answers.yml)"
src_path="$(sed -n 's/^_src_path: //p' <<<"$answers_old")"
test -n "$src_path" || fail ".copier-answers.yml records no _src_path"
old_commit="$(awk '$1 == "_commit:" { print $2 }' <<<"$answers_old")"
[ "$old_commit" = "$prev" ] || fail "recorded _commit '${old_commit}' is not ${prev}"
# Current copier already deletes the de-rendered sentinel during update, so
# without help the rm loop below would run over an empty set and pass even
# if it were broken. Resurrect the file the way an older copier (or a merge
# driver) can leave it, so the loop must really delete it.
if [ "$synthetic" = true ]; then
  echo "retired sentinel" > "$PROJECT/.github/retired-sentinel.txt"
fi
RUNNER_TEMP="$WORK" SRC_PATH="$src_path" \
  OLD_SHA="$(git rev-parse "${prev}^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
if grep -qF '.github/settings.yml' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the repo-owned settings.yml (protectedPaths)"
fi
if grep -qF 'checks.yml' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the generated-once checks.yml"
fi
if grep -qF '"LICENSE"' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the repo-owned LICENSE (protectedPaths)"
fi
if [ "$synthetic" = true ] && ! grep -qF '.github/retired-sentinel.txt' "$WORK/retired-paths.json"; then
  fail "retired_paths did not flag the sentinel that left the render"
fi
if [ "$synthetic" = true ] && ! grep -qF '.github/retired-sentinel.txt' "$WORK/removed-paths.txt"; then
  fail "retired_cleanup's rm loop did not delete the resurrected sentinel"
fi

# The workflow's preserve step: settings.yml and the opted-out LICENSE are
# repo-owned; if the update de-rendered and deleted either, it comes back
# from the base commit.
RECOVER="" RUNNER_TEMP="$WORK" bun .github/scripts/sync/preserve_repo_owned.ts

bun install --frozen-lockfile --cwd "$GITHUB_WORKSPACE/actions/validate-template"
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$PROJECT"

cd "$PROJECT"
# _commit must record the build tag (git describe lands exactly on it).
grep -qF "_commit: templates/v99.99.99" .copier-answers.yml \
  || fail ".copier-answers.yml does not record templates/v99.99.99"
# Files the template retired must be gone: settings-sync.yml left the
# render with the module deselection, and the synthetic sentinel left the
# template between builds despite its local edit.
retired_files=(.github/workflows/settings-sync.yml)
if [ "$synthetic" = true ]; then
  retired_files+=(.github/retired-sentinel.txt)
fi
for f in "${retired_files[@]}"; do
  test ! -e "$f" || fail "retired file survived the update: $f"
done
# settings.yml is repo-owned (PROTECTED_PATHS + the preserve step):
# deselecting the module must leave the file AND its local edit alone.
test -f .github/settings.yml || fail "repo-owned settings.yml was deleted"
grep -qF "# local settings note" .github/settings.yml \
  || fail "repo-owned settings.yml lost its local modification"
# .repo-platform.yml keeps the slimmed selection without settings-sync.
grep -q '^modules:' .repo-platform.yml \
  || fail ".repo-platform.yml has no top-level modules key"
if grep -q 'settings-sync' .repo-platform.yml; then
  fail ".repo-platform.yml still lists settings-sync"
fi
# Repo-owned sentinels survive untouched.
[ "$(cat src/keep_me.txt)" = "repo-owned sentinel" ] \
  || fail "repo-owned src/keep_me.txt was modified"
grep -qF "# local checks note" .github/workflows/checks.yml \
  || fail "generated-once checks.yml lost its local modification"
grep -qF "# local issue form note" .github/ISSUE_TEMPLATE/bug_report.yml \
  || fail "generated-once bug_report.yml lost its local modification (_skip_if_exists must hold)"
# LICENSE opted out via the custom-license module: the repo's own license
# must survive the update, the de-render, and the retired-file cleanup.
[ "$(cat LICENSE)" = "Repo-owned custom license" ] \
  || fail "the repo-owned LICENSE was modified despite the custom-license opt-out"
# Public-only community files and the dependency-review gate must be in the
# updated render (they arrive via the update when the old fixture predates
# them).
test -f CONTRIBUTING.md || fail "CONTRIBUTING.md is missing after the public update"
test -f CODE_OF_CONDUCT.md || fail "CODE_OF_CONDUCT.md is missing after the public update"
grep -qF -- "dependency-review:" .github/workflows/ci.yml \
  || fail "ci.yml is missing the dependency-review gate job"
grep -qF -- "- dependency-review" .github/workflows/ci.yml \
  || fail "ci.yml's all-green does not need dependency-review"
# The update must PRESERVE the repo's configuration, not reset it.
grep -qF -- "## Python " .gitignore || fail ".gitignore lost the uv module section"
grep -qF -- 'package-ecosystem: "uv"' .github/dependabot.yml \
  || fail "dependabot.yml lost the uv module entry"
grep -qF -- "pr-title:" .github/workflows/ci.yml \
  || fail "ci.yml is missing the pr-title gate job"
# A templates/vX.Y.Z _commit strips to the same-version release tag on
# main (the uses_ref logic in the workflow templates): rendered workflows
# pin the composite actions there, never at main.
grep -qF -- "repo-platform/actions/check-typography@v99.99.99" .github/workflows/ci.yml \
  || fail "ci.yml does not pin check-typography at the v99.99.99 release tag"
grep -qF -- "repo-platform/actions/dependency-review@v99.99.99" .github/workflows/ci.yml \
  || fail "ci.yml does not pin dependency-review at the v99.99.99 release tag"
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
# sync/apply_update.ts. Prove the copier semantics that path relies on:
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
# Sanctioned repository-local content the local-content carry must bring
# back over the re-render (unlike the ci.yml edit above, which must drop):
# a tail below AGENTS.md's local-section marker, a CONTRIBUTING.md
# repository tail, a .gitignore REPOSITORY LOCAL entry, and tails below
# the hash-comment sentinels of .editorconfig and .github/CODEOWNERS.
echo "recovery-local agents note" >> AGENTS.md
echo "recovery-local contributing note" >> CONTRIBUTING.md
printf '[recovery-local/**.js]\nindent_size = 3\n' >> .editorconfig
echo "/recovery-local/ @recovery-local-owner" >> .github/CODEOWNERS
awk '/^# END REPOSITORY LOCAL$/ { print "recovery-local-cache/" } { print }' .gitignore > .gitignore.tmp
mv .gitignore.tmp .gitignore
# ... and the appendix path: strip .gitattributes' sentinel (a legacy copy
# that predates the marker), so the carry cannot split it and must keep
# the whole previous copy below a marked recovery-appendix comment.
echo "recovery-local-attr binary" >> .gitattributes
sed '/^# repo-platform:local-section$/d' .gitattributes > .gitattributes.tmp
mv .gitattributes.tmp .gitattributes
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: corrupt the base"

# The recovery leg also runs through the workflow's wrapper, the
# local-content carry, and the repo-owned preserve step (TARGET_DIR is
# still exported), in the workflow's order, proving their RECOVER routing
# along with the copier semantics.
RECOVER=recopy bun "$GITHUB_WORKSPACE/.github/scripts/sync/apply_update.ts"
bun "$GITHUB_WORKSPACE/.github/scripts/sync/preserve_local_content.ts" \
  --summary "$WORK/local-carryover.md" --root .
RECOVER=recopy RUNNER_TEMP="$WORK" bun "$GITHUB_WORKSPACE/.github/scripts/sync/preserve_repo_owned.ts"

grep -qF "_commit: templates/v99.99.99" .copier-answers.yml \
  || fail "recovery did not re-record _commit as templates/v99.99.99"
grep -qF "# local checks note" .github/workflows/checks.yml \
  || fail "recovery overwrote the generated-once checks.yml (_skip_if_exists must hold under recopy --overwrite)"
grep -qF "# local issue form note" .github/ISSUE_TEMPLATE/bug_report.yml \
  || fail "recovery overwrote the generated-once bug_report.yml (_skip_if_exists must hold under recopy --overwrite)"
[ "$(cat LICENSE)" = "Repo-owned custom license" ] \
  || fail "recovery touched the repo-owned LICENSE (custom-license de-renders it; recopy deletes nothing)"
[ "$(cat src/keep_me.txt)" = "repo-owned sentinel" ] \
  || fail "recovery touched the repo-owned src/keep_me.txt"
grep -qF "# local settings note" .github/settings.yml \
  || fail "recovery lost the repo-owned settings.yml edit (preserve step)"
if grep -qF "# local ci note" .github/workflows/ci.yml; then
  fail "recovery kept a local edit in the template-managed ci.yml (recopy must overwrite it)"
fi
grep -qF "recovery-local agents note" AGENTS.md \
  || fail "recovery lost AGENTS.md's local section (local-content carry)"
grep -qF "recovery-local contributing note" CONTRIBUTING.md \
  || fail "recovery lost CONTRIBUTING.md's repository tail (local-content carry)"
grep -qF "recovery-local-cache/" .gitignore \
  || fail "recovery lost .gitignore's REPOSITORY LOCAL entry (local-content carry)"
grep -qF "[recovery-local/**.js]" .editorconfig \
  || fail "recovery lost .editorconfig's local section (local-content carry)"
grep -qF "/recovery-local/ @recovery-local-owner" .github/CODEOWNERS \
  || fail "recovery lost CODEOWNERS' local owner rules (local-content carry)"
grep -qF "# repo-platform:recovery-appendix" .gitattributes \
  || fail "recovery did not mark .gitattributes' unsplittable previous copy with the appendix"
grep -qF "recovery-local-attr binary" .gitattributes \
  || fail "recovery lost .gitattributes' local attribute (appendix carry)"
for carried in AGENTS.md CONTRIBUTING.md .gitignore .gitattributes .editorconfig .github/CODEOWNERS; do
  grep -qF "$carried" "$WORK/local-carryover.md" \
    || fail "the local-content carry summary does not list $carried"
done
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$PROJECT"
echo "recovery recopy OK: skip_if_exists, repo-owned files, and repo-local content preserved, managed files re-rendered"

# --- Visibility flip (public -> private) --------------------------------
# The transition machinery issue #25's fix leans on: an update where the
# live visibility changed between syncs must drop the conditional-filename
# CONTRIBUTING.md render, flip settings.yml's private line through the
# three-way merge (dropping the code_scanning ruleset rule with it), and
# strip the codeql machinery from ci.yml. Runs on a fresh public fixture
# through the same workflow scripts as the main leg, with settings-sync
# KEPT selected - only the visibility changes.
VIS=/tmp/upgrade-vis
VIS_WORK=/tmp/upgrade-vis-work
mkdir -p "$VIS_WORK"

cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$VIS" \
  --vcs-ref "$prev" --defaults --trust \
  -d project_name="Visibility Flip" \
  -d description="Visibility-flip project" \
  -d 'modules=[bun, settings-sync]' \
  -d channel="latest" \
  -d private="false"

# The fixture must carry the public-only machinery whose removal is under
# test.
cd "$VIS"
test -f SECURITY.md || fail "public fixture render is missing SECURITY.md"
# The newer public-only artifacts exist in the old fixture only once the
# previous release ships them; key their preconditions on the tag's tree so
# the flip assertions below stop being vacuous exactly when they can.
if git -C "$GITHUB_WORKSPACE" ls-tree -r --name-only "$prev" | grep -qF "CONTRIBUTING.md"; then
  test -f CONTRIBUTING.md || fail "public fixture render is missing CONTRIBUTING.md"
  test -f CODE_OF_CONDUCT.md || fail "public fixture render is missing CODE_OF_CONDUCT.md"
  grep -qF "dependency-review:" .github/workflows/ci.yml \
    || fail "public fixture ci.yml is missing the dependency-review job"
  grep -qF "security_and_analysis:" .github/settings.yml \
    || fail "public fixture settings.yml is missing security_and_analysis"
fi
grep -qxF "  private: false" .github/settings.yml \
  || fail "public fixture settings.yml does not declare private: false"
grep -qF "type: code_scanning" .github/settings.yml \
  || fail "public fixture settings.yml is missing the code_scanning rule"
grep -qF "codeql-javascript" .github/workflows/ci.yml \
  || fail "public fixture ci.yml is missing the codeql-javascript job"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# A divergent license WITHOUT the custom-license opt-out: the fleet
# relicense must win the three-way merge - the fleet text leads the file,
# with the local content either kept below the trailing notices marker or
# dropped and recorded in the dropped-hunks summary. The old and
# new fixture licenses only differ in synthetic mode (a real prev release
# already ships the current fleet license, and copier re-applies a local
# diff cleanly when the template side did not change), so the divergence is
# planted only there.
if [ "$synthetic" = true ]; then
  echo "Divergent unopted license" > LICENSE
  git add --all
  git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: divergent license"
else
  # A repo-local notice below the LICENSE.md marker is repo-owned content
  # and must ride through the sync (prefix pairing, like CONTRIBUTING's
  # local section).
  printf '\nBundled vendor components are licensed separately; see vendor/.\n' >> LICENSE.md
  git add --all
  git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: local license notice"
fi

# Same pipeline as the main leg, but the live data says PRIVATE=true while
# the recorded answers still say false - the drift the sync re-renders.
cd "$GITHUB_WORKSPACE"
git show "${prev}:copier.yml" > "$VIS_WORK/copier-old.yml"
git show templates/v99.99.99:copier.yml > "$VIS_WORK/copier-new.yml"
MODULES="$(bun .github/scripts/sync/modules.ts \
  --repo-file "$VIS/.repo-platform.yml" \
  --template-copier "$VIS_WORK/copier-new.yml" \
  --retired-summary "$VIS_WORK/retired-modules.txt")"
export MODULES
export CHANNEL=latest
export PRIVATE=true
export DESCRIPTION="Visibility-flip project"
export TARGET_DIR="$VIS"
export TARGET_REF=templates/v99.99.99
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$VIS_WORK/dropped-local-hunks.md" --root "$VIS"

# Current copier already deletes the de-rendered CONTRIBUTING.md during
# the update; resurrect it (the sentinel trick above) so retired_cleanup's
# data-driven old/new render diff - old render private=false from the
# recorded answers, new render private=true from the live data - must
# really flag and delete it. Guarded like the precondition block above:
# CONTRIBUTING.md only exists in builds that shipped it.
if git -C "$GITHUB_WORKSPACE" ls-tree -r --name-only "$prev" | grep -qF "CONTRIBUTING.md"; then
  echo "# Contributing" > "$VIS/CONTRIBUTING.md"
fi
answers_vis="$(git -C "$VIS" show HEAD:.copier-answers.yml)"
src_path_vis="$(sed -n 's/^_src_path: //p' <<<"$answers_vis")"
test -n "$src_path_vis" || fail "visibility fixture records no _src_path"
RUNNER_TEMP="$VIS_WORK" SRC_PATH="$src_path_vis" \
  OLD_SHA="$(git rev-parse "${prev}^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
if git -C "$GITHUB_WORKSPACE" ls-tree -r --name-only "$prev" | grep -qF "CONTRIBUTING.md"; then
  grep -qF '"CONTRIBUTING.md"' "$VIS_WORK/retired-paths.json" \
    || fail "retired_paths did not flag CONTRIBUTING.md on the public->private flip"
  grep -qxF "CONTRIBUTING.md" "$VIS_WORK/removed-paths.txt" \
    || fail "retired_cleanup's rm loop did not delete the resurrected CONTRIBUTING.md"
fi
RECOVER="" RUNNER_TEMP="$VIS_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
if [ "$synthetic" = true ]; then
  grep -qxF "LICENSE" "$VIS_WORK/license-transition.txt" \
    || fail "the license rename did not raise the license-transition flag that holds the PR for review"
fi

bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$VIS"

cd "$VIS"
# SECURITY.md is visibility-independent since the ungating: it must
# survive the flip.
test -f SECURITY.md || fail "SECURITY.md did not survive the flip to private"
# The public-only base files and gates must retire on the flip; the
# license is visibility-independent and (without custom-license)
# template-managed, so LICENSE.md must converge to the fleet license -
# this is the migration path a relicensing (and the LICENSE -> LICENSE.md
# rename) takes through a real sync, deleting the old spelling.
test ! -e CONTRIBUTING.md || fail "CONTRIBUTING.md survived the flip to private"
test ! -e CODE_OF_CONDUCT.md || fail "CODE_OF_CONDUCT.md survived the flip to private"
# Assign first: a failed substitution inside a case WORD does not trip
# errexit, and an empty pattern would collapse to a match-everything *.
fleet_license="$(rendered_fleet_license)"
[ -n "$fleet_license" ] || fail "could not render the fleet license"
case "$(cat LICENSE.md)" in
  "$fleet_license"*) ;;
  *) fail "the fleet license is not a prefix of LICENSE.md after the flip to private" ;;
esac
if [ "$synthetic" != true ]; then
  grep -qF "Bundled vendor components are licensed separately; see vendor/." LICENSE.md \
    || fail "the repo-local license notice below the marker did not survive the sync"
fi
if [ "$synthetic" = true ]; then
  # The old extensionless spelling is template-managed without the
  # custom-license module: the rename must delete it. Copier resolves the
  # delete-vs-modify by dropping the file, so divergent local content
  # survives only in the target's git history and the PR's own file
  # diff - which is why a license deletion always holds the PR for human
  # review (git history stays the record of prior licensing; nothing is
  # ported into LICENSE.md).
  test ! -e LICENSE || fail "the old extensionless LICENSE survived the rename"
  # No pipe into grep -q: under pipefail its early exit SIGPIPEs git log.
  [ -n "$(git log --all --format=%H -- LICENSE)" ] \
    || fail "the deleted LICENSE left no history to recover the divergent content from"
fi
if grep -qF "dependency-review" .github/workflows/ci.yml; then
  fail "ci.yml kept the dependency-review job after the flip to private"
fi
if grep -qF "security_and_analysis" .github/settings.yml; then
  fail "settings.yml kept security_and_analysis after the flip to private"
fi
grep -qxF "  private: true" .github/settings.yml \
  || fail "settings.yml's private line did not flip to true"
# The other always-declared identity keys must survive the three-way merge
# with their empty declare-and-clear values intact.
grep -qxF '  homepage: ""' .github/settings.yml \
  || fail "settings.yml lost the empty homepage declaration across the update"
grep -qxF '  topics: ""' .github/settings.yml \
  || fail "settings.yml lost the empty topics declaration across the update"
if grep -qF "type: code_scanning" .github/settings.yml; then
  fail "settings.yml kept the code_scanning rule after the flip to private"
fi
# The unconditional header comment mentions CodeQL by name, so assert on
# the machinery: the job (and its reusable-workflow call) and the gate's
# needs entry all carry the codeql-javascript identifier.
if grep -qF "codeql-javascript" .github/workflows/ci.yml; then
  fail "ci.yml kept the codeql-javascript job after the flip to private"
fi
if grep -qF "reusable-codeql" .github/workflows/ci.yml; then
  fail "ci.yml kept the reusable-codeql call after the flip to private"
fi
if grep -rIqF "$marker" . --exclude-dir=.git; then
  fail "the visibility flip left unresolved copier conflict markers"
fi
if find . -name '*.rej' -not -path './.git/*' | grep -q .; then
  fail "the visibility flip left .rej files behind"
fi
echo "visibility flip OK: CONTRIBUTING.md retired, private declared true, codeql stripped"

# --- Committed LICENSE deletion (fleet license mandatory) ----------------
# A repo still on the fleet license that committed a LICENSE deletion:
# copier honors the deletion when it re-applies the local diff, cleanup
# never lists the path (LICENSE.md is in both renders), and HEAD has no
# copy to restore - the preserve step
# must re-seed the fleet license from the target build ref.
DEL=/tmp/upgrade-del
cd "$GITHUB_WORKSPACE"
# Rendered from the NEW build: the re-seed hole only exists when the base
# already carried LICENSE.md and the local diff deletes it (a fixture on
# the old build gets LICENSE.md as a fresh render, which never needs the
# re-seed).
copier copy "$GITHUB_WORKSPACE" "$DEL" \
  --vcs-ref templates/v99.99.99 --defaults --trust \
  -d project_name="License Deletion" \
  -d description="License-deletion project" \
  -d 'modules=[agents]' \
  -d channel="latest" \
  -d private="false"
cd "$DEL"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"
git rm -q LICENSE.md
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: delete LICENSE.md"
cd "$GITHUB_WORKSPACE"
export MODULES='["agents"]'
export CHANNEL=latest
export PRIVATE=false
export DESCRIPTION="License-deletion project"
export TARGET_DIR="$DEL"
export TARGET_REF=templates/v99.99.99
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary /tmp/upgrade-del-hunks.md --root "$DEL"
RECOVER="" RUNNER_TEMP=/tmp bun .github/scripts/sync/preserve_repo_owned.ts
rendered_fleet_license | cmp -s "$DEL/LICENSE.md" - \
  || fail "a committed LICENSE deletion did not re-converge to the mandatory fleet license"
echo "license deletion OK: fleet license re-seeded"
