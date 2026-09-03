#!/usr/bin/env bash
# Upgrade-path test: generate a project from a synthetic OLD build tree,
# add the local modifications a real repo carries, then update it to a
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
# refs + tags. The old fixture is SYNTHETIC: the current templates
# assembled by the current tooling, plus a sentinel file the new build no
# longer renders and the pre-relicense LICENSE shape.
# shellcheck disable=SC2016  # assertion strings carry literal backticks
set -euo pipefail
GITHUB_WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
# The script cd's around; pin repo-scoped git calls and cleanup to the root.
REPO_ROOT="$(pwd)"

# Every run gets its own fixture directory AND its own ref namespace, both
# keyed on one random token. Linked worktrees share a single ref store and
# a single /tmp, so two concurrent local runs used to delete each other's
# build tags mid-flight ("pathspec 'ci-build/old' did not match any
# file(s) known to git") and overwrite each other's fixtures. In CI the
# harness runs alone, so isolation only ever costs a uniquely named
# directory. Cleanup runs from the EXIT trap, which covers ordinary
# failures and Ctrl-C. A SIGKILLed run leaves EVERYTHING behind - the
# directory, its worktree admin entry, and its tags (SIGKILL skips EXIT
# traps, and the prune below only drops admin entries whose directories
# are already gone) - so sweep by hand:
#   git tag -l 'ci-build-*/*'          # stray tag namespaces
#   git branch --list 'ci-build-*'     # stray build branches
#   git worktree list                  # stray worktree admin entries
TMP_ROOT="${TMPDIR:-/tmp}"
# Normalized to an absolute path: the harness cd's between the repo and
# its fixtures, so a relative "$RUN_DIR/..." (cleanup rm included) would
# resolve against whatever directory happens to be current. A TMPDIR that
# lands INSIDE the repo checkout is rejected outright rather than
# relocated: branch_tree.ts refuses any destination beneath the repo, the
# nested worktree would sit inside the main worktree, and a silent
# relocation would surprise - fail loud, before any namespace exists.
TMP_ROOT_ABS="$(cd "$TMP_ROOT" 2>/dev/null && pwd)" || {
  echo "FAIL: TMPDIR '$TMP_ROOT' does not exist or cannot be entered" >&2
  exit 1
}
case "$TMP_ROOT_ABS/" in
  "$REPO_ROOT/" | "$REPO_ROOT"/*)
    echo "FAIL: TMPDIR resolves to '$TMP_ROOT_ABS', inside the repo checkout '$REPO_ROOT' - the harness's fixtures cannot live under the repo (branch_tree.ts refuses such destinations and the nested worktree would sit inside the main worktree); point TMPDIR outside the checkout" >&2
    exit 1
    ;;
esac
RUN_DIR="$(cd "$(mktemp -d "${TMP_ROOT_ABS%/}/upgrade-path.XXXXXX")" && pwd)"
REF_NS="ci-build-${RUN_DIR##*.}"
OLD_TAG="$REF_NS/old"
NEW_TAG="$REF_NS/new"
SPLIT_TAG="$REF_NS/split"
WT="$RUN_DIR/wt"

PROJECT="$RUN_DIR/upgrade"
WORK="$RUN_DIR/upgrade-work"
OLD_TREE="$RUN_DIR/old-tree"
NEXT_TREE="$RUN_DIR/next"

# Armed immediately after the namespace exists, so nothing between here and
# the first fixture can leak it.
cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WT" 2>/dev/null || true
  git -C "$REPO_ROOT" branch -q -D "$REF_NS" 2>/dev/null || true
  git -C "$REPO_ROOT" tag -d "$OLD_TAG" "$NEW_TAG" "$SPLIT_TAG" 2>/dev/null || true
  rm -rf "$RUN_DIR"
}
trap cleanup EXIT

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

# $RUN_DIR is fresh by construction, so there is nothing of ours to clear
# first - and nothing of anyone else's to destroy, which is exactly what
# the old fixed-path cleanup did to a concurrent run.
mkdir -p "$WORK"
# Safe under concurrency: this only drops admin entries whose working tree
# directory is already GONE - it cannot touch a live run's, and it does
# NOT collect after a SIGKILLed run (the directory survives; see the
# manual sweep recipe in the header).
git worktree prune

bun install --frozen-lockfile

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

prev="$OLD_TAG"
echo "Building synthetic old fixture ${prev}"
# Same templates, same tooling: the fixture is the current tree assembled
# by the current tooling, plus one extra template-managed file the new
# build does not render. It is the retirement case retired_cleanup.ts
# exists for; the test resurrects it after the update (see below) so the
# deletion loop runs against a real file regardless of copier's own delete
# behavior.
bun .github/scripts/build-branches/branch_tree.ts --dest "$OLD_TREE"
# Model the fleet state before the answers file left the repository root:
# the old template pointed _answers_file at .copier-answers.yml, rendered
# the file there, and classed the root path in the manifest. The update
# below is what must MOVE the recorded answers to .github/ byte-for-byte
# (relocate_answers.ts), which the move assertions after the render pin.
mv "$OLD_TREE/template/.github/.copier-answers.yml.jinja" \
  "$OLD_TREE/template/.copier-answers.yml.jinja"
sed 's|^_answers_file: .github/.copier-answers.yml$|_answers_file: .copier-answers.yml|' \
  "$OLD_TREE/copier.yml" > "$OLD_TREE/copier.ans.tmp"
mv "$OLD_TREE/copier.ans.tmp" "$OLD_TREE/copier.yml"
grep -qx '_answers_file: .copier-answers.yml' "$OLD_TREE/copier.yml" \
  || fail "could not point the old fixture's _answers_file at the root path"
sed 's|"\.github/\.copier-answers\.yml"|".copier-answers.yml"|' \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  > "$OLD_TREE/manifest.ans.tmp"
mv "$OLD_TREE/manifest.ans.tmp" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja"
grep -qF '".copier-answers.yml"' \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  || fail "could not model the pre-move manifest entry for the root answers path"
echo "retired sentinel" > "$OLD_TREE/template/.github/retired-sentinel.txt"
# Model the fleet state before the Copilot gate moved into the ruleset: the
# old template shipped a managed rerun-copilot-gate.yml (the re-arm half of
# the retired copilot-review bridge). The new build renders no such file,
# so the sync must DELETE it in every managed repo - this pins that
# transition (a plain non-jinja file: copier copies it verbatim, which is
# all the retirement diff needs).
printf 'name: Rerun Copilot Gate\non: [pull_request_review]\n' \
  > "$OLD_TREE/template/.github/workflows/rerun-copilot-gate.yml"
# Model the historical fleet state the relicensing moved away from: the
# old template shipped a different LICENSE, ungated and listed in
# _skip_if_exists. Without this the synthetic fixture would already carry
# the current license and the transition assertions below would be
# vacuous.
rm "$OLD_TREE/template/LICENSE.md.jinja"
echo "Old fleet license (pre-relicense fixture)" > "$OLD_TREE/template/LICENSE"
awk '{print} /^_skip_if_exists:/{print "  - LICENSE"}' "$OLD_TREE/copier.yml" \
  > "$OLD_TREE/copier.yml.tmp"
mv "$OLD_TREE/copier.yml.tmp" "$OLD_TREE/copier.yml"
# Model the verdict-era fleet state: the old template shipped the
# all-green.yml verdict wrapper (retired with the meta-check inversion),
# no fleet-ci caller, and the legacy aggregate all-green job in ci.yml -
# so the update below is what must land the in-run gate AND delete the
# wrapper (asserting either without this fixture would be vacuous: the
# current template ships neither). A plain non-jinja file: copier copies
# it verbatim, which is all the retirement diff needs; it stays out of
# the manifest template like the other synthetic retirees.
printf 'name: All Green\non:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n' \
  > "$OLD_TREE/template/.github/workflows/all-green.yml"
# Model the fleet state before pr-title became its own natively-required
# workflow: the old build rendered no pr-title.yml (the check was a
# fleet-ci job), so the update below is what must land it. Its manifest
# append line goes with the file, like the verdict path above.
rm "$OLD_TREE/template/.github/workflows/pr-title.yml.jinja"
grep -vF "workflows/pr-title.yml" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  > "$OLD_TREE/manifest.jinja.tmp"
mv "$OLD_TREE/manifest.jinja.tmp" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja"
# Model the fleet state before .repo-platform.yml became a repo-owned
# starter: the old template rendered it MANAGED - the managed header, a
# hash-stamped manifest entry, and no _skip_if_exists protection - so the
# update below is what must flip the manifest entry to a hash-free
# starter, reword the stale header exactly once, and stop rewriting the
# repo-edited file (asserted after the update).
cat > "$OLD_TREE/template/.repo-platform.yml.jinja" <<'OLD_REG'
# This file is managed by {{ github_username }}/repo-platform. Its presence
# marks this repository as participating in push sync. `modules` is this
# repo's module selection - edit it and the next sync applies the change.

modules: {{ modules | tojson }}
OLD_REG
sed 's|"\.repo-platform\.yml": {"class": "starter"}|".repo-platform.yml": {"class": "managed", "hash": null}|' \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  > "$OLD_TREE/manifest.reg.tmp"
mv "$OLD_TREE/manifest.reg.tmp" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja"
grep -qF '".repo-platform.yml": {"class": "managed", "hash": null}' \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  || fail "could not model the pre-flip managed .repo-platform.yml manifest entry"
grep -v '^  - \.repo-platform\.yml$' "$OLD_TREE/copier.yml" > "$OLD_TREE/copier.reg.tmp"
mv "$OLD_TREE/copier.reg.tmp" "$OLD_TREE/copier.yml"
if grep -q '\.repo-platform\.yml' "$OLD_TREE/copier.yml"; then
  fail "could not strip .repo-platform.yml from the old fixture's _skip_if_exists"
fi
cat > "$OLD_TREE/template/.github/workflows/ci.yml.jinja" <<'LEGACY_CI'
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  checks:
    uses: ./.github/workflows/checks.yml
  legacy-gate:
    runs-on: ubuntu-latest
    steps:
      - run: echo legacy inline gate job
{%- if enable_codeql %}
  # The pre-inversion public-only machinery the visibility-flip leg
  # watches: rendered only while enable_codeql held, stripped by the flip.
  codeql-javascript:
    runs-on: ubuntu-latest
    steps:
      - run: echo legacy codeql analysis
{%- endif %}
  all-green:
    if: always()
    runs-on: ubuntu-latest
    needs: [checks, legacy-gate]
    steps:
      - run: echo legacy aggregate gate
  info-release:
    needs: [checks, legacy-gate]
    uses: ./.github/workflows/release.yml
    secrets: inherit
LEGACY_CI
# Model the fleet state before the versioned-pages cutover: the old
# template's pages.yml spoke reusable-pages' retired production/staging
# interface. Plain content by design - the era's copier questions are gone,
# so the retired values ride verbatim, which is all the managed re-render
# (and the answers-file drop the leg below asserts) needs.
cat > "$OLD_TREE/template/.github/workflows/pages.yml.jinja" <<'LEGACY_PAGES'
# This file is managed by {{ github_username }}/repo-platform.
# Local edits may be replaced during template updates.
name: Pages

on:
  push:
    branches: [main]
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    uses: {{ github_username }}/repo-platform/.github/workflows/reusable-pages.yml@main
    with:
      setup: {{ pages_setup }}
      install_command: {{ pages_install_command | tojson }}
      build_command: {{ pages_build_command | tojson }}
      dist_dir: {{ pages_dist_dir | tojson }}
      production: main
      staging: false
    permissions:
      contents: read
      pages: write
      id-token: write
LEGACY_PAGES
commit_build_tree "$OLD_TREE" "$prev"
echo "Testing upgrade path ${prev} -> fresh build"

copier copy "$GITHUB_WORKSPACE" "$PROJECT" \
  --vcs-ref "$prev" --defaults --trust \
  -d project_name="Upgrade Test" \
  -d description="Upgrade-path project" \
  -d 'modules=[agents, uv, release-please, issue-templates, pr-title, auto-assign, settings-sync]' \
  -d private="false"

# The fixture must actually contain the files whose deletion is under test.
cd "$PROJECT"
test -f .github/settings.yml || fail "fixture render is missing .github/settings.yml"
test -f .github/workflows/settings-sync.yml || fail "fixture render is missing settings-sync.yml"
test -f .github/retired-sentinel.txt || fail "synthetic fixture is missing the retired sentinel"
test -f .github/workflows/rerun-copilot-gate.yml \
  || fail "synthetic fixture is missing the retired rerun-copilot-gate.yml"
# ...and predate the files whose ARRIVAL is under test while carrying the
# machinery whose RETIREMENT is under test.
test -f .github/workflows/all-green.yml \
  || fail "the synthetic old fixture must carry the retired verdict wrapper (or the deletion assertion below is vacuous)"
test ! -e .github/workflows/pr-title.yml \
  || fail "the synthetic old fixture must predate the standalone pr-title.yml workflow"
if grep -qF "fleet-ci.yml" .github/workflows/ci.yml; then
  fail "the synthetic old fixture must predate the fleet-ci caller (or the single-call arrival assertion below is vacuous)"
fi
grep -qxF "  all-green:" .github/workflows/ci.yml \
  || fail "the synthetic old fixture must carry the legacy all-green aggregate job"
grep -q '^# This file is managed by Vivswan/repo-platform\. Its presence$' .repo-platform.yml \
  || fail "the synthetic old fixture must render the pre-flip managed registration header (or the ownership-flip assertions below are vacuous)"
grep -qF '".repo-platform.yml": {"class": "managed"' .github/repo-platform-manifest.json \
  || fail "the synthetic old fixture's manifest must class .repo-platform.yml managed (or the flip assertions below are vacuous)"
grep -qxF "  info-release:" .github/workflows/ci.yml \
  || fail "the synthetic old fixture must carry the legacy in-ci info-release job (or the release-home-move assertions below are vacuous)"
[ "$(cat LICENSE)" = "Old fleet license (pre-relicense fixture)" ] \
  || fail "synthetic fixture did not render the old fleet license"
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
# - retired-sentinel.txt left the render between the builds; it is
#   resurrected after the update so its deletion provably comes from
#   retired_cleanup.ts
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
echo "# local sentinel note" >> .github/retired-sentinel.txt
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
# The edited registration file, for the ownership-flip byte assertions
# after the update (the sync must stop rewriting it).
cp .repo-platform.yml "$WORK/registration-edited.yml"
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: local modifications"

# Assemble the would-be next release INTO THE WORKSPACE CLONE, chained
# onto the previous build tag (see commit_build_tree) + a local tag.
cd "$GITHUB_WORKSPACE"
bun .github/scripts/build-branches/branch_tree.ts --dest "$NEXT_TREE"
commit_build_tree "$NEXT_TREE" "$NEW_TAG" "$prev"
git show "${prev}:copier.yml" > "$WORK/copier-old.yml"
git show "$NEW_TAG":copier.yml > "$WORK/copier-new.yml"

# Module selection exactly as reusable-template-sync computes it: the
# target's .repo-platform.yml filtered against the new template's choices.
MODULES="$(select_modules \
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
export PRIVATE=false
export DESCRIPTION="Upgraded description"

# The -d data mirrors reusable-template-sync: the update runs through the
# same apply_update.ts wrapper the workflow uses, with the filtered
# modules plus live private/description, so drift in any of them
# re-renders.
export TARGET_DIR="$PROJECT"
export TARGET_REF="$NEW_TAG"
# THE ANSWERS-FILE MOVE (one-shot transition): the old fixture recorded its
# answers at the retired root path; replay the workflow's relocate step and
# prove the move is byte-for-byte BEFORE the update runs - the recorded
# answers are load-bearing (the old-render replay feeds them to copier
# verbatim), so the bytes must ride the move untouched.
test -f "$PROJECT/.copier-answers.yml" \
  || fail "the synthetic old fixture must record its answers at the retired root path (or the move assertions below are vacuous)"
test ! -e "$PROJECT/.github/.copier-answers.yml" \
  || fail "the synthetic old fixture already carries .github/.copier-answers.yml"
cp "$PROJECT/.copier-answers.yml" "$WORK/answers-before-move.yml"
RUNNER_TEMP="$WORK" bun .github/scripts/sync/relocate_answers.ts \
  || fail "relocate_answers.ts failed on a root-vintage answers file"
test ! -e "$PROJECT/.copier-answers.yml" \
  || fail "the answers-file move left the root copy behind"
cmp -s "$WORK/answers-before-move.yml" "$PROJECT/.github/.copier-answers.yml" \
  || fail "the answers-file move did not carry the recorded answers byte-for-byte"
grep -qF "ANSWERS FILE MOVE" "$WORK/answers-move.md" \
  || fail "the answers-file move did not write its PR-body note"
[ -z "$(git -C "$PROJECT" status --porcelain)" ] \
  || fail "the answers-file move left the tree dirty (copier update refuses a dirty tree)"
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$WORK/dropped-local-hunks.md" --root "$PROJECT"

# Retired-file cleanup runs the workflow's own script, pointed at the
# project through TARGET_DIR, with RUNNER_TEMP set to $WORK where the
# copier.yml snapshots already sit (resolve_refs.ts writes them there in
# the workflow).
answers_old="$(git -C "$PROJECT" show HEAD:.github/.copier-answers.yml)"
src_path="$(sed -n 's/^_src_path: //p' <<<"$answers_old")"
test -n "$src_path" || fail ".github/.copier-answers.yml records no _src_path"
old_commit="$(awk '$1 == "_commit:" { print $2 }' <<<"$answers_old")"
[ "$old_commit" = "$prev" ] || fail "recorded _commit '${old_commit}' is not ${prev}"
# Current copier already deletes the de-rendered sentinel during update, so
# without help the rm loop below would run over an empty set and pass even
# if it were broken. Resurrect the file the way an older copier (or a merge
# driver) can leave it, so the loop must really delete it. Same for the
# retired managed rerun-copilot-gate.yml: its retirement must provably come
# from retired_cleanup, not only from copier's own delete.
echo "retired sentinel" > "$PROJECT/.github/retired-sentinel.txt"
printf 'name: Rerun Copilot Gate\non: [pull_request_review]\n' \
  > "$PROJECT/.github/workflows/rerun-copilot-gate.yml"
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
grep -qF '.github/retired-sentinel.txt' "$WORK/retired-paths.json" \
  || fail "retired_paths did not flag the sentinel that left the render"
grep -qF '.github/retired-sentinel.txt' "$WORK/removed-paths.txt" \
  || fail "retired_cleanup's rm loop did not delete the resurrected sentinel"
grep -qF '.github/workflows/rerun-copilot-gate.yml' "$WORK/retired-paths.json" \
  || fail "retired_paths did not flag the retired rerun-copilot-gate.yml"
grep -qF '.github/workflows/rerun-copilot-gate.yml' "$WORK/removed-paths.txt" \
  || fail "retired_cleanup's rm loop did not delete the resurrected rerun-copilot-gate.yml"

# The workflow's preserve step: settings.yml and the opted-out LICENSE are
# repo-owned; if the update de-rendered and deleted either, it comes back
# from the base commit.
RECOVER="" RUNNER_TEMP="$WORK" bun .github/scripts/sync/preserve_repo_owned.ts

# The workflow's final stamping step: conflict resolution and the preserve
# steps can rewrite files after copier's own post-render hook stamped the
# ownership manifest, so the sync stamps once more when the tree is final.
TARGET_DIR="$PROJECT" bun actions/shared/stamp_manifest.ts

bun install --frozen-lockfile --cwd "$GITHUB_WORKSPACE/actions/validate-template"
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$PROJECT"

cd "$PROJECT"
# _commit must record the build tag (git describe lands exactly on it).
grep -qF "_commit: $NEW_TAG" .github/.copier-answers.yml \
  || fail ".github/.copier-answers.yml does not record $NEW_TAG"
# Files the template retired must be gone: settings-sync.yml left the
# render with the module deselection, the synthetic sentinel left the
# template between builds despite its local edit, and the managed
# rerun-copilot-gate.yml was retired outright when the Copilot review
# wait moved into the ruleset's required checks.
for f in .github/workflows/settings-sync.yml .github/retired-sentinel.txt \
  .github/workflows/rerun-copilot-gate.yml; do
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
# THE OWNERSHIP FLIP (managed -> repo-owned starter): the update must stop
# rewriting the repo-edited registration file - the whole body from the
# `modules:` line down rides byte-identical (the comparison anchors on
# content, not header line counts) - reword the stale rendered header to
# the starter wording, flip its manifest entry to a hash-free starter, and
# land the one-run transition note for the PR body.
sed -n '/^modules:/,$p' "$WORK/registration-edited.yml" > "$WORK/registration-body-expected.txt"
sed -n '/^modules:/,$p' .repo-platform.yml > "$WORK/registration-body-actual.txt"
test -s "$WORK/registration-body-expected.txt" \
  || fail "the edited registration capture has no modules line (the byte assertion below would be vacuous)"
cmp -s "$WORK/registration-body-expected.txt" "$WORK/registration-body-actual.txt" \
  || fail "the repo-edited .repo-platform.yml body did not ride through the ownership flip byte-identical"
if grep -q 'This file is managed by' .repo-platform.yml; then
  fail ".repo-platform.yml still opens with the stale managed header after the flip"
fi
grep -q '^# Generated once by Vivswan/repo-platform' .repo-platform.yml \
  || fail ".repo-platform.yml was not reworded to the starter header"
grep -qF '".repo-platform.yml": {"class": "starter"}' .github/repo-platform-manifest.json \
  || fail "the manifest entry for .repo-platform.yml did not flip to a hash-free starter"
if grep -F '".repo-platform.yml"' .github/repo-platform-manifest.json | grep -q '"hash"'; then
  fail "the .repo-platform.yml manifest entry still carries a hash after the flip"
fi
grep -qF 'repo-owned now' "$WORK/registration-flip.md" \
  || fail "the ownership-flip transition note was not written for the PR body"
grep -qF 'was reworded' "$WORK/registration-flip.md" \
  || fail "the transition note does not name the header reword"
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
# Public-only community files must be in the updated render (they arrive
# via the update when the old fixture predates them), and the single-call
# ci.yml must land the in-run gate across the update.
test -f CONTRIBUTING.md || fail "CONTRIBUTING.md is missing after the public update"
test -f CODE_OF_CONDUCT.md || fail "CODE_OF_CONDUCT.md is missing after the public update"
grep -qF -- "repo-platform/.github/workflows/fleet-ci.yml@build" .github/workflows/ci.yml \
  || fail "ci.yml does not call fleet-ci at the build ref after the update"
# The GATE REWORK: the update must DELETE the retired verdict wrapper and
# land the all-green gate job in ci.yml - its own check run is the
# required check now, judged through the shared action at the build ref.
test ! -e .github/workflows/all-green.yml \
  || fail "the retired all-green.yml verdict wrapper survived the update"
grep -qxF -- "  all-green:" .github/workflows/ci.yml \
  || fail "the updated ci.yml lacks the all-green gate job"
grep -qxF -- "    needs: [checks, ci]" .github/workflows/ci.yml \
  || fail "the updated all-green job does not need both caller jobs"
grep -qxF -- "    if: always()" .github/workflows/ci.yml \
  || fail "the updated all-green job is not unconditional over failures (if: always())"
grep -qF -- "repo-platform/actions/all-green@build" .github/workflows/ci.yml \
  || fail "the updated all-green job does not judge through the shared action at the build ref"
# The release job's home: the update must strip the legacy in-ci
# info-release job and land the gate-downstream release leg in ci.yml,
# passing the judged sha into a release.yml that declares and reads the
# input.
if grep -qF -- "info-release" .github/workflows/ci.yml; then
  fail "the updated ci.yml still carries the retired info-release job"
fi
grep -qxF -- "  release:" .github/workflows/ci.yml \
  || fail "the updated ci.yml lacks the release leg (release-please is selected)"
grep -qxF -- "    needs: [all-green]" .github/workflows/ci.yml \
  || fail "the updated release leg does not run downstream of the gate"
grep -qxF -- "      needs.all-green.result == 'success' &&" .github/workflows/ci.yml \
  || fail "the updated release leg is not gated on the all-green result"
grep -qxF -- '      sha: ${{ github.sha }}' .github/workflows/ci.yml \
  || fail "the updated release leg does not pass the judged sha to release.yml"
grep -qxF -- '          JUDGED: ${{ inputs.sha || github.sha }}' .github/workflows/release.yml \
  || fail "the updated release.yml head gate does not read the judged sha input"
# The update must PRESERVE the repo's configuration, not reset it.
grep -qF -- "## Python " .gitignore || fail ".gitignore lost the uv module section"
grep -qF -- 'package-ecosystem: "uv"' .github/dependabot.yml \
  || fail "dependabot.yml lost the uv module entry"
grep -qF -- '"pr-title"' .github/workflows/ci.yml \
  || fail "ci.yml's fleet-ci modules input lost pr-title"
# pr-title's own natively-required workflow must ARRIVE with the update
# (the old fixture predates it - the check was a fleet-ci job).
test -f .github/workflows/pr-title.yml \
  || fail "the standalone pr-title.yml workflow did not arrive with the update"
grep -qxF -- "    types: [opened, edited, reopened, synchronize]" .github/workflows/pr-title.yml \
  || fail "the updated pr-title.yml lacks the full trigger types list (the required check must exist at every pushed head)"
test -f AGENTS.md || fail "AGENTS.md is missing"
grep -qF "description: Upgraded description" .github/.copier-answers.yml \
  || fail "the live description was not applied"
# No copier leftovers: neither inline conflict markers nor .rej files.
marker="$(printf '<%.0s' 1 2 3 4 5 6 7) before updating"
if grep -rIqF "$marker" . --exclude-dir=.git; then
  fail "unresolved copier conflict markers remain"
fi
if find . -name '*.rej' -not -path './.git/*' | grep -q .; then
  fail "copier left .rej files behind"
fi
# The ownership manifest survives the update stamped for the NEW tree:
# entries follow the new selection (settings-sync deselected, the
# custom-license opt-out de-rendering LICENSE.md), starters stay hashless,
# the managed ci.yml hash matches the updated file byte-for-byte, and the
# manifest's own entry stays null (its content includes every other hash,
# so a self-hash would be circular). Read with python3, independent of the
# stamping code under test.
test -f .github/repo-platform-manifest.json || fail "the ownership manifest is missing after the update"
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
[ "$(mf ".github/workflows/ci.yml" class)" = "managed" ] \
  || fail "the manifest lost ci.yml's managed entry across the update"
[ "$(mf ".github/workflows/settings-sync.yml" class)" = "absent" ] \
  || fail "the manifest still lists settings-sync.yml after the module deselection"
[ "$(mf "LICENSE.md" class)" = "absent" ] \
  || fail "the manifest still lists LICENSE.md despite the custom-license opt-out"
[ "$(mf ".github/workflows/checks.yml" class)" = "starter" ] \
  || fail "the manifest lost the checks.yml starter entry"
[ "$(mf ".github/workflows/checks.yml" hash)" = "missing" ] \
  || fail "the manifest hashes the repo-owned checks.yml starter"
[ "$(mf ".github/workflows/ci.yml" hash)" = "$(file_sha .github/workflows/ci.yml)" ] \
  || fail "the manifest's ci.yml hash does not match the updated file (stamping)"
[ "$(mf ".github/repo-platform-manifest.json" hash)" = "null" ] \
  || fail "the manifest's own hash entry must stay null (self-hash is circular)"
# Provenance rides the self entry: the stamper writes the render's recorded
# _commit, which is what lets the validator tell skew from deletion.
[ "$(mf ".github/repo-platform-manifest.json" commit)" = "$NEW_TAG" ] \
  || fail "the manifest's provenance commit was not stamped with the updated render's _commit"
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
sed 's/^_commit: .*/_commit: deadbeef/' .github/.copier-answers.yml > .github/.copier-answers.yml.tmp
mv .github/.copier-answers.yml.tmp .github/.copier-answers.yml
echo "# local ci note" >> .github/workflows/ci.yml
# The registration starter must hold under recopy --overwrite too: the
# repo-owned `mirrors` declaration lives in it, and a recopy that
# re-rendered the file would silently drop the key (the class the retired
# restoreMirrorsKey restore path existed for - retired BECAUSE this holds).
printf 'mirrors:\n  - source: SECURITY.md\n    targets:\n      - copies/SECURITY.md\n' \
  >> .repo-platform.yml
cp .repo-platform.yml "$WORK/registration-before-recopy.yml"
# Sanctioned repository-owned content the local-content carry must bring
# back over the re-render (unlike the ci.yml edit above, which must drop):
# tails below the END markers of AGENTS.md, CONTRIBUTING.md,
# .editorconfig, and .github/CODEOWNERS, plus a .gitignore entry ABOVE the
# managed BEGIN marker (the repo owns both sides of the region).
echo "recovery-local agents note" >> AGENTS.md
echo "recovery-local contributing note" >> CONTRIBUTING.md
printf '[recovery-local/**.js]\nindent_size = 3\n' >> .editorconfig
echo "/recovery-local/ @recovery-local-owner" >> .github/CODEOWNERS
awk '/^# BEGIN REPO-PLATFORM MANAGED$/ && !done { print "recovery-local-cache/"; done = 1 } { print }' .gitignore > .gitignore.tmp
mv .gitignore.tmp .gitignore
# ... and the appendix path: strip .gitattributes' marker pair (a copy
# hand-edited past recognition), so the carry cannot split it and must
# keep the whole previous copy below a marked recovery-appendix comment.
echo "recovery-local-attr binary" >> .gitattributes
sed '/^# BEGIN REPO-PLATFORM MANAGED$/d; /^# END REPO-PLATFORM MANAGED$/d' .gitattributes > .gitattributes.tmp
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
TARGET_DIR="$PROJECT" bun "$GITHUB_WORKSPACE/actions/shared/stamp_manifest.ts"

grep -qF "_commit: $NEW_TAG" .github/.copier-answers.yml \
  || fail "recovery did not re-record _commit as $NEW_TAG"
grep -qF "# local checks note" .github/workflows/checks.yml \
  || fail "recovery overwrote the generated-once checks.yml (_skip_if_exists must hold under recopy --overwrite)"
grep -qF "# local issue form note" .github/ISSUE_TEMPLATE/bug_report.yml \
  || fail "recovery overwrote the generated-once bug_report.yml (_skip_if_exists must hold under recopy --overwrite)"
cmp -s "$WORK/registration-before-recopy.yml" .repo-platform.yml \
  || fail "recovery rewrote the repo-owned .repo-platform.yml (_skip_if_exists must hold under recopy --overwrite, or the mirrors declaration is silently lost)"
if [ -s "$WORK/registration-flip.md" ]; then
  fail "the ownership-flip transition note re-fired although HEAD's manifest already classes .repo-platform.yml starter (the trigger must be one-run)"
fi
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
  || fail "recovery lost .gitignore's repo-owned entry above the managed region (local-content carry)"
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
# The recopy carry steps run after copier's own stamp hook, so the final
# stamp must leave the managed ci.yml hash matching the re-rendered file.
[ "$(mf ".github/workflows/ci.yml" hash)" = "$(file_sha .github/workflows/ci.yml)" ] \
  || fail "recovery left the manifest's ci.yml hash stale (stamping after recopy)"
echo "recovery recopy OK: skip_if_exists, repo-owned files, and repo-local content preserved, managed files re-rendered"

# --- Visibility flip (public -> private) --------------------------------
# The transition machinery issue #25's fix leans on: an update where the
# live visibility changed between syncs must drop the conditional-filename
# CONTRIBUTING.md render, leave the repo-owned settings.yml starter alone
# (the managed baseline follows live visibility centrally), and
# strip the codeql machinery from ci.yml. Runs on a fresh public fixture
# through the same workflow scripts as the main leg, with settings-sync
# KEPT selected - only the visibility changes.
VIS="$RUN_DIR/upgrade-vis"
VIS_WORK="$RUN_DIR/upgrade-vis-work"
mkdir -p "$VIS_WORK"

cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$VIS" \
  --vcs-ref "$prev" --defaults --trust \
  -d project_name="Visibility Flip" \
  -d description="Visibility-flip project" \
  -d 'modules=[bun, settings-sync]' \
  -d private="false"

# The fixture must carry the public-only machinery whose removal is under
# test.
cd "$VIS"
test -f SECURITY.md || fail "public fixture render is missing SECURITY.md"
# The old fixture is always synthetic (built from the current tree), so the
# newer public-only artifacts are always present; assert them directly.
test -f CONTRIBUTING.md || fail "public fixture render is missing CONTRIBUTING.md"
test -f CODE_OF_CONDUCT.md || fail "public fixture render is missing CODE_OF_CONDUCT.md"
# The identity starter (repo-owned; the managed settings baseline is
# computed centrally, so no rulesets or labels render here).
grep -qxF "  private: false" .github/settings.yml \
  || fail "public fixture settings.yml does not declare private: false"
# The pre-inversion public bun fixture carries the legacy codeql job (the
# public-only machinery whose removal-through-the-update is under test).
grep -qxF "  codeql-javascript:" .github/workflows/ci.yml \
  || fail "public fixture ci.yml is missing the legacy codeql machinery"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# A divergent license WITHOUT the custom-license opt-out: the fleet
# license must win - the old fixture ships the extensionless LICENSE, so
# the update crosses the LICENSE -> LICENSE.md rename with divergent local
# content in the old spelling.
echo "Divergent unopted license" > LICENSE
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: divergent license"

# Same pipeline as the main leg, but the live data says PRIVATE=true while
# the recorded answers still say false - the drift the sync re-renders.
cd "$GITHUB_WORKSPACE"
git show "${prev}:copier.yml" > "$VIS_WORK/copier-old.yml"
git show "$NEW_TAG":copier.yml > "$VIS_WORK/copier-new.yml"
MODULES="$(select_modules \
  --repo-file "$VIS/.repo-platform.yml" \
  --template-copier "$VIS_WORK/copier-new.yml" \
  --retired-summary "$VIS_WORK/retired-modules.txt")"
export MODULES
export PRIVATE=true
export DESCRIPTION="Visibility-flip project"
export TARGET_DIR="$VIS"
export TARGET_REF="$NEW_TAG"
# The fixture rendered at the pre-move ref: replay the answers-file move
# (asserted byte-for-byte in the main leg; here it just must not break the
# rest of the pipeline).
RUNNER_TEMP="$VIS_WORK" bun .github/scripts/sync/relocate_answers.ts
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$VIS_WORK/dropped-local-hunks.md" --root "$VIS"

# Current copier already deletes the de-rendered CONTRIBUTING.md during
# the update; resurrect it (the sentinel trick above) so retired_cleanup's
# data-driven old/new render diff - old render private=false from the
# recorded answers, new render private=true from the live data - must
# really flag and delete it.
echo "# Contributing" > "$VIS/CONTRIBUTING.md"
answers_vis="$(git -C "$VIS" show HEAD:.github/.copier-answers.yml)"
src_path_vis="$(sed -n 's/^_src_path: //p' <<<"$answers_vis")"
test -n "$src_path_vis" || fail "visibility fixture records no _src_path"
RUNNER_TEMP="$VIS_WORK" SRC_PATH="$src_path_vis" \
  OLD_SHA="$(git rev-parse "${prev}^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
grep -qF '"CONTRIBUTING.md"' "$VIS_WORK/retired-paths.json" \
  || fail "retired_paths did not flag CONTRIBUTING.md on the public->private flip"
grep -qxF "CONTRIBUTING.md" "$VIS_WORK/removed-paths.txt" \
  || fail "retired_cleanup's rm loop did not delete the resurrected CONTRIBUTING.md"
RECOVER="" RUNNER_TEMP="$VIS_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
TARGET_DIR="$VIS" bun actions/shared/stamp_manifest.ts
# Deleting a split-classed file takes its repository-owned half with it,
# so the removals must raise the removed-splits hold that keeps the PR
# manual: the old extensionless LICENSE (no manifest entry classes it -
# the pointwise license candidate) and CONTRIBUTING.md (class `split` at
# HEAD - the general class-level rule).
test -s "$VIS_WORK/removed-splits.md" \
  || fail "the split-file deletions did not raise the removed-splits hold that keeps the PR manual"
grep -qF '`LICENSE`' "$VIS_WORK/removed-splits.md" \
  || fail "the removed-splits hold does not name the deleted LICENSE"
grep -qF '`CONTRIBUTING.md`' "$VIS_WORK/removed-splits.md" \
  || fail "the removed-splits hold does not name the deleted split-classed CONTRIBUTING.md"

bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$VIS"

cd "$VIS"
# SECURITY.md is visibility-independent since the ungating: it must
# survive the flip.
test -f SECURITY.md || fail "SECURITY.md did not survive the flip to private"
# No verdict wrapper on any visibility, and the release leg is
# release-please-gated; this fixture selects no release-please, so no
# leg may render next to the gate.
test ! -e .github/workflows/all-green.yml \
  || fail "the flipped render carries the retired all-green.yml verdict wrapper"
if grep -qxF -- "  release:" .github/workflows/ci.yml; then
  fail "the flipped ci.yml carries a release leg without the release-please module"
fi
# The public-only base files and gates must retire on the flip; the
# license is visibility-independent and (without custom-license)
# template-managed, so LICENSE.md must converge to the fleet license -
# this is the migration path a relicensing (and the LICENSE -> LICENSE.md
# rename) takes through a real sync, deleting the old spelling.
test ! -e CONTRIBUTING.md || fail "CONTRIBUTING.md survived the flip to private"
test ! -e CODE_OF_CONDUCT.md || fail "CODE_OF_CONDUCT.md survived the flip to private"
# The manifest's visibility-gated entries must retire with the flip (its
# entries render under the same `not private` gates as the files).
[ "$(mf "CONTRIBUTING.md" class)" = "absent" ] \
  || fail "the manifest still lists CONTRIBUTING.md after the flip to private"
# Assign first: a failed substitution inside a case WORD does not trip
# errexit, and an empty pattern would collapse to a match-everything *.
fleet_license="$(rendered_fleet_license)"
[ -n "$fleet_license" ] || fail "could not render the fleet license"
case "$(cat LICENSE.md)" in
  "$fleet_license"*) ;;
  *) fail "the fleet license is not a prefix of LICENSE.md after the flip to private" ;;
esac
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
if ! grep -qxF "      private: true" .github/workflows/ci.yml; then
  fail "ci.yml does not pass private: true to fleet-ci after the flip"
fi
# settings.yml is a repo-owned starter: the flip must NOT rewrite it (the
# managed baseline follows live visibility centrally; the file keeps the
# repo's own declarations, drift surfacing via the settings-drift report).
grep -qxF "  private: false" .github/settings.yml \
  || fail "the repo-owned settings.yml was rewritten by the flip (it must keep its declarations)"
# The other always-declared identity keys survive untouched too.
grep -qxF '  homepage: ""' .github/settings.yml \
  || fail "settings.yml lost the empty homepage declaration across the update"
grep -qxF '  topics: ""' .github/settings.yml \
  || fail "settings.yml lost the empty topics declaration across the update"
# CodeQL disarms with the flip: the fleet-ci input must render empty.
if grep -qF "javascript-typescript" .github/workflows/ci.yml; then
  fail "ci.yml kept the javascript-typescript CodeQL language after the flip to private"
fi
grep -qxF "      codeql-languages: '[]'" .github/workflows/ci.yml \
  || fail "ci.yml does not disarm the CodeQL matrix (codeql-languages '[]') after the flip"
if grep -rIqF "$marker" . --exclude-dir=.git; then
  fail "the visibility flip left unresolved copier conflict markers"
fi
if find . -name '*.rej' -not -path './.git/*' | grep -q .; then
  fail "the visibility flip left .rej files behind"
fi
echo "visibility flip OK: CONTRIBUTING.md retired, settings starter untouched, codeql stripped"

# --- Committed LICENSE deletion (fleet license mandatory) ----------------
# A repo still on the fleet license that committed a LICENSE deletion:
# copier honors the deletion when it re-applies the local diff, cleanup
# never lists the path (LICENSE.md is in both renders), and HEAD has no
# copy to restore - the preserve step
# must re-seed the fleet license from the target build ref.
DEL="$RUN_DIR/upgrade-del"
cd "$GITHUB_WORKSPACE"
# Rendered from the NEW build: the re-seed hole only exists when the base
# already carried LICENSE.md and the local diff deletes it (a fixture on
# the old build gets LICENSE.md as a fresh render, which never needs the
# re-seed).
copier copy "$GITHUB_WORKSPACE" "$DEL" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="License Deletion" \
  -d description="License-deletion project" \
  -d 'modules=[agents]' \
  -d private="false"
cd "$DEL"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"
git rm -q LICENSE.md
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: delete LICENSE.md"
cd "$GITHUB_WORKSPACE"
export MODULES='["agents"]'
export PRIVATE=false
export DESCRIPTION="License-deletion project"
export TARGET_DIR="$DEL"
export TARGET_REF="$NEW_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$RUN_DIR/upgrade-del-hunks.md" --root "$DEL"
RECOVER="" RUNNER_TEMP="$RUN_DIR" bun .github/scripts/sync/preserve_repo_owned.ts
rendered_fleet_license | cmp -s "$DEL/LICENSE.md" - \
  || fail "a committed LICENSE deletion did not re-converge to the mandatory fleet license"
echo "license deletion OK: fleet license re-seeded"

# --- Split-file structural rebuild (regenerate-and-splice) ----------------
# The primary sync path discards copier's merged result for every
# split-class file and rebuilds it structurally: the managed half from the
# clean render at the new ref, the repository-owned sides byte-for-byte
# from HEAD (preserve_local_content.ts --render-dir, files and markers
# from the new render's ownership manifest). This leg plants a local
# AGENTS.md tail, a local .gitignore entry above the managed BEGIN, and a
# hand edit INSIDE SECURITY.md's managed region, then updates to a build
# whose template changed each file's managed region - the overlap that
# used to end in merge conflicts or merge luck. Sides must ride through
# byte-preserved, managed regions must equal render-new byte-for-byte,
# the managed-region edit must be reset and flagged for review, and no
# split file may appear in the dropped-hunks summary. Self-contained: fresh fixture, its own build tag
# (the run namespace's split tag, chained on its new tag). No trap layer of
# its own any more - the one cleanup already owns every tag in the
# namespace, and nothing of a previous run can be in the way.
SPLIT="$RUN_DIR/upgrade-split"
SPLIT_WORK="$RUN_DIR/upgrade-split-work"
NEXT_SPLIT="$RUN_DIR/next-split"
mkdir -p "$SPLIT_WORK"

cd "$GITHUB_WORKSPACE"
cp -R "$NEXT_TREE" "$NEXT_SPLIT"
# Perturb the managed region of each split file in the new build: a line
# above AGENTS.md's and SECURITY.md's END marker, a pattern inside
# .gitignore's managed region.
insert_above_sentinel() { # <file> <line>
  awk -v insert="$2" \
    '{ if ($0 == "<!-- END REPO-PLATFORM MANAGED -->" && !done) { print insert; done = 1 } print }' \
    "$1" > "$1.tmp"
  mv "$1.tmp" "$1"
  grep -qF "$2" "$1" || fail "could not perturb the managed region of $1"
}
agents_tpl="$(find "$NEXT_SPLIT/template" -maxdepth 1 -name "*AGENTS.md*.jinja" | head -n 1)"
test -n "$agents_tpl" || fail "no AGENTS.md template in the assembled build tree"
insert_above_sentinel "$agents_tpl" "Split-rebuild fixture managed line (agents)."
insert_above_sentinel "$NEXT_SPLIT/template/SECURITY.md.jinja" \
  "Split-rebuild fixture managed line (security)."
# The mirror leg's template change: the fleet LICENSE's managed region
# moves, so the materialized mirrors below must carry the NEW bytes (the
# skills#82 class: the sync rewrote only the rendered source and every
# LICENSE template change re-broke the byte-identical copies).
insert_above_sentinel "$NEXT_SPLIT/template/LICENSE.md.jinja" \
  "Split-rebuild fixture managed line (license)."
awk '{ print } $0 == "# BEGIN REPO-PLATFORM MANAGED" && !done { print "split-rebuild-fixture.tmp"; done = 1 }' \
  "$NEXT_SPLIT/template/.gitignore.jinja" > "$NEXT_SPLIT/template/.gitignore.jinja.tmp"
mv "$NEXT_SPLIT/template/.gitignore.jinja.tmp" "$NEXT_SPLIT/template/.gitignore.jinja"
grep -qxF "split-rebuild-fixture.tmp" "$NEXT_SPLIT/template/.gitignore.jinja" \
  || fail "could not perturb .gitignore's managed section"
commit_build_tree "$NEXT_SPLIT" "$SPLIT_TAG" "$NEW_TAG"

copier copy "$GITHUB_WORKSPACE" "$SPLIT" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Split Rebuild" \
  -d description="Split-rebuild project" \
  -d 'modules=[agents]' \
  -d private="false"
cd "$SPLIT"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# The local state a real repo carries into the sync: a tail below
# AGENTS.md's END marker, a .gitignore entry above the managed BEGIN, and
# - the deliberate ownership violation - a hand edit inside SECURITY.md's
# managed region.
split_tail_body='## Local agent docs

split-local agents tail'
printf '\n%s\n' "$split_tail_body" >> AGENTS.md
awk '/^# BEGIN REPO-PLATFORM MANAGED$/ && !done { print "split-local-cache/"; done = 1 } { print }' .gitignore > .gitignore.tmp
mv .gitignore.tmp .gitignore
# The expected post-update above-side: the rebuild must carry everything
# above the managed BEGIN byte-for-byte.
awk '/^# BEGIN REPO-PLATFORM MANAGED$/ { exit } { print }' .gitignore > "$SPLIT_WORK/local-expected.txt"
awk 'NR == 2 { print "split-local hand edit inside the managed region" } { print }' SECURITY.md > SECURITY.md.tmp
mv SECURITY.md.tmp SECURITY.md
grep -qF "split-local hand edit" SECURITY.md || fail "could not plant the managed-region edit"
# The mirror fixture, shaped like the skills repo: a repo-owned tail below
# LICENSE.md's END marker (the mirrors must copy the WHOLE delivered file,
# repo-owned side included), a stale copy in template/ and in one skill
# folder, a second skill folder with NO copy yet (the glob must create it
# with no declaration edit), and the repo-owned `mirrors` declaration in
# .repo-platform.yml - which must itself ride through the copier update.
printf '\nsplit-local license tail\n' >> LICENSE.md
mkdir -p skills/alpha skills/beta template
printf 'stale mirror (must be overwritten)\n' > template/LICENSE.md
printf 'stale mirror (must be overwritten)\n' > skills/alpha/LICENSE.md
printf 'name: beta\n' > skills/beta/SKILL.md
cat >> .repo-platform.yml <<'EOF'
mirrors:
  - source: LICENSE.md
    targets:
      - template/LICENSE.md
      - skills/*/LICENSE.md
EOF
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: local modifications"

# The workflow's leg order: apply update, materialize the clean renders,
# rebuild split files, resolve conflicts, retired cleanup, preserve,
# stamp, validate.
cd "$GITHUB_WORKSPACE"
export MODULES='["agents"]'
export PRIVATE=false
export DESCRIPTION="Split-rebuild project"
export TARGET_DIR="$SPLIT"
export TARGET_REF="$SPLIT_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
answers_split="$(git -C "$SPLIT" show HEAD:.github/.copier-answers.yml)"
src_path_split="$(sed -n 's/^_src_path: //p' <<<"$answers_split")"
test -n "$src_path_split" || fail "split fixture records no _src_path"
RUNNER_TEMP="$SPLIT_WORK" SRC_PATH="$src_path_split" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/clean_renders.ts
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$SPLIT_WORK/local-carryover.md" --root "$SPLIT" \
  --needs-review "$SPLIT_WORK/carry-review.txt" \
  --rebuilt-paths "$SPLIT_WORK/split-rebuilt-paths.txt" \
  --render-dir "$SPLIT_WORK/render-new" --old-render-dir "$SPLIT_WORK/render-old"
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$SPLIT_WORK/dropped-local-hunks.md" --root "$SPLIT" \
  --skip "$SPLIT_WORK/split-rebuilt-paths.txt"
git show "$NEW_TAG:copier.yml" > "$SPLIT_WORK/copier-old.yml"
git show "$SPLIT_TAG:copier.yml" > "$SPLIT_WORK/copier-new.yml"
RUNNER_TEMP="$SPLIT_WORK" SRC_PATH="$src_path_split" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
RECOVER="" RUNNER_TEMP="$SPLIT_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
# The workflow's mirror step: materialize the repo's own declared mirror
# copies from the freshly delivered tree, before the final stamp.
RUNNER_TEMP="$SPLIT_WORK" bun .github/scripts/sync/materialize_mirrors.ts --root "$SPLIT"
TARGET_DIR="$SPLIT" bun actions/shared/stamp_manifest.ts
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$SPLIT"

cd "$SPLIT"
# AGENTS.md: managed region byte-equal to render-new, the local tail
# byte-preserved below it - the whole file is exactly render-new + tail.
{ cat "$SPLIT_WORK/render-new/AGENTS.md"; printf '\n%s\n' "$split_tail_body"; } \
  | cmp -s - AGENTS.md \
  || fail "AGENTS.md is not byte-equal to render-new plus the preserved local tail"
grep -qF "Split-rebuild fixture managed line (agents)." AGENTS.md \
  || fail "AGENTS.md did not receive the template's managed-region change"
# SECURITY.md: the hand edit inside the managed region is RESET - the file
# is byte-equal to render-new, and the reset is flagged for review.
cmp -s "$SPLIT_WORK/render-new/SECURITY.md" SECURITY.md \
  || fail "SECURITY.md is not byte-equal to render-new after the managed-region reset"
if grep -qF "split-local hand edit" SECURITY.md; then
  fail "the hand edit inside SECURITY.md's managed region survived the rebuild"
fi
grep -q '^SECURITY\.md: managed-region edits reset' "$SPLIT_WORK/carry-review.txt" \
  || fail "the managed-region reset was not flagged in the carry-review file"
grep -qF 'RESET to the fresh render' "$SPLIT_WORK/local-carryover.md" \
  || fail "the carry summary does not state the managed-region reset loudly"
# The clean carries stay auto-merge-eligible: none of AGENTS.md,
# .gitignore, or LICENSE.md (its tail is a clean side-restore) may appear
# in the review flag.
if grep -qE '^(AGENTS\.md|\.gitignore|LICENSE\.md):' "$SPLIT_WORK/carry-review.txt"; then
  fail "a clean split-file carry was flagged for review"
fi
# .gitignore: the whole above-side byte-preserved, the managed region
# (BEGIN marker to end of file - nothing sits below END here) byte-equal
# to render-new's.
awk '/^# BEGIN REPO-PLATFORM MANAGED$/ { exit } { print }' .gitignore > "$SPLIT_WORK/local-actual.txt"
cmp -s "$SPLIT_WORK/local-expected.txt" "$SPLIT_WORK/local-actual.txt" \
  || fail ".gitignore's repo-owned above-side is not byte-preserved"
awk '/^# BEGIN REPO-PLATFORM MANAGED$/, 0' .gitignore > "$SPLIT_WORK/managed-actual.txt"
awk '/^# BEGIN REPO-PLATFORM MANAGED$/, 0' "$SPLIT_WORK/render-new/.gitignore" \
  > "$SPLIT_WORK/managed-expected.txt"
cmp -s "$SPLIT_WORK/managed-expected.txt" "$SPLIT_WORK/managed-actual.txt" \
  || fail ".gitignore's managed region is not byte-equal to render-new"
grep -qxF "split-rebuild-fixture.tmp" .gitignore \
  || fail ".gitignore did not receive the template's managed-region change"
# The split files never reach the conflict resolver: no split-file section
# in the dropped-hunks summary, no leftover markers. The marker is built
# here (not reused from an earlier leg) so this block stays self-contained.
split_marker="$(printf '<%.0s' 1 2 3 4 5 6 7) before updating"
if [ -s "$SPLIT_WORK/dropped-local-hunks.md" ]; then
  for f in AGENTS.md SECURITY.md .gitignore; do
    if grep -qF "\`$f\`" "$SPLIT_WORK/dropped-local-hunks.md"; then
      fail "split file $f appeared in the dropped-hunks summary"
    fi
  done
fi
if grep -rIqF "$split_marker" . --exclude-dir=.git; then
  fail "the split-file rebuild left unresolved copier conflict markers"
fi
echo "split-file rebuild OK: sides byte-preserved, managed regions byte-equal to render-new, managed-region edit reset and flagged"

# Mirror materialization (the skills#82 class): every declared mirror is
# byte-identical to the DELIVERED LICENSE.md - the fresh managed-region
# change AND the repo-owned tail included - and the glob created the copy
# the new skill folder never had, with no declaration edit. The PR-body
# note lists the writes; nothing is refused.
for m in template/LICENSE.md skills/alpha/LICENSE.md skills/beta/LICENSE.md; do
  cmp -s LICENSE.md "$m" || fail "mirror $m is not byte-identical to the delivered LICENSE.md"
done
grep -qF "Split-rebuild fixture managed line (license)." skills/alpha/LICENSE.md \
  || fail "the mirror does not carry the template's fresh managed-region change"
grep -qF "split-local license tail" skills/alpha/LICENSE.md \
  || fail "the mirror does not carry the repository-owned tail"
grep -qF '`template/LICENSE.md` <- `LICENSE.md`' "$SPLIT_WORK/mirrors.md" \
  || fail "the PR-body mirror note does not list the materialized write"
if [ -s "$SPLIT_WORK/mirrors-review.md" ]; then
  fail "clean mirror declarations were refused (mirrors-review.md is non-empty)"
fi
grep -qF 'mirrors:' .repo-platform.yml \
  || fail "the repo-owned mirrors declaration did not survive the copier update"

# (The old "recopy shape" re-run - a recovery re-render dropping the
# mirrors key from the working tree, restored from HEAD by
# restoreMirrorsKey - is structurally impossible since the registration
# file became a repo-owned starter: no sync leg rewrites an existing
# .repo-platform.yml, which the recovery leg above asserts byte-for-byte.
# The restore path was retired with it; declarationSource's HEAD preference
# keeps its own unit tests.)

# Hostile mirror declarations, committed the way a hostile repo would
# carry them (the declaration is read from HEAD): a traversal target and a
# template-owned target must be REFUSED with no write (open_pr.ts holds
# the PR for review on a non-empty mirrors-review.md).
HOSTILE_WORK="$RUN_DIR/upgrade-split-hostile"
mkdir -p "$HOSTILE_WORK"
{
  grep '^modules:' .repo-platform.yml
  cat <<'EOF'
mirrors:
  - source: LICENSE.md
    targets:
      - ../mirror-escape.md
      - SECURITY.md
EOF
} > .repo-platform.yml.tmp
mv .repo-platform.yml.tmp .repo-platform.yml
git add .repo-platform.yml
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: hostile mirror fixture"
RUNNER_TEMP="$HOSTILE_WORK" \
  bun "$GITHUB_WORKSPACE/.github/scripts/sync/materialize_mirrors.ts" --root "$SPLIT"
test ! -e "$RUN_DIR/mirror-escape.md" || fail "a traversal mirror target escaped the repository"
cmp -s "$SPLIT_WORK/render-new/SECURITY.md" SECURITY.md \
  || fail "a template-owned mirror target was overwritten"
[ -s "$HOSTILE_WORK/mirrors-review.md" ] || fail "hostile mirror declarations were not refused"
grep -qF 'SECURITY.md' "$HOSTILE_WORK/mirrors-review.md" \
  || fail "the refusal report does not name the template-owned target"
echo "mirror materialization OK: byte-identical copies, glob-created skill copy, hostile declarations refused"

# --- Unselected-path preservation (conditional landing via _exclude) ------
# The composed tree carries plain filenames; conditional landing happens
# through copier.yml's generated _exclude patterns, which must reproduce
# the retired filename-gate semantics EXACTLY: a path whose gates do not
# hold is never rendered, so a repo's OWN file at such a path - its
# custom-license LICENSE.md, a home-grown nightly.yml without the nightly
# module - survives every update byte-identical. A post-render deletion
# scheme would destroy exactly these files; this leg pins that class shut.
# Runs NEW_TAG -> SPLIT_TAG, a real content-changed build, through the
# workflow's own scripts.
UNSEL="$RUN_DIR/upgrade-unselected"
UNSEL_WORK="$RUN_DIR/upgrade-unselected-work"
mkdir -p "$UNSEL_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$UNSEL" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Unselected Paths" \
  -d description="Unselected-path project" \
  -d 'modules=[agents, custom-license]' \
  -d private="false"
cd "$UNSEL"
# The unselected paths must not have rendered in the first place.
test ! -e LICENSE.md || fail "the fleet LICENSE.md rendered despite the custom-license opt-out"
test ! -e .github/workflows/nightly.yml || fail "nightly.yml rendered without the nightly module"
echo "Repo-owned custom license (unselected-path leg)" > LICENSE.md
printf 'name: repo-own nightly\non: workflow_dispatch\n' > .github/workflows/nightly.yml
cp LICENSE.md "$UNSEL_WORK/license-before.md"
cp .github/workflows/nightly.yml "$UNSEL_WORK/nightly-before.yml"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with repo-owned files"
cd "$GITHUB_WORKSPACE"
export MODULES='["agents", "custom-license"]'
export PRIVATE=false
export DESCRIPTION="Unselected-path project"
export TARGET_DIR="$UNSEL"
export TARGET_REF="$SPLIT_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$UNSEL_WORK/dropped-local-hunks.md" --root "$UNSEL"
answers_unsel="$(git -C "$UNSEL" show HEAD:.github/.copier-answers.yml)"
src_path_unsel="$(sed -n 's/^_src_path: //p' <<<"$answers_unsel")"
test -n "$src_path_unsel" || fail "unselected-path fixture records no _src_path"
git show "$NEW_TAG:copier.yml" > "$UNSEL_WORK/copier-old.yml"
git show "$SPLIT_TAG:copier.yml" > "$UNSEL_WORK/copier-new.yml"
RUNNER_TEMP="$UNSEL_WORK" SRC_PATH="$src_path_unsel" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
RECOVER="" RUNNER_TEMP="$UNSEL_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
TARGET_DIR="$UNSEL" bun actions/shared/stamp_manifest.ts
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$UNSEL"
cd "$UNSEL"
cmp -s "$UNSEL_WORK/license-before.md" LICENSE.md \
  || fail "the repo-owned LICENSE.md at the unselected path was not byte-identical after the update"
cmp -s "$UNSEL_WORK/nightly-before.yml" .github/workflows/nightly.yml \
  || fail "the repo-owned nightly.yml at the unselected starter path was not byte-identical after the update"
if grep -qF 'LICENSE.md' "$UNSEL_WORK/retired-paths.json"; then
  fail "retired_paths listed the repo-owned LICENSE.md (custom-license protectedPaths)"
fi
if grep -qF 'nightly.yml' "$UNSEL_WORK/retired-paths.json"; then
  fail "retired_paths listed the repo-owned nightly.yml (unselected in both renders)"
fi
echo "unselected-path preservation OK: repo-owned files at unselected template paths survive byte-identical"

# --- settings.yml layering transition (customized client) ----------------
# A repo generated before the two-layer settings model carries the full
# old baseline in a settings.yml still marked with the retired mergeable
# class, customized with its own topics and one extra label. The sync must
# REPLACE the file with the identity starter - custom topics carried over,
# and the description seeded from the freshly recorded answers, because
# this fixture deliberately declares none (the FALLBACK leg; the
# declared-wins leg is exercised below) - and list the
# extra label (the only declaration differing from the computed managed
# baseline) in the PR-body section that holds the PR for review. Fixture
# on the NEW build: the legacy file shape is planted by hand, because no
# current template renders it.
SET="$RUN_DIR/upgrade-settings"
SET_WORK="$RUN_DIR/upgrade-settings-work"
mkdir -p "$SET_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$SET" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Settings Transition" \
  -d description="Settings-transition project" \
  -d 'modules=[uv, settings-sync]' \
  -d private="false"
cd "$SET"
# The freshly rendered starter must NOT carry the retired marker (the
# transition would otherwise re-fire on every sync).
if grep -qxF "# repo-platform:mergeable" .github/settings.yml; then
  fail "the settings-sync starter still renders the retired mergeable marker"
fi
# Plant the legacy baseline file: the retired marker, the identity keys
# with custom topics, one baseline-equal policy key, and the labels the
# old template rendered plus one deliberate extra.
cat > .github/settings.yml <<'LEGACY'
---
# Rendered by the settings-sync module (legacy baseline shape).
# repo-platform:mergeable
repository:
  homepage: ""
  topics: kept, custom, topics
  private: false
  has_issues: true
labels:
  - name: dependencies
    color: "0366d6"
    description: Dependency updates
  - name: incident
    color: "b60205"
    description: A deliberate repo-only label
LEGACY
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with legacy settings"

cd "$GITHUB_WORKSPACE"
export MODULES='["uv", "settings-sync"]'
export PRIVATE=false
export DESCRIPTION="Live transition description"
export TARGET_DIR="$SET"
export TARGET_REF="$NEW_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$SET_WORK/dropped-local-hunks.md" --root "$SET"
RECOVER="" RUNNER_TEMP="$SET_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
TARGET_DIR="$SET" bun actions/shared/stamp_manifest.ts
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$SET"

cd "$SET"
# The legacy file was replaced with the identity starter: the retired
# marker and the baseline copies are gone, the identity keys survive -
# custom topics from the old file, and the description from the
# post-update recorded answers because the old file declared none.
if grep -qxF "# repo-platform:mergeable" .github/settings.yml; then
  fail "the layering transition left the retired mergeable marker in settings.yml"
fi
grep -qxF '  topics: "kept, custom, topics"' .github/settings.yml \
  || fail "the transition dropped the repo's custom topics from the new starter"
grep -qxF '  description: "Live transition description"' .github/settings.yml \
  || fail "the transition did not fall back to the recorded description"
grep -qxF "  private: false" .github/settings.yml \
  || fail "the transition did not seed private into the new starter"
if grep -qF "has_issues" .github/settings.yml; then
  fail "the transition kept a baseline policy key in the repo-owned starter"
fi
# The repo-only label is CARRIED into the starter (the apply would
# otherwise delete it); fleet-supplied labels are not - the fleet entry
# keeps them alive and a copy would only shadow it.
grep -qxF "  - name: incident" .github/settings.yml \
  || fail "the transition did not carry the repo-only label into the starter"
if grep -qF "name: dependencies" .github/settings.yml; then
  fail "the transition carried a fleet-supplied label into the repo-owned starter"
fi
# The PR-body section names the carry (the file changed owner, so the PR
# is held for review either way), never the baseline-equal keys.
test -s "$SET_WORK/settings-layering.md" \
  || fail "the transition wrote no settings-layering section"
grep -qF 'CARRIED into the new file' "$SET_WORK/settings-layering.md" \
  || fail "the settings-layering section does not name the carry"
grep -qF 'labels "incident"' "$SET_WORK/settings-layering.md" \
  || fail "the settings-layering section does not name the carried repo-only label"
if grep -qF "repository.has_issues" "$SET_WORK/settings-layering.md"; then
  fail "the settings-layering section lists a baseline-equal key as dropped"
fi
if grep -qF "repository.topics" "$SET_WORK/settings-layering.md"; then
  fail "the settings-layering section lists a carried identity key as dropped"
fi
# The manifest classes settings.yml as a starter now (no hash).
[ "$(TARGET_DIR="$SET" python3 -c 'import json, os
entry = json.load(open(os.path.join(os.environ["TARGET_DIR"], ".github/repo-platform-manifest.json")))["files"].get(".github/settings.yml")
print("absent" if entry is None else entry.get("class", "missing"))')" = "starter" ] \
  || fail "the manifest does not class settings.yml as a starter after the transition"
# One-time: a second preserve pass over the transitioned tree must leave
# the file byte-identical and report nothing.
cp .github/settings.yml "$SET_WORK/settings-after-first-pass.yml"
cd "$GITHUB_WORKSPACE"
RECOVER="" RUNNER_TEMP="$SET_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
cmp -s "$SET/.github/settings.yml" "$SET_WORK/settings-after-first-pass.yml" \
  || fail "the layering transition re-fired on an already-transitioned starter"
if [ -s "$SET_WORK/settings-layering.md" ]; then
  fail "the second pass wrote a settings-layering section for nothing"
fi
# The other precedence leg: a legacy file that DOES declare a description
# must keep its own, not the recorded answer. Declared-wins is the point
# of the seeding rule (the heal was enforcing that declaration), so both
# legs are pinned. Re-plant a legacy file in the transitioned tree - the
# retired marker is what re-arms the one-time transition.
cd "$SET"
cat > .github/settings.yml <<'LEGACY2'
---
# Rendered by the settings-sync module (legacy baseline shape).
# repo-platform:mergeable
repository:
  description: Declared beats the answer
  homepage: ""
  topics: kept, custom, topics
  private: false
LEGACY2
cd "$GITHUB_WORKSPACE"
RECOVER="" RUNNER_TEMP="$SET_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
cd "$SET"
grep -qxF '  description: "Declared beats the answer"' .github/settings.yml \
  || fail "the transition did not prefer the old file's declared description"
if grep -qF "Live transition description" .github/settings.yml; then
  fail "the transition used the recorded answer over a declared description"
fi
echo "settings layering precedence OK: declared description wins, recorded answer is the fallback"

echo "settings layering transition OK: starter replaced once, custom topics carried, dropped override listed"

# --- Tail tripwire end-to-end (workflow step -> report -> open_pr) --------
# The post-stamp tripwire chain runs nowhere else end-to-end: a repo-owned
# tail line that vanished from the working tree after the stamp must
# produce the RUNNER_TEMP report, land as a PR-body section, and force the
# manual-review path (auto-merge off). Reuses the NEW build (no extra
# tag); gh is stubbed, so open_pr.ts's body and arm decisions are
# observable without a network.
TRIP="$RUN_DIR/upgrade-trip"
TRIP_WORK="$RUN_DIR/upgrade-trip-work"
TRIP_REF="$REF_NS/new"
rm -rf "$TRIP" "$TRIP_WORK"
mkdir -p "$TRIP_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$TRIP" \
  --vcs-ref "$TRIP_REF" --defaults --trust \
  -d project_name="Tripwire" \
  -d description="Tripwire project" \
  -d 'modules=[agents]' \
  -d private="false"
cd "$TRIP"
printf '\n## Local agent docs\n\ntrip-local tail line\n' >> AGENTS.md
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with tail"
# The sync bug the tripwire exists for: the repo-owned tail line vanishes
# from the working tree AFTER the stamp (the manifest still declares the
# split, HEAD still holds the line).
grep -vF "trip-local tail line" AGENTS.md > AGENTS.md.tmp
mv AGENTS.md.tmp AGENTS.md
cd "$GITHUB_WORKSPACE"
# The workflow step's invocation: the report lands under RUNNER_TEMP by
# the filename constant tail_tripwire.ts shares with open_pr.ts.
RUNNER_TEMP="$TRIP_WORK" bun .github/scripts/sync/tail_tripwire.ts --root "$TRIP"
test -s "$TRIP_WORK/tail-shrank.md" \
  || fail "the tail tripwire produced no tail-shrank.md for a shrunk repo-owned tail"
grep -qF "TAIL TRIPWIRE" "$TRIP_WORK/tail-shrank.md" \
  || fail "the tripwire report lacks its warning heading"
grep -qF "trip-local tail line" "$TRIP_WORK/tail-shrank.md" \
  || fail "the tripwire report does not list the missing tail line"

# The chain's tail: open_pr.ts must append the section and refuse to arm
# auto-merge. The stub gh records its argv (PR body included) and serves
# the two reads open_pr makes.
TRIP_BIN="$TRIP_WORK/bin"
mkdir -p "$TRIP_BIN"
cat > "$TRIP_BIN/gh" <<'GHSTUB'
#!/usr/bin/env bash
set -euo pipefail
{ printf 'gh'; printf ' %s' "$@"; printf '\n'; } >> "$GH_CALLS"
case "$1 $2" in
  "pr list") printf '' ;;
  "pr create") echo "https://github.com/o/r/pull/1" ;;
  "pr view") echo "https://github.com/o/r/pull/1" ;;
  *) : ;;
esac
GHSTUB
chmod +x "$TRIP_BIN/gh"
echo "build@old" > "$TRIP_WORK/old_commit.txt"
: > "$TRIP_WORK/empty.txt"
GH_CALLS="$TRIP_WORK/gh-calls.txt" PATH="$TRIP_BIN:$PATH" \
  TARGET="Vivswan/tripwire" RUNNER_TEMP="$TRIP_WORK" \
  GITHUB_REPOSITORY="Vivswan/repo-platform" GITHUB_OUTPUT="$TRIP_WORK/gh-output.txt" \
  BRANCH=automation/repo-platform BASE_BRANCH=main DISPLAY="build@new" \
  RECOVER="" RESOLVED="" VALIDATION=passed HIDE_DETAILS="" \
  DRIFT_FILE="$TRIP_WORK/empty.txt" CARRIED_FILE="$TRIP_WORK/empty.txt" \
  CARRY_REVIEW_FILE="$TRIP_WORK/empty.txt" RETIRED_MODULES_FILE="$TRIP_WORK/empty.txt" \
  REMOVED_PATHS_FILE="$TRIP_WORK/empty.txt" WITHHELD_FILE="$TRIP_WORK/empty.txt" \
  MANIFEST_LICENSE_FILE="$TRIP_WORK/empty.txt" \
  bun .github/scripts/sync/open_pr.ts > "$TRIP_WORK/open-pr.out"
grep -qF "auto-merge left off" "$TRIP_WORK/open-pr.out" \
  || fail "open_pr armed auto-merge despite a tripped tail tripwire"
grep -q '^gh pr create' "$TRIP_WORK/gh-calls.txt" || fail "open_pr never created the PR"
grep -qF "TAIL TRIPWIRE" "$TRIP_WORK/gh-calls.txt" \
  || fail "the PR body lacks the tail tripwire section"
if grep -q '^gh pr merge' "$TRIP_WORK/gh-calls.txt"; then
  fail "open_pr attempted to arm auto-merge on a tripped run"
fi
echo "tail tripwire OK: report produced, PR-body section present, manual review forced"

# --- Pre-grammar manifest refusal (legacy tripwire fallback retired) -------
# A HEAD manifest whose split entries lack the stamped grammar field was
# once served by a legacy marker/managed fallback inside the tripwire;
# that path is retired (the fleet censused all-post-grammar before the
# removal). A straggler manifest arriving at the new sync must fail
# LOUDLY: every split file unverifiable, the report naming the fix (a
# recovery sync), the PR forced manual - and with NO fabricated loss
# claim, because the delivered tree here keeps every local line. The run
# itself stays green: a red tripwire would block the very sync that heals
# the manifest.
PREG="$RUN_DIR/upgrade-pregrammar"
PREG_WORK="$RUN_DIR/upgrade-pregrammar-work"
mkdir -p "$PREG_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$PREG" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Pre-grammar" \
  -d description="Pre-grammar project" \
  -d 'modules=[agents]' \
  -d private="false"
cd "$PREG"
printf '\n## Local agent docs\n\npregrammar-local tail line\n' >> AGENTS.md
# HEAD's manifest in the retired pre-grammar shape: split entries carry
# only the marker/managed pair. The stamped post-grammar copy is kept
# aside and restored below as the delivered (post-sync) manifest.
cp .github/repo-platform-manifest.json "$PREG_WORK/manifest-stamped.json"
python3 - <<'PY'
import json
path = ".github/repo-platform-manifest.json"
with open(path) as f:
    manifest = json.load(f)
stripped = 0
for entry in manifest["files"].values():
    if entry.get("class") == "split":
        for key in ("grammar", "managed_end", "local_begin", "local_end"):
            entry.pop(key, None)
        stripped += 1
assert stripped > 0, "fixture has no split entries to strip"
with open(path, "w") as f:
    json.dump(manifest, f, indent=4)
    f.write("\n")
PY
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with pre-grammar manifest"
# The delivered state: the post-grammar stamped manifest is back and the
# local tail SURVIVED - nothing was lost, so any loss claim is fabricated.
cp "$PREG_WORK/manifest-stamped.json" .github/repo-platform-manifest.json
cd "$GITHUB_WORKSPACE"
RUNNER_TEMP="$PREG_WORK" bun .github/scripts/sync/tail_tripwire.ts --root "$PREG" \
  > "$PREG_WORK/tripwire.out"
test -s "$PREG_WORK/tail-shrank.md" \
  || fail "a pre-grammar HEAD manifest produced no tripwire report (the retired legacy fallback must not be silently back)"
grep -qF "predates the stamped split grammar" "$PREG_WORK/tail-shrank.md" \
  || fail "the tripwire report does not name the pre-grammar refusal"
grep -qF "recover=recopy" "$PREG_WORK/tail-shrank.md" \
  || fail "the tripwire report does not name the recovery-sync fix"
grep -qF '`AGENTS.md`' "$PREG_WORK/tail-shrank.md" \
  || fail "the tripwire report does not list AGENTS.md as unverifiable"
if grep -qF "missing from this update's copy" "$PREG_WORK/tail-shrank.md"; then
  fail "the pre-grammar refusal fabricated a loss claim for a preserved tail"
fi
grep -qF "::warning::" "$PREG_WORK/tripwire.out" \
  || fail "the pre-grammar refusal did not warn (silent misbehavior)"
echo "pre-grammar manifest OK: loud unverifiable refusal, recovery advice named, no fabricated loss"

# --- Retired-grammar straggler refusal (conversion machinery deleted) ------
# The tail-marker and four-marker bounded-region grammars were retired into
# ONE (managed-region), the fleet census confirmed every managed repo
# converted, and the one-time conversion machinery was deleted. A straggler
# repo arriving NOW - old-shaped files plus an old-vintage manifest - gets
# the loud refusal, not a conversion: headSplitEntries refuses the manifest,
# so HEAD's declarations are UNUSABLE and every previous split copy is
# preserved in full under a recovery appendix (never split by a guessed
# boundary - the old .gitignore's managed half carries the current marker
# pair, and splitting there could misattribute repo-owned bytes to the
# managed discard), the PR is held for review, the retired relic lines ride
# through as repo-owned bytes (NO strip exists anymore), and the tail
# tripwire reports every split file unverifiable with the refusal naming
# the fix (recover=recopy). The run itself stays green: a red tripwire
# would block the very sync that heals.
TRANS="$RUN_DIR/upgrade-straggler"
TRANS_WORK="$RUN_DIR/upgrade-straggler-work"
mkdir -p "$TRANS_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$TRANS" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Straggler" \
  -d description="Straggler project" \
  -d 'modules=[agents]' \
  -d private="false"
cp -R "$TRANS" "$TRANS_WORK/render-new"
cp -R "$TRANS" "$TRANS_WORK/render-old"
cd "$TRANS"
# Rewrite AGENTS.md and .gitignore to the retired shapes, byte-controlled,
# and the manifest's two entries to the retired wire vintages. Standalone
# python: the harness must stay independent of the code it verifies.
python3 - <<'PY'
import json

B = "<!-- BEGIN REPO-PLATFORM MANAGED -->"
E = "<!-- END REPO-PLATFORM MANAGED -->"
HB = "# BEGIN REPO-PLATFORM MANAGED"
OLD_SENTINEL = "<!-- repo-platform:local-section -->"
OLD_GUIDANCE = "# Add repository-specific ignore patterns in this section only."

# AGENTS.md: old shape = the new render's managed content with the marker
# pair replaced by one terminal tail marker; the repo's tail sits below it
# (with a non-UTF-8 byte, so byte-fidelity is really proven).
with open("AGENTS.md", "rb") as f:
    fresh = f.read().decode("latin-1")
region = fresh[fresh.index(B) : fresh.index(E) + len(E) + 1]
body = region.replace(f"{B}\n", "").replace(f"{E}\n", "")
old_managed = f"{body}\n{OLD_SENTINEL}\n"
tail = "\n## Project docs\n\ncaf\xe9 repo-local instructions\n"
with open("AGENTS.md", "wb") as f:
    f.write((old_managed + tail).encode("latin-1"))
with open("../upgrade-straggler-work/agents-old-shape.bin", "wb") as f:
    f.write((old_managed + tail).encode("latin-1"))

# .gitignore: old shape = a LOCAL region (retired markers, the retired
# guidance line, a repo entry) above the managed half, which ran from the
# BEGIN line to end of file.
with open(".gitignore", "rb") as f:
    gi = f.read().decode("latin-1")
managed_half = gi[gi.index(HB) :]
above = (
    "# BEGIN REPOSITORY LOCAL\n"
    f"{OLD_GUIDANCE}\n"
    "\n"
    "straggler-local-cache/\n"
    "# END REPOSITORY LOCAL\n"
    "\n"
)
with open(".gitignore", "wb") as f:
    f.write((above + managed_half).encode("latin-1"))

# The manifest: the two entries in their retired wire vintages.
path = ".github/repo-platform-manifest.json"
with open(path) as f:
    manifest = json.load(f)
manifest["files"]["AGENTS.md"] = {
    "class": "split",
    "grammar": "tail-marker",
    "marker": OLD_SENTINEL,
    "managed": "above",
    "hash": None,
}
manifest["files"][".gitignore"] = {
    "class": "split",
    "grammar": "bounded-region",
    "marker": HB,
    "managed": "below",
    "managed_end": "# END REPO-PLATFORM MANAGED",
    "local_begin": "# BEGIN REPOSITORY LOCAL",
    "local_end": "# END REPOSITORY LOCAL",
    "hash": None,
}
with open(path, "w") as f:
    json.dump(manifest, f, indent=4)
    f.write("\n")
PY
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init in the retired shapes"
# The working tree holds copier's merged junk the rebuild must discard.
echo "merged result to discard" > AGENTS.md
echo "merged result to discard" > .gitignore
# Restore the post-sync manifest (the new render's own copy).
cp "$TRANS_WORK/render-new/.github/repo-platform-manifest.json" .github/repo-platform-manifest.json
cd "$GITHUB_WORKSPACE"
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$TRANS_WORK/local-carryover.md" --root "$TRANS" \
  --needs-review "$TRANS_WORK/carry-review.txt" \
  --rebuilt-paths "$TRANS_WORK/rebuilt-paths.txt" \
  --render-dir "$TRANS_WORK/render-new" --old-render-dir "$TRANS_WORK/render-old"
# AGENTS.md: NO conversion - the fresh render, then the whole old copy
# byte-identical (non-UTF-8 byte included) under the recovery appendix.
grep -qF "repo-platform:recovery-appendix" "$TRANS/AGENTS.md" \
  || fail "the straggler AGENTS.md carries no recovery appendix (a conversion path is silently back?)"
OLD_SIZE=$(wc -c < "$TRANS_WORK/agents-old-shape.bin")
tail -c "$OLD_SIZE" "$TRANS/AGENTS.md" | cmp -s - "$TRANS_WORK/agents-old-shape.bin" \
  || fail "the recovery appendix did not preserve the old-shaped copy byte-identical"
# .gitignore: the appendix too, NEVER a guessed split at the current
# markers (the old managed half carries the pair, so a guessed split would
# hand old bytes to the managed discard) - the fresh render stands on top,
# the whole old copy is preserved below the appendix comment, its retired
# marker pair and the old guidance line INCLUDED (repo-owned bytes now,
# with the one-time strip deleted; only the current markers are dash-joined
# inert so the validator's exactly-once rule holds).
grep -qF "# repo-platform:recovery-appendix" "$TRANS/.gitignore" \
  || fail "the straggler .gitignore carries no recovery appendix (a guessed split is silently back?)"
grep -qxF "# BEGIN REPOSITORY LOCAL" "$TRANS/.gitignore" \
  || fail "the retired REPOSITORY LOCAL marker was stripped - the deleted conversion strip is back"
grep -qxF "# Add repository-specific ignore patterns in this section only." "$TRANS/.gitignore" \
  || fail "the retired guidance line was stripped - the deleted conversion strip is back"
grep -qxF "straggler-local-cache/" "$TRANS/.gitignore" \
  || fail "the straggler .gitignore lost the repository's own ignore pattern"
# The summary must state dispositions without any conversion-era wording,
# and the appendixes must hold the PR for review.
if grep -qF "converted from the retired" "$TRANS_WORK/local-carryover.md"; then
  fail "the carry summary still names a conversion (the retired machinery must be gone)"
fi
if grep -qF "platform-authored relic line(s)" "$TRANS_WORK/local-carryover.md"; then
  fail "the carry summary still names a relic strip (the retired machinery must be gone)"
fi
grep -qF "recovery-appendix" "$TRANS_WORK/local-carryover.md" \
  || fail "the carry summary does not name the recovery appendix"
grep -qF "AGENTS.md: recovery-appendix" "$TRANS_WORK/carry-review.txt" \
  || fail "the straggler AGENTS.md appendix did not hold the PR for review"
grep -qF ".gitignore: recovery-appendix" "$TRANS_WORK/carry-review.txt" \
  || fail "the straggler .gitignore appendix did not hold the PR for review"
# The stamp, then the tripwire: the retired-grammar HEAD manifest must be
# REFUSED - every split file unverifiable, the report naming the retired
# grammar and the recovery fix, with no fabricated loss claim (the
# appendixes kept every previous line). Warn-only: the run stays green so
# the healing sync can deliver.
TARGET_DIR="$TRANS" bun actions/shared/stamp_manifest.ts
RUNNER_TEMP="$TRANS_WORK" bun .github/scripts/sync/tail_tripwire.ts --root "$TRANS" \
  > "$TRANS_WORK/tripwire.out"
test -s "$TRANS_WORK/tail-shrank.md" \
  || fail "a retired-grammar HEAD manifest produced no tripwire report (a conversion fallback must not be silently back)"
# The refusal names whichever retired entry the manifest lists first -
# either retired grammar proves the arm.
grep -qE 'split grammar "(tail-marker|bounded-region)"' "$TRANS_WORK/tail-shrank.md" \
  || fail "the tripwire report does not name the retired-grammar refusal"
grep -qF "recover=recopy" "$TRANS_WORK/tail-shrank.md" \
  || fail "the tripwire report does not name the recovery-sync fix"
grep -qF '`AGENTS.md`' "$TRANS_WORK/tail-shrank.md" \
  || fail "the tripwire report does not list AGENTS.md as unverifiable"
grep -qF '`.gitignore`' "$TRANS_WORK/tail-shrank.md" \
  || fail "the tripwire report does not list .gitignore as unverifiable"
if grep -qF "missing from this update's copy" "$TRANS_WORK/tail-shrank.md"; then
  fail "the retired-grammar refusal fabricated a loss claim for preserved content"
fi
grep -qF "::warning::" "$TRANS_WORK/tripwire.out" \
  || fail "the retired-grammar refusal did not warn (silent misbehavior)"
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$TRANS"
echo "retired-grammar straggler OK: both old copies preserved under review-held appendixes, relic lines kept, loud unverifiable refusal with recovery advice, no conversion"

# --- Split-file retirement (module deselection) ----------------------------
# Deselecting a module retires its files from the render, and a retired
# file HEAD's manifest classes `split` carries a repository-owned half
# that leaves WITH the deletion (copier resolves delete-vs-modify by
# dropping the file; retired_cleanup rms retired paths outright). The
# class-level hold (preserve_repo_owned.ts -> removed-splits.md ->
# open_pr.ts) must name the leaving content and keep the PR manual - on
# this rule ALONE: no license machinery is involved in this leg, and the
# tail tripwire must stay clear (the retired path is absent from the
# post-sync manifest by design, so the wire never visits it).
DESEL="$RUN_DIR/upgrade-deselect"
DESEL_WORK="$RUN_DIR/upgrade-deselect-work"
mkdir -p "$DESEL_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$DESEL" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Module Deselection" \
  -d description="Module-deselection project" \
  -d 'modules=[agents, uv]' \
  -d private="false"
cd "$DESEL"
printf '\n## Local agent docs\n\ndeselect-local agents tail\n' >> AGENTS.md
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with agents tail"

# The deselection edit a repo merges before the sync, then the workflow's
# leg order: apply update, materialize renders, rebuild split files,
# resolve conflicts, retired cleanup, preserve, stamp, tripwire.
cd "$GITHUB_WORKSPACE"
export MODULES='["uv"]'
export PRIVATE=false
export DESCRIPTION="Module-deselection project"
export TARGET_DIR="$DESEL"
export TARGET_REF="$NEW_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
answers_desel="$(git -C "$DESEL" show HEAD:.github/.copier-answers.yml)"
src_path_desel="$(sed -n 's/^_src_path: //p' <<<"$answers_desel")"
test -n "$src_path_desel" || fail "deselection fixture records no _src_path"
RUNNER_TEMP="$DESEL_WORK" SRC_PATH="$src_path_desel" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/clean_renders.ts
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$DESEL_WORK/local-carryover.md" --root "$DESEL" \
  --needs-review "$DESEL_WORK/carry-review.txt" \
  --rebuilt-paths "$DESEL_WORK/split-rebuilt-paths.txt" \
  --render-dir "$DESEL_WORK/render-new" --old-render-dir "$DESEL_WORK/render-old"
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$DESEL_WORK/dropped-local-hunks.md" --root "$DESEL" \
  --skip "$DESEL_WORK/split-rebuilt-paths.txt"
git show "$NEW_TAG:copier.yml" > "$DESEL_WORK/copier-old.yml"
git show "$NEW_TAG:copier.yml" > "$DESEL_WORK/copier-new.yml"
RUNNER_TEMP="$DESEL_WORK" SRC_PATH="$src_path_desel" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
test ! -e "$DESEL/AGENTS.md" \
  || fail "the deselected agents module's AGENTS.md survived retirement"
RECOVER="" RUNNER_TEMP="$DESEL_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
TARGET_DIR="$DESEL" bun actions/shared/stamp_manifest.ts
RUNNER_TEMP="$DESEL_WORK" bun .github/scripts/sync/tail_tripwire.ts --root "$DESEL"
if [ -s "$DESEL_WORK/tail-shrank.md" ]; then
  fail "the tail tripwire fired on a clean module deselection (the hold must come from the removal rule alone)"
fi
test -s "$DESEL_WORK/removed-splits.md" \
  || fail "deleting the split-classed AGENTS.md produced no removed-splits hold"
grep -qF '`AGENTS.md`' "$DESEL_WORK/removed-splits.md" \
  || fail "the removed-splits hold does not name AGENTS.md"
grep -qF "deselect-local agents tail" "$DESEL_WORK/removed-splits.md" \
  || fail "the removed-splits hold does not name the leaving repository-owned content"

# The chain's tail: open_pr.ts must append the section and refuse to arm
# auto-merge on the removed-splits hold alone (the only other non-empty
# inputs - the removed-paths list and the carry summary - are
# informational and never force review; the gh stub from the tripwire leg
# records the body).
echo "build@old" > "$DESEL_WORK/old_commit.txt"
: > "$DESEL_WORK/empty.txt"
GH_CALLS="$DESEL_WORK/gh-calls.txt" PATH="$TRIP_BIN:$PATH" \
  TARGET="Vivswan/deselect" RUNNER_TEMP="$DESEL_WORK" \
  GITHUB_REPOSITORY="Vivswan/repo-platform" GITHUB_OUTPUT="$DESEL_WORK/gh-output.txt" \
  BRANCH=automation/repo-platform BASE_BRANCH=main DISPLAY="build@new" \
  RECOVER="" RESOLVED="" VALIDATION=passed HIDE_DETAILS="" \
  DRIFT_FILE="$DESEL_WORK/empty.txt" CARRIED_FILE="$DESEL_WORK/local-carryover.md" \
  CARRY_REVIEW_FILE="$DESEL_WORK/carry-review.txt" RETIRED_MODULES_FILE="$DESEL_WORK/empty.txt" \
  REMOVED_PATHS_FILE="$DESEL_WORK/removed-paths.txt" WITHHELD_FILE="$DESEL_WORK/empty.txt" \
  MANIFEST_LICENSE_FILE="$DESEL_WORK/empty.txt" \
  bun .github/scripts/sync/open_pr.ts > "$DESEL_WORK/open-pr.out"
grep -qF "auto-merge left off" "$DESEL_WORK/open-pr.out" \
  || fail "open_pr armed auto-merge despite a deleted split-classed file"
grep -qF "deselect-local agents tail" "$DESEL_WORK/gh-calls.txt" \
  || fail "the PR body does not name the repository-owned content the deletion takes with it"
if grep -q '^gh pr merge' "$DESEL_WORK/gh-calls.txt"; then
  fail "open_pr attempted to arm auto-merge on a removed-splits hold"
fi
echo "module deselection OK: retired split file deleted, hold raised, leaving content named, manual review forced"

# --- Starter pin rollout (fuzz-issue @main/@actions -> @build) -------------
# Starter workflows are rendered once and repo-owned (_skip_if_exists), so
# the template's own re-pin of the fuzz-issue action (main, or the
# retired actions branch, -> the green-gated unified build branch) never
# reaches an already-rendered
# repo; the one-run sync-side rollout (starter_pin_rollout.ts) ports it.
# Fixture: a fresh render with nightly.yml set back to the pre-flip @main
# pin (the fleet state before the flip) and nightly-fuzz.yml hand-pinned at
# its own ref. Post-sync, nightly.yml must be byte-equal to its previous
# copy with ONLY the pin substring rewritten, the hand-pinned file must be
# byte-identical, a second run must rewrite nothing, and open_pr must carry
# the transition note while still arming auto-merge (the note is
# informational, never a review hold).
PIN="$RUN_DIR/upgrade-pin"
PIN_WORK="$RUN_DIR/upgrade-pin-work"
mkdir -p "$PIN_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$PIN" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Starter Pin Rollout" \
  -d description="Starter-pin project" \
  -d 'modules=[nightly, fuzzer]' \
  -d private="false"
cd "$PIN"
# The fresh render pins the delivery branch; model the fleet state by
# setting the rendered starters back to the old pin / a hand pin.
grep -q "repo-platform/actions/fuzz-issue@build" .github/workflows/nightly.yml \
  || fail "fixture render does not pin fuzz-issue at the build branch"
sed 's|/repo-platform/actions/fuzz-issue@build|/repo-platform/actions/fuzz-issue@main|g' \
  .github/workflows/nightly.yml > .github/workflows/nightly.yml.tmp
mv .github/workflows/nightly.yml.tmp .github/workflows/nightly.yml
sed 's|/repo-platform/actions/fuzz-issue@build|/repo-platform/actions/fuzz-issue@v9.9.9|g' \
  .github/workflows/nightly-fuzz.yml > .github/workflows/nightly-fuzz.yml.tmp
mv .github/workflows/nightly-fuzz.yml.tmp .github/workflows/nightly-fuzz.yml
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with pre-flip pins"
# The oracle for byte-surgery: the old copy with only the pin substring
# swapped, and the hand-pinned copy exactly as committed.
sed 's|/repo-platform/actions/fuzz-issue@main|/repo-platform/actions/fuzz-issue@build|g' \
  .github/workflows/nightly.yml > "$PIN_WORK/nightly-expected.yml"
cp .github/workflows/nightly-fuzz.yml "$PIN_WORK/nightly-fuzz-before.yml"

# The workflow's leg order around the rollout step: apply update,
# materialize renders, rebuild split files, resolve conflicts, retired
# cleanup, preserve, ROLL OUT PINS, stamp, validate.
cd "$GITHUB_WORKSPACE"
export MODULES='["nightly", "fuzzer"]'
export PRIVATE=false
export DESCRIPTION="Starter-pin project"
export TARGET_DIR="$PIN"
export TARGET_REF="$NEW_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
answers_pin="$(git -C "$PIN" show HEAD:.github/.copier-answers.yml)"
src_path_pin="$(sed -n 's/^_src_path: //p' <<<"$answers_pin")"
test -n "$src_path_pin" || fail "pin fixture records no _src_path"
RUNNER_TEMP="$PIN_WORK" SRC_PATH="$src_path_pin" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/clean_renders.ts
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$PIN_WORK/local-carryover.md" --root "$PIN" \
  --needs-review "$PIN_WORK/carry-review.txt" \
  --rebuilt-paths "$PIN_WORK/split-rebuilt-paths.txt" \
  --render-dir "$PIN_WORK/render-new" --old-render-dir "$PIN_WORK/render-old"
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$PIN_WORK/dropped-local-hunks.md" --root "$PIN" \
  --skip "$PIN_WORK/split-rebuilt-paths.txt"
git show "$NEW_TAG:copier.yml" > "$PIN_WORK/copier-old.yml"
git show "$NEW_TAG:copier.yml" > "$PIN_WORK/copier-new.yml"
RUNNER_TEMP="$PIN_WORK" SRC_PATH="$src_path_pin" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
RECOVER="" RUNNER_TEMP="$PIN_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
RUNNER_TEMP="$PIN_WORK" bun .github/scripts/sync/starter_pin_rollout.ts \
  --root "$PIN" --render-dir "$PIN_WORK/render-new"
TARGET_DIR="$PIN" bun actions/shared/stamp_manifest.ts
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$PIN"

cmp -s "$PIN_WORK/nightly-expected.yml" "$PIN/.github/workflows/nightly.yml" \
  || fail "the rollout did not deliver nightly.yml byte-equal to its previous copy with only the pin rewritten"
cmp -s "$PIN_WORK/nightly-fuzz-before.yml" "$PIN/.github/workflows/nightly-fuzz.yml" \
  || fail "the rollout touched the hand-pinned nightly-fuzz.yml"
test -s "$PIN_WORK/starter-pin-rollout.md" \
  || fail "the rollout wrote no transition note"
grep -qF 'nightly.yml`: rewrote 2 occurrence(s)' "$PIN_WORK/starter-pin-rollout.md" \
  || fail "the transition note does not name nightly.yml's rewritten pins"
grep -qF "repo-platform/actions/fuzz-issue@build" "$PIN_WORK/starter-pin-rollout.md" \
  || fail "the transition note does not show the new delivery-branch pin"
grep -qF 'nightly-fuzz.yml`: left alone' "$PIN_WORK/starter-pin-rollout.md" \
  || fail "the transition note does not list the hand-pinned nightly-fuzz.yml as skipped"

# Idempotent: a second run rewrites nothing (the file stays byte-identical
# and the refreshed note reports no rewrite, only the standing hand pin).
cp "$PIN/.github/workflows/nightly.yml" "$PIN_WORK/nightly-after-first.yml"
RUNNER_TEMP="$PIN_WORK" bun .github/scripts/sync/starter_pin_rollout.ts \
  --root "$PIN" --render-dir "$PIN_WORK/render-new"
cmp -s "$PIN_WORK/nightly-after-first.yml" "$PIN/.github/workflows/nightly.yml" \
  || fail "the second rollout run changed nightly.yml (the rewrite must be idempotent)"
# The bullet form, not the bare word: the note's intro legitimately says
# "a rewrote line below is a byte-surgical port".
if grep -qF '`: rewrote' "$PIN_WORK/starter-pin-rollout.md"; then
  fail "the second rollout run reported a rewrite (it must find nothing to rewrite)"
fi
grep -qF 'nightly-fuzz.yml`: left alone' "$PIN_WORK/starter-pin-rollout.md" \
  || fail "the second rollout run dropped the standing hand-pin listing"

# The chain's tail: open_pr.ts must append the transition note and, since
# the note is informational, still arm auto-merge (gh stub from the
# tripwire leg records the body and the merge call).
echo "build@old" > "$PIN_WORK/old_commit.txt"
: > "$PIN_WORK/empty.txt"
GH_CALLS="$PIN_WORK/gh-calls.txt" PATH="$TRIP_BIN:$PATH" \
  TARGET="Vivswan/starter-pins" RUNNER_TEMP="$PIN_WORK" \
  GITHUB_REPOSITORY="Vivswan/repo-platform" GITHUB_OUTPUT="$PIN_WORK/gh-output.txt" \
  BRANCH=automation/repo-platform BASE_BRANCH=main DISPLAY="build@new" \
  RECOVER="" RESOLVED="" VALIDATION=passed HIDE_DETAILS="" \
  DRIFT_FILE="$PIN_WORK/empty.txt" CARRIED_FILE="$PIN_WORK/empty.txt" \
  CARRY_REVIEW_FILE="$PIN_WORK/empty.txt" RETIRED_MODULES_FILE="$PIN_WORK/empty.txt" \
  REMOVED_PATHS_FILE="$PIN_WORK/empty.txt" WITHHELD_FILE="$PIN_WORK/empty.txt" \
  MANIFEST_LICENSE_FILE="$PIN_WORK/empty.txt" \
  bun .github/scripts/sync/open_pr.ts > "$PIN_WORK/open-pr.out"
grep -qF "One-run starter pin rollout" "$PIN_WORK/gh-calls.txt" \
  || fail "the PR body lacks the starter pin rollout transition note"
grep -q '^gh pr merge' "$PIN_WORK/gh-calls.txt" \
  || fail "open_pr did not arm auto-merge despite the rollout note being informational"
echo "starter pin rollout OK: old pin ported byte-surgically, hand pin left alone, note in the PR body, auto-merge kept"

# --- Pages answer retirement (pages_production / pages_staging) ---------
# A repo rendered in the production/staging era carries that pages.yml
# shape and records the two retired answers. The update must re-render the
# managed pages.yml to the mounts interface and drop the retired answers
# from the answers file while the surviving pages answers ride through.
PAGES_FIX="$RUN_DIR/upgrade-pages"
PAGES_WORK="$RUN_DIR/upgrade-pages-work"
mkdir -p "$PAGES_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$PAGES_FIX" \
  --vcs-ref "$prev" --defaults --trust \
  -d project_name="Pages Retirement" \
  -d description="Pages-retirement project" \
  -d 'modules=[pages, auto-assign]' \
  -d pages_setup=none -d pages_build_command=./build.sh \
  -d private="false"
cd "$PAGES_FIX"
grep -qE '^ +production: main$' .github/workflows/pages.yml \
  || fail "old pages fixture does not carry the production/staging interface"
# The era's recorded answers: current copier no longer asks the questions,
# so the fleet state is modeled by recording the values directly.
printf 'pages_production: main\npages_staging: false\n' >> .copier-answers.yml # root: pre-move era
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init in the production/staging era"

cd "$GITHUB_WORKSPACE"
git show "${prev}:copier.yml" > "$PAGES_WORK/copier-old.yml"
git show "$NEW_TAG":copier.yml > "$PAGES_WORK/copier-new.yml"
MODULES="$(select_modules \
  --repo-file "$PAGES_FIX/.repo-platform.yml" \
  --template-copier "$PAGES_WORK/copier-new.yml" \
  --retired-summary "$PAGES_WORK/retired-modules.txt")"
export MODULES
export PRIVATE=false
export DESCRIPTION="Pages-retirement project"
export TARGET_DIR="$PAGES_FIX"
export TARGET_REF="$NEW_TAG"
# The fixture rendered at the pre-move ref: replay the answers-file move
# (the retro-recorded pages answers must ride the move verbatim).
RUNNER_TEMP="$PAGES_WORK" bun .github/scripts/sync/relocate_answers.ts
RECOVER="" bun .github/scripts/sync/apply_update.ts
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$PAGES_WORK/dropped-local-hunks.md" --root "$PAGES_FIX"
pages_rendered="$PAGES_FIX/.github/workflows/pages.yml"
grep -qF "mounts:" "$pages_rendered" \
  || fail "the update did not re-render pages.yml to the mounts interface"
grep -qF '"versioned": true' "$pages_rendered" \
  || fail "updated pages.yml lost the versioned command mount"
if grep -qE '^ +(production|staging):' "$pages_rendered"; then
  fail "updated pages.yml still carries the retired production/staging inputs"
fi
if grep -qE '^ +release:$' "$pages_rendered"; then
  fail "updated pages.yml still carries the retired release trigger"
fi
if grep -qE '^pages_(production|staging):' "$PAGES_FIX/.github/.copier-answers.yml"; then
  fail "the update kept the retired pages answers recorded"
fi
grep -qE '^pages_build_command: ./build.sh$' "$PAGES_FIX/.github/.copier-answers.yml" \
  || fail "the surviving pages answers were lost by the update"
# The delivery-channel pin flip rides the same managed re-render: a repo
# rendered when the reusable-workflow calls pinned @main (the ungated
# tip) must come out of the update calling them @build, the green-gated
# delivery branch - for pages.yml and auto-assign.yml alike.
grep -qF -- "repo-platform/.github/workflows/reusable-pages.yml@build" "$pages_rendered" \
  || fail "updated pages.yml does not call reusable-pages at the build ref"
if grep -qF -- "repo-platform/.github/workflows/reusable-pages.yml@main" "$pages_rendered"; then
  fail "updated pages.yml still pins reusable-pages@main - the ungated tip"
fi
grep -qF -- "repo-platform/.github/workflows/reusable-auto-assign.yml@build" \
  "$PAGES_FIX/.github/workflows/auto-assign.yml" \
  || fail "updated auto-assign.yml does not call reusable-auto-assign at the build ref"
echo "pages answer retirement OK: mounts interface rendered, retired answers dropped, surviving answers kept"
