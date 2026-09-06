#!/usr/bin/env bash
# Upgrade-path test: generate a project from a synthetic OLD build tree,
# add the local modifications a real repo carries, then update it to a
# freshly assembled build tree the way reusable-template-sync does - module
# selection via sync/modules.ts, the migration ladder via
# sync/run_migrations.ts, live -d data via sync/apply_update.ts,
# conflict resolution, retired-file cleanup via sync/retired_cleanup.ts,
# and the settings preserve step via sync/preserve_repo_owned.ts. Asserts
# that files the template dropped are deleted while repo-owned content
# survives - including settings.yml, which is repo-owned wherever it exists
# (protected from cleanup and restored if copier de-renders it). A second
# leg proves the recover=recopy semantics on a corrupted _commit, and a
# third runs an update where visibility flips public -> private on its own
# fixture. The module fold (agents, auto-assign, settings-sync into base)
# rides the main leg as the m0002 rung, with an arrival leg below for a
# repository onboarded without the three.
#
# Both template refs must live in ONE clone (copier re-renders the old
# version from _src_path), so build trees are committed to local orphan
# refs + tags. The old fixture is SYNTHETIC: the current templates
# assembled by the current tooling, plus a sentinel file the new build no
# longer renders and the pre-transition shapes the legs below model.
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
    echo "FAIL: TMPDIR resolves to '$TMP_ROOT_ABS', inside the repo checkout '$REPO_ROOT' - the harness's fixtures cannot live under the repo"\
      "(branch_tree.ts refuses such destinations and the nested worktree would sit inside the main worktree); point TMPDIR outside the checkout" >&2
    exit 1
    ;;
esac
RUN_DIR="$(cd "$(mktemp -d "${TMP_ROOT_ABS%/}/upgrade-path.XXXXXX")" && pwd)"
REF_NS="ci-build-${RUN_DIR##*.}"
OLD_TAG="$REF_NS/old"
NEW_TAG="$REF_NS/new"
SPLIT_TAG="$REF_NS/split"
PROBE1_TAG="$REF_NS/probe1"
PROBE2_TAG="$REF_NS/probe2"
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
  git -C "$REPO_ROOT" tag -d "$OLD_TAG" "$NEW_TAG" "$SPLIT_TAG" "$PROBE1_TAG" "$PROBE2_TAG" 2>/dev/null || true
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
# Model the fleet state before the community health files left the root:
# CODE_OF_CONDUCT.md rendered and manifest-classed there (its move is a
# plain re-render plus retired-file cleanup, no migration rung).
mv "$OLD_TREE/template/.github/CODE_OF_CONDUCT.md.jinja" \
  "$OLD_TREE/template/CODE_OF_CONDUCT.md.jinja"
sed 's|%}\.github/CODE_OF_CONDUCT\.md{%|%}/CODE_OF_CONDUCT.md{%|' "$OLD_TREE/copier.yml" \
  > "$OLD_TREE/copier.coc.tmp"
mv "$OLD_TREE/copier.coc.tmp" "$OLD_TREE/copier.yml"
grep -qF '%}/CODE_OF_CONDUCT.md{%' "$OLD_TREE/copier.yml" \
  || fail "could not point the old fixture's CODE_OF_CONDUCT.md exclude at the root path"
sed -e 's|"\.github/CODE_OF_CONDUCT\.md"|"CODE_OF_CONDUCT.md"|' \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  > "$OLD_TREE/manifest.community.tmp"
mv "$OLD_TREE/manifest.community.tmp" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja"
grep -qF '"CODE_OF_CONDUCT.md"' "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  || fail "could not model the pre-move manifest entry for the root CODE_OF_CONDUCT.md"
# The old build predates the security policy's move: SECURITY.md rendered
# and manifest-classed at the root, and the ladder's rung for the move
# absent - so the runner below must find the rung pending.
mv "$OLD_TREE/template/.github/SECURITY.md.jinja" "$OLD_TREE/template/SECURITY.md.jinja"
sed -e 's|"\.github/SECURITY\.md"|"SECURITY.md"|' \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  > "$OLD_TREE/manifest.security.tmp"
mv "$OLD_TREE/manifest.security.tmp" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja"
grep -qF '"SECURITY.md"' "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  || fail "could not model the pre-move manifest entry for the root SECURITY.md"
test -f "$OLD_TREE/migrations/m0001_security_policy_to_github.ts" \
  || fail "the fresh build tree carries no rung file for m0001_security_policy_to_github (is the rung still on the ladder?)"
rm "$OLD_TREE/migrations/m0001_security_policy_to_github.ts"
# The old build predates the fold of agents, auto-assign, and settings-sync
# into the base tree: the three were module CHOICES, their files landed only
# when selected (the generated _exclude gates and the manifest template's
# module gates), and the ladder's rung for the fold was absent - so the
# runner below must find m0002 pending. Modeled on the current tree: the
# rendered files are byte-identical to today's base render, which is what
# lets the main leg assert they land UNCHANGED.
test -f "$OLD_TREE/migrations/m0002_fold_base_modules.ts" \
  || fail "the fresh build tree carries no rung file for m0002_fold_base_modules (is the rung still on the ladder?)"
rm "$OLD_TREE/migrations/m0002_fold_base_modules.ts"
[ "$(grep -c '^  choices:$' "$OLD_TREE/copier.yml")" = "1" ] \
  || fail "the old fixture's copier.yml does not carry exactly one 'choices:' block to model the folded choices in"
awk '{ print } $0 == "  choices:" && !done {
  print "    agents - AGENTS.md agent instructions, agent-file symlinks, Copilot setup and review style: agents"
  print "    auto-assign - auto-assign issues/PRs/alerts to owner: auto-assign"
  print "    settings-sync - centrally managed repo settings + repo-owned settings.yml starter: settings-sync"
  done = 1 }' "$OLD_TREE/copier.yml" > "$OLD_TREE/copier.fold.tmp"
mv "$OLD_TREE/copier.fold.tmp" "$OLD_TREE/copier.yml"
awk '{ print } /^  # BEGIN GENERATED: conditional-excludes/ && !done {
  print "  - \"{% if not ('"'"'agents'"'"' in modules) %}.github/agents.md{% endif %}\""
  print "  - \"{% if not ('"'"'agents'"'"' in modules) %}.github/copilot-instructions.md{% endif %}\""
  print "  - \"{% if not ('"'"'agents'"'"' in modules) %}.github/instructions/review.instructions.md{% endif %}\""
  print "  - \"{% if not ('"'"'settings-sync'"'"' in modules) %}.github/settings.yml{% endif %}\""
  print "  - \"{% if not ('"'"'auto-assign'"'"' in modules) %}.github/workflows/auto-assign.yml{% endif %}\""
  print "  - \"{% if not ('"'"'agents'"'"' in modules) %}.github/workflows/copilot-setup-steps.yml{% endif %}\""
  print "  - \"{% if not ('"'"'settings-sync'"'"' in modules) %}.github/workflows/settings-sync.yml{% endif %}\""
  print "  - \"{% if not ('"'"'agents'"'"' in modules) %}/AGENTS.md{% endif %}\""
  print "  - \"{% if not ('"'"'agents'"'"' in modules) %}/CLAUDE.md{% endif %}\""
  print "  - \"{% if not ('"'"'agents'"'"' in modules) %}.github/instructions{% endif %}\""
  done = 1 }' "$OLD_TREE/copier.yml" > "$OLD_TREE/copier.fold.tmp"
mv "$OLD_TREE/copier.fold.tmp" "$OLD_TREE/copier.yml"
grep -qF "settings-sync - centrally managed" "$OLD_TREE/copier.yml" \
  || fail "could not model the pre-fold module choices in the old fixture's copier.yml"
grep -qF "%}/AGENTS.md{%" "$OLD_TREE/copier.yml" \
  || fail "could not model the pre-fold _exclude gates in the old fixture's copier.yml"
# The two settings questions were asked only with settings-sync selected.
awk '/^[a-z_]+:$/ { key = $1 }
  $0 == "  default: \"\"" && (key == "homepage:" || key == "topics:") { print; print "  when: \"{{ '"'"'settings-sync'"'"' in modules }}\""; next }
  { print }' "$OLD_TREE/copier.yml" > "$OLD_TREE/copier.fold.tmp"
mv "$OLD_TREE/copier.fold.tmp" "$OLD_TREE/copier.yml"
[ "$(grep -cF "when: \"{{ 'settings-sync' in modules }}\"" "$OLD_TREE/copier.yml")" = "2" ] \
  || fail "could not gate the old fixture's homepage and topics questions on settings-sync"
gate_old_entry() { # <landed path> <module>: wrap the manifest template's entry in the module's gate
  local tpl="$OLD_TREE/template/.github/repo-platform-manifest.json.jinja"
  awk -v needle="\"$1\":" -v gate="{%- if '$2' in modules -%}" \
    '{ if (index($0, needle) && !done) { print gate; print; print "{%- endif -%}"; done = 1 } else print }' \
    "$tpl" > "$tpl.tmp"
  mv "$tpl.tmp" "$tpl"
  grep -B1 -F "\"$1\":" "$tpl" | grep -qF "'$2' in modules" \
    || fail "could not gate the old fixture's manifest entry for $1 on the $2 module"
}
for p in .github/agents.md .github/copilot-instructions.md .github/instructions/review.instructions.md \
  .github/workflows/copilot-setup-steps.yml AGENTS.md CLAUDE.md; do gate_old_entry "$p" agents; done
gate_old_entry .github/workflows/auto-assign.yml auto-assign
for p in .github/settings.yml .github/workflows/settings-sync.yml; do gate_old_entry "$p" settings-sync; done
echo "retired sentinel" > "$OLD_TREE/template/.github/retired-sentinel.txt"
# Model the fleet state before the Copilot gate moved into the ruleset: the
# old template shipped a managed rerun-copilot-gate.yml (the re-arm half of
# the retired copilot-review bridge). The new build renders no such file,
# so the sync must DELETE it in every managed repo - this pins that
# transition (a plain non-jinja file: copier copies it verbatim, which is
# all the retirement diff needs).
printf 'name: Rerun Copilot Gate\non: [pull_request_review]\n' \
  > "$OLD_TREE/template/.github/workflows/rerun-copilot-gate.yml"
# Model the fleet state before pr-title became its own natively-required
# workflow: the old build rendered no pr-title.yml (the check was a
# fleet-ci job), so the update below is what must land it. Its manifest
# append line goes with the file.
rm "$OLD_TREE/template/.github/workflows/pr-title.yml.jinja"
grep -vF "workflows/pr-title.yml" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  > "$OLD_TREE/manifest.jinja.tmp"
mv "$OLD_TREE/manifest.jinja.tmp" \
  "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja"
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
test -f AGENTS.md || fail "fixture render is missing AGENTS.md"
# The recorded answers name the three folded modules: the premise of the
# stale-answer proof below (copier must accept them on update).
for m in agents auto-assign settings-sync; do
  grep -qE -- "^- \"?$m\"?\$" .github/.copier-answers.yml \
    || fail "the fixture's recorded answers do not list the $m module"
done
test -f .github/retired-sentinel.txt || fail "synthetic fixture is missing the retired sentinel"
test -f .github/workflows/rerun-copilot-gate.yml \
  || fail "synthetic fixture is missing the retired rerun-copilot-gate.yml"
# ...and predate the files whose ARRIVAL is under test while carrying the
# machinery whose RETIREMENT is under test.
test ! -e .github/workflows/pr-title.yml \
  || fail "the synthetic old fixture must predate the standalone pr-title.yml workflow"
test -f LICENSE.md || fail "fixture render is missing the fleet LICENSE.md"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# Local modifications a real repo carries into a sync:
# - settings.yml gains a line: it is repo-owned and must SURVIVE with the
#   edit (protected in retired_paths.ts plus the preserve step below)
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
# - .repo-platform.yml still names agents, auto-assign, and settings-sync:
#   the pre-fold selection the m0002 rung must drop (selection would
#   refuse the names against the new template)
# - a pending migration rung's input (the root SECURITY.md tail below)
echo "# local settings note" >> .github/settings.yml
# SECURITY.md carries a repository-owned tail below its END marker: the
# security-policy rung must carry it byte-for-byte to .github/SECURITY.md.
test -f SECURITY.md \
  || fail "the synthetic old fixture must render SECURITY.md at the root (or the move assertions below are vacuous)"
test ! -e .github/SECURITY.md \
  || fail "the synthetic old fixture already carries .github/SECURITY.md"
printf '\nScope note: upgrade-local security tail\n' >> SECURITY.md
echo "# local checks note" >> .github/workflows/checks.yml
echo "# local issue form note" >> .github/ISSUE_TEMPLATE/bug_report.yml
# Adopting custom-license REPLACES the fleet license under the one-license
# rule: the repo's own LICENSE.md takes the rendered fleet copy's place.
echo "Repo-owned custom license" > LICENSE.md
echo "# local sentinel note" >> .github/retired-sentinel.txt
mkdir -p src
echo "repo-owned sentinel" > src/keep_me.txt
sed -e 's/]$/, "custom-license"]/' .repo-platform.yml > .repo-platform.yml.tmp
mv .repo-platform.yml.tmp .repo-platform.yml
grep -q 'custom-license' .repo-platform.yml \
  || fail "could not add custom-license to .repo-platform.yml"
for m in agents auto-assign settings-sync; do
  grep -qF "\"$m\"" .repo-platform.yml || fail "the fixture's .repo-platform.yml does not name $m"
done
# The folded files must land UNCHANGED (their templates moved to base with
# the same content), so their pre-sync bytes are the oracle.
mkdir -p "$WORK/folded-before/.github/workflows" "$WORK/folded-before/.github/instructions"
for f in .github/workflows/auto-assign.yml .github/workflows/settings-sync.yml \
  .github/workflows/copilot-setup-steps.yml .github/instructions/review.instructions.md .github/settings.yml; do
  cp "$f" "$WORK/folded-before/$f"
done
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: local modifications"

# Assemble the would-be next release INTO THE WORKSPACE CLONE, chained
# onto the previous build tag (see commit_build_tree) + a local tag.
cd "$GITHUB_WORKSPACE"
bun .github/scripts/build-branches/branch_tree.ts --dest "$NEXT_TREE"
commit_build_tree "$NEXT_TREE" "$NEW_TAG" "$prev"
git show "${prev}:copier.yml" > "$WORK/copier-old.yml"
git show "$NEW_TAG":copier.yml > "$WORK/copier-new.yml"

export PRIVATE=false
export DESCRIPTION="Upgraded description"

# The -d data mirrors reusable-template-sync: the update runs through the
# same apply_update.ts wrapper the workflow uses, with the filtered
# modules plus live private/description, so drift in any of them
# re-renders.
export TARGET_DIR="$PROJECT"
export TARGET_REF="$NEW_TAG"
OLD_SHA_RESOLVED="$(git rev-parse "${prev}^{commit}")"
# The walk's NEGATIVE CONTROL, run FIRST: with the same build on both sides
# (OLD_SHA = the new tag) every rung is crossed, so the ladder must touch
# nothing - same HEAD, clean tree, both reports written and empty. A walk
# that ran rungs regardless of the recorded build would move files here.
# The control bites only while the ladder holds a rung; an empty ladder is
# a legitimate state, announced rather than failed.
new_rungs="$(git ls-tree --name-only "$NEW_TAG" migrations/)" \
  || fail "could not list the new build tree's rung files"
if [ -n "$new_rungs" ]; then
  echo "migration ladder populated: the no-op control below is armed"
else
  echo "migration ladder empty: the no-op control below is vacuous by construction"
fi
control_head="$(git -C "$PROJECT" rev-parse HEAD)"
# The runner takes the resolved base only (the sync's resolver hands it a
# full sha), so the tag is resolved here as the workflow would.
NEW_SHA_RESOLVED="$(git rev-parse "${NEW_TAG}^{commit}")"
control_out="$(RUNNER_TEMP="$WORK" OLD_SHA="$NEW_SHA_RESOLVED" bun .github/scripts/sync/run_migrations.ts)" \
  || fail "run_migrations.ts failed with identical trees (nothing should be pending)"
# The runner's own report is checked too: an idempotent rung that ran
# anyway (an in-place verdict) leaves HEAD and the tree untouched, so the
# postconditions alone could not see it.
grep -qF "no pending migrations" <<<"$control_out" \
  || fail "the ladder did not report 'no pending migrations' with identical trees"
if grep -qE "migration m[0-9]{4}_" <<<"$control_out"; then
  fail "the ladder ran a rung although both trees carry every rung: $control_out"
fi
[ "$(git -C "$PROJECT" rev-parse HEAD)" = "$control_head" ] \
  || fail "the ladder committed although both trees carry every rung"
assert_clean_tree "$PROJECT" "the ladder modified the tree although both trees carry every rung"
for report in migrations.md migrations-review.md; do
  test -f "$WORK/$report" || fail "the ladder did not write $report on a no-op run"
  [ ! -s "$WORK/$report" ] || fail "the ladder wrote a note into $report although nothing was pending"
done
test -f "$PROJECT/SECURITY.md" \
  || fail "the ladder moved SECURITY.md although both trees carry the m0001_security_policy_to_github rung"
grep -qF '"settings-sync"' "$PROJECT/.repo-platform.yml" \
  || fail "the ladder rewrote .repo-platform.yml although both trees carry the m0002_fold_base_modules rung"
cp "$PROJECT/SECURITY.md" "$WORK/security-before-move.md"
cp "$PROJECT/.repo-platform.yml" "$WORK/registration-before-ladder.yml"
# The rung's NECESSITY: against the new template's choices, the pre-rung
# declaration is refused by module selection (a name that is not a choice
# is never silently dropped), so without m0002 the sync could not proceed.
if bun .github/scripts/sync/modules.ts --repo-file "$WORK/registration-before-ladder.yml" \
  --template-copier "$WORK/copier-new.yml" > "$WORK/selection-before-ladder.out" 2>&1; then
  fail "module selection accepted the pre-fold declaration against the new template (the m0002 rung would be unnecessary)"
fi
grep -qF "is not a choice of the selected template version" "$WORK/selection-before-ladder.out" \
  || fail "module selection refused the pre-fold declaration for another reason: $(cat "$WORK/selection-before-ladder.out")"
# THE MIGRATION LADDER (sync/run_migrations.ts), replayed BEFORE the update
# like the workflow: every rung that appears in build history after the
# old build acts on the fixture, committed so copier sees a clean tree.
RUNNER_TEMP="$WORK" OLD_SHA="$OLD_SHA_RESOLVED" bun .github/scripts/sync/run_migrations.ts \
  || fail "run_migrations.ts failed on the old-vintage fixture"
assert_clean_tree "$PROJECT" "the migration ladder left the tree dirty (copier update refuses a dirty tree)"
# One commit per pending rung, in ladder order, each as the sync identity:
# m0001's pure rename, then m0002's declaration rewrite.
[ "$(git -C "$PROJECT" rev-list --count "${control_head}..HEAD")" = "2" ] \
  || fail "the ladder did not add exactly two commits for the two pending rungs"
[ "$(git -C "$PROJECT" log -1 --format='%an <%ae> %s' HEAD~1)" = "repo-platform-sync <repo-platform-sync@users.noreply.github.com> chore: run migration m0001_security_policy_to_github" ] \
  || fail "the first rung's commit is not the sync identity's 'chore: run migration' commit: $(git -C "$PROJECT" log -1 --format='%an <%ae> %s' HEAD~1)"
[ "$(git -C "$PROJECT" log -1 --name-status --format= HEAD~1)" = "$(printf 'R100\tSECURITY.md\t.github/SECURITY.md')" ] \
  || fail "the first rung's commit is not a pure rename of SECURITY.md"
[ "$(git -C "$PROJECT" log -1 --format='%an <%ae> %s')" = "repo-platform-sync <repo-platform-sync@users.noreply.github.com> chore: run migration m0002_fold_base_modules" ] \
  || fail "the second rung's commit is not the sync identity's 'chore: run migration' commit: $(git -C "$PROJECT" log -1 --format='%an <%ae> %s')"
[ "$(git -C "$PROJECT" log -1 --name-status --format=)" = "$(printf 'M\t.repo-platform.yml')" ] \
  || fail "the second rung's commit is not a plain edit of .repo-platform.yml"
# THE MODULE FOLD: the three names left the declaration, nothing else did
# (the header comment and every other name ride through), and the note
# landed in the informational report.
for m in agents auto-assign settings-sync; do
  if grep -qF "\"$m\"" "$PROJECT/.repo-platform.yml"; then
    fail "the fold rung left $m in .repo-platform.yml"
  fi
done
for m in uv release-please issue-templates pr-title custom-license; do
  grep -qF "\"$m\"" "$PROJECT/.repo-platform.yml" || fail "the fold rung dropped $m from .repo-platform.yml"
done
grep -q "^# Generated once by" "$PROJECT/.repo-platform.yml" \
  || fail "the fold rung lost .repo-platform.yml's header comment"
# Exactly the three items left the rendered flow list (each item removed with
# its separating comma wherever copier's choice order put it); every other
# byte of the file is the pre-ladder copy's.
sed -e 's/"agents", //' -e 's/, "agents"//' -e 's/"auto-assign", //' -e 's/, "auto-assign"//' -e 's/"settings-sync", //' -e 's/, "settings-sync"//' \
  "$WORK/registration-before-ladder.yml" | cmp -s - "$PROJECT/.repo-platform.yml" \
  || fail "the fold rung's rewrite of .repo-platform.yml is not the pre-ladder copy minus exactly the three items: $(diff <(sed -e 's/"agents", //' -e 's/, "agents"//' -e 's/"auto-assign", //' -e 's/, "auto-assign"//' -e 's/"settings-sync", //' -e 's/, "settings-sync"//' "$WORK/registration-before-ladder.yml") "$PROJECT/.repo-platform.yml")"
grep -qF "MODULE FOLD" "$WORK/migrations.md" \
  || fail "the fold rung did not write its PR-body note"
[ ! -s "$WORK/migrations-review.md" ] \
  || fail "a rung held the PR for review on a routine update: $(cat "$WORK/migrations-review.md")"
# The pending rung moved the policy byte-for-byte (tail included), so the
# split-file rebuild finds the previous copy at the new path.
test ! -e "$PROJECT/SECURITY.md" \
  || fail "the security-policy rung left the root copy behind"
cmp -s "$WORK/security-before-move.md" "$PROJECT/.github/SECURITY.md" \
  || fail "the security-policy rung did not carry SECURITY.md byte-for-byte"
grep -qF "SECURITY POLICY MOVE" "$WORK/migrations.md" \
  || fail "the security-policy rung did not write its PR-body note"
# Module selection exactly as reusable-template-sync computes it, in its
# slot AFTER the ladder (a rung may rewrite .repo-platform.yml): the
# target's .repo-platform.yml filtered against the new template's choices.
MODULES="$(select_modules \
  --repo-file "$PROJECT/.repo-platform.yml" \
  --template-copier "$WORK/copier-new.yml" \
  --retired-summary "$WORK/retired-modules.txt")"
echo "selected modules: ${MODULES}"
case "$MODULES" in
  *agents* | *auto-assign* | *settings-sync*) fail "sync/modules.ts kept a folded module name after the m0002 rung: $MODULES" ;;
esac
case "$MODULES" in
  *custom-license*) : ;;
  *) fail "sync/modules.ts dropped the newly selected custom-license" ;;
esac
export MODULES
RECOVER="" bun .github/scripts/sync/apply_update.ts

# The workflow's post-update order: clean renders, split-file rebuild,
# conflict resolution with the rebuilt paths skipped, then the cleanup and
# preserve steps below. RUNNER_TEMP is $WORK, where the copier.yml
# snapshots already sit.
answers_old="$(git -C "$PROJECT" show HEAD:.github/.copier-answers.yml)"
src_path="$(sed -n 's/^_src_path: //p' <<<"$answers_old")"
test -n "$src_path" || fail ".github/.copier-answers.yml records no _src_path"
# The stamp hook quotes an all-digit sha (PyYAML would read it as an
# integer), so strip optional quotes before comparing.
old_commit="$(sed -n 's/^_commit:[[:space:]]*//p' <<<"$answers_old" \
  | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')"
[ "$old_commit" = "$OLD_SHA_RESOLVED" ] \
  || fail "recorded _commit '${old_commit}' is not the commit ${prev} names"
RUNNER_TEMP="$WORK" SRC_PATH="$src_path" OLD_SHA="$OLD_SHA_RESOLVED" \
  bun .github/scripts/sync/clean_renders.ts
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$WORK/local-carryover.md" --root "$PROJECT" \
  --needs-review "$WORK/carry-review.txt" \
  --rebuilt-paths "$WORK/split-rebuilt-paths.txt" \
  --render-dir "$WORK/render-new" --old-render-dir "$WORK/render-old"
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$WORK/dropped-local-hunks.md" --root "$PROJECT" \
  --skip "$WORK/split-rebuilt-paths.txt"
# Current copier already deletes the de-rendered sentinel during update, so
# without help the rm loop below would run over an empty set and pass even
# if it were broken. Resurrect the file the way an older copier (or a merge
# driver) can leave it, so the loop must really delete it. Same for the
# retired managed rerun-copilot-gate.yml: its retirement must provably come
# from retired_cleanup, not only from copier's own delete.
echo "retired sentinel" > "$PROJECT/.github/retired-sentinel.txt"
printf 'name: Rerun Copilot Gate\non: [pull_request_review]\n' \
  > "$PROJECT/.github/workflows/rerun-copilot-gate.yml"
RUNNER_TEMP="$WORK" SRC_PATH="$src_path" OLD_SHA="$OLD_SHA_RESOLVED" \
  bun .github/scripts/sync/retired_cleanup.ts
if grep -qF '.github/settings.yml' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the repo-owned settings.yml (protectedPaths)"
fi
if grep -qF 'checks.yml' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the generated-once checks.yml"
fi
if grep -qF '"LICENSE.md"' "$WORK/retired-paths.json"; then
  fail "retired_paths must never list the repo-owned LICENSE.md (protectedPaths)"
fi
grep -qF '.github/retired-sentinel.txt' "$WORK/retired-paths.json" \
  || fail "retired_paths did not flag the sentinel that left the render"
grep -qF '.github/retired-sentinel.txt' "$WORK/removed-paths.txt" \
  || fail "retired_cleanup's rm loop did not delete the resurrected sentinel"
grep -qF '.github/workflows/rerun-copilot-gate.yml' "$WORK/retired-paths.json" \
  || fail "retired_paths did not flag the retired rerun-copilot-gate.yml"
grep -qF '.github/workflows/rerun-copilot-gate.yml' "$WORK/removed-paths.txt" \
  || fail "retired_cleanup's rm loop did not delete the resurrected rerun-copilot-gate.yml"

# The workflow's preserve step: settings.yml and the opted-out LICENSE.md
# are repo-owned; if the update de-rendered and deleted either, it comes
# back from the base commit.
RECOVER="" RUNNER_TEMP="$WORK" bun .github/scripts/sync/preserve_repo_owned.ts

# The workflow's final stamping step: conflict resolution and the preserve
# steps can rewrite files after copier's own post-render hook stamped the
# ownership manifest, so the sync stamps once more when the tree is final.
bun actions/shared/stamp_manifest.ts --root "$PROJECT"

bun install --frozen-lockfile --cwd "$GITHUB_WORKSPACE/actions/validate-template-report"
bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$PROJECT"

cd "$PROJECT"
# _commit must record the build commit's full sha (the stamp hook rewrites
# copier's describe output from vcs_ref_hash).
[ "$(sed -n 's/^_commit:[[:space:]]*//p' .github/.copier-answers.yml \
  | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')" \
  = "$(git -C "$GITHUB_WORKSPACE" rev-parse --verify "$NEW_TAG^{commit}" || echo unresolvable)" ] \
  || fail ".github/.copier-answers.yml does not record the commit $NEW_TAG names"
# Files the template retired must be gone: the synthetic sentinel left the
# template between builds despite its local edit, and the managed
# rerun-copilot-gate.yml was retired outright when the Copilot review
# wait moved into the ruleset's required checks.
for f in .github/retired-sentinel.txt .github/workflows/rerun-copilot-gate.yml; do
  test ! -e "$f" || fail "retired file survived the update: $f"
done
# THE MODULE FOLD's postcondition on a repository that selected the three:
# their files are base content now and land UNCHANGED (byte-identical to
# the pre-sync render; the starter is untouched by construction), the
# declaration keeps the rung's rewrite, and the answers file - which copier
# rewrote from the filtered -d selection, accepting the stale recorded
# list that still named the three - carries the filtered list.
for f in .github/workflows/auto-assign.yml .github/workflows/settings-sync.yml \
  .github/workflows/copilot-setup-steps.yml .github/instructions/review.instructions.md .github/settings.yml; do
  cmp -s "$WORK/folded-before/$f" "$f" || fail "the folded file $f did not land unchanged"
done
[ "$(readlink CLAUDE.md)" = "AGENTS.md" ] \
  && [ "$(readlink .github/agents.md)" = "../AGENTS.md" ] \
  && [ "$(readlink .github/copilot-instructions.md)" = "../AGENTS.md" ] \
  || fail "an agent-file symlink did not survive the fold with its target"
for m in agents auto-assign settings-sync; do
  if grep -qF "\"$m\"" .repo-platform.yml; then
    fail ".repo-platform.yml still lists $m after the update"
  fi
done
# The recorded `modules` block itself (the items under that key, quotes
# stripped, in copier's choice order), not any list in the file.
recorded_modules="$(awk '/^modules:/ { on = 1; next } on && /^- / { sub(/^- /, ""); sub(/^["\x27]/, ""); sub(/["\x27]$/, ""); print; next } on { exit }' .github/.copier-answers.yml | tr '\n' ' ')"
[ "$recorded_modules" = "uv release-please issue-templates pr-title custom-license " ] \
  || fail "the recorded modules list is not exactly the five surviving modules in choice order: ${recorded_modules}"
# settings.yml is repo-owned (PROTECTED_PATHS + the preserve step): the
# update must leave the file AND its local edit alone.
test -f .github/settings.yml || fail "repo-owned settings.yml was deleted"
grep -qF "# local settings note" .github/settings.yml \
  || fail "repo-owned settings.yml lost its local modification"
grep -q '^modules:' .repo-platform.yml \
  || fail ".repo-platform.yml has no top-level modules key"
# Repo-owned sentinels survive untouched.
[ "$(cat src/keep_me.txt)" = "repo-owned sentinel" ] \
  || fail "repo-owned src/keep_me.txt was modified"
grep -qF "# local checks note" .github/workflows/checks.yml \
  || fail "generated-once checks.yml lost its local modification"
grep -qF "# local issue form note" .github/ISSUE_TEMPLATE/bug_report.yml \
  || fail "generated-once bug_report.yml lost its local modification (_skip_if_exists must hold)"
# LICENSE.md opted out via the custom-license module: the repo's own
# license must survive the update, the de-render, and the retired-file
# cleanup.
[ "$(cat LICENSE.md)" = "Repo-owned custom license" ] \
  || fail "the repo-owned LICENSE.md was modified despite the custom-license opt-out"
# Public-only community files must be in the updated render (they arrive
# via the update when the old fixture predates them), and ci.yml must
# carry the in-run gate after the update.
test -f CONTRIBUTING.md || fail "CONTRIBUTING.md is missing after the public update"
# THE COMMUNITY-FILE MOVE: CODE_OF_CONDUCT.md lands under .github/ and
# leaves the root through the re-render plus retired-file cleanup.
test -f .github/CODE_OF_CONDUCT.md \
  || fail ".github/CODE_OF_CONDUCT.md is missing after the public update"
test ! -e CODE_OF_CONDUCT.md \
  || fail "the root CODE_OF_CONDUCT.md survived the move to .github/"
# SECURITY.md's repository-owned tail rode the rung's move, and the rename
# must not read as a split-file deletion (nothing left the repository).
test -f .github/SECURITY.md || fail ".github/SECURITY.md is missing after the update"
test ! -e SECURITY.md || fail "the root SECURITY.md survived the move to .github/"
grep -qF "upgrade-local security tail" .github/SECURITY.md \
  || fail "the security policy's repository-owned tail did not ride the move into .github/SECURITY.md"
test -f "$WORK/removed-splits.md" \
  || fail "the preserve step wrote no removed-splits report (the hold's absence cannot be judged)"
if grep -qF '`SECURITY.md`' "$WORK/removed-splits.md"; then
  fail "the security-policy rung still raised the removed-splits hold for SECURITY.md (the rename must be lossless, not held)"
fi
grep -qF -- "repo-platform/.github/workflows/fleet-ci.yml@build" .github/workflows/ci.yml \
  || fail "ci.yml does not call fleet-ci at the build ref after the update"
# The gate: ci.yml's own all-green job is the required check, judged
# through the shared action at the build ref.
grep -qxF -- "  all-green:" .github/workflows/ci.yml \
  || fail "the updated ci.yml lacks the all-green gate job"
grep -qxF -- "    needs: [checks, ci]" .github/workflows/ci.yml \
  || fail "the updated all-green job does not need both caller jobs"
grep -qxF -- "    if: always()" .github/workflows/ci.yml \
  || fail "the updated all-green job is not unconditional over failures (if: always())"
grep -qF -- "repo-platform/actions/all-green@build" .github/workflows/ci.yml \
  || fail "the updated all-green job does not judge through the shared action at the build ref"
# The repo-owned post-green hook and the release leg ride downstream of the
# gate in ci.yml; the release also waits for the hook and passes the judged
# sha into a release.yml that declares and reads the input. Each needs line
# is asserted inside ITS job's block: a whole-file grep for a needs line
# would be satisfied by the other downstream job.
job_block() { # <job id> <workflow file> -> the job's own lines
  awk -v job="  $1:" '$0 == job { on = 1; next } on && /^  [A-Za-z0-9_-]+:/ { exit } on { print }' "$2"
}
grep -qxF -- "  post-green:" .github/workflows/ci.yml \
  || fail "the updated ci.yml lacks the post-green hook caller"
# The caller's target must arrive with it: the repo-owned starter, callable
# with the sha input the caller passes (a caller rendered without its
# starter fails every push to main).
test -f .github/workflows/post-green.yml \
  || fail "the update rendered the post-green caller without the post-green.yml starter"
grep -qxF -- "  workflow_call:" .github/workflows/post-green.yml \
  || fail "the updated post-green.yml starter is not workflow_call-triggered"
awk '$0 == "  workflow_call:" { on = 1; next } on && /^  [A-Za-z0-9_-]+:/ { exit } on { print }' \
  .github/workflows/post-green.yml | grep -qxF -- "      sha:" \
  || fail "the updated post-green.yml starter does not declare the sha input under workflow_call"
job_block post-green .github/workflows/ci.yml | grep -qxF -- "    needs: [all-green]" \
  || fail "the updated post-green hook does not run downstream of the gate"
grep -qxF -- "  release:" .github/workflows/ci.yml \
  || fail "the updated ci.yml lacks the release leg (release-please is selected)"
job_block release .github/workflows/ci.yml | grep -qxF -- "    needs: [all-green, post-green]" \
  || fail "the updated release leg does not wait for both the gate and the post-green hook"
job_block release .github/workflows/ci.yml | grep -qxF -- "      needs.all-green.result == 'success' &&" \
  || fail "the updated release leg is not gated on the all-green result"
job_block release .github/workflows/ci.yml | grep -qxF -- "      needs.post-green.result == 'success' &&" \
  || fail "the updated release leg is not gated on the post-green result"
job_block release .github/workflows/ci.yml | grep -qxF -- '      sha: ${{ github.sha }}' \
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
# entries follow the new selection (the folded files as base entries, the
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
[ "$(mf ".github/workflows/settings-sync.yml" class)" = "managed" ] \
  || fail "the manifest does not list settings-sync.yml as managed base content"
[ "$(mf "AGENTS.md" class)" = "split" ] \
  || fail "the manifest does not list AGENTS.md as a split base file"
[ "$(mf ".github/settings.yml" class)" = "starter" ] \
  || fail "the manifest does not list the settings.yml starter"
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
[ "$(mf ".github/repo-platform-manifest.json" commit)" = "$(git -C "$GITHUB_WORKSPACE" rev-parse --verify "$NEW_TAG^{commit}" || echo unresolvable)" ] \
  || fail "the manifest's provenance commit was not stamped with the updated render's _commit"
echo "upgrade path OK: retired files deleted, sentinels preserved, configuration kept, folded modules dropped from the declaration"

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
printf 'mirrors:\n  - source: .github/SECURITY.md\n    targets:\n      - copies/SECURITY.md\n' \
  >> .repo-platform.yml
cp .repo-platform.yml "$WORK/registration-before-recopy.yml"
# Repo-owned content the local-content carry must bring back over the re-render (the ci.yml
# edit above must drop): tails below END markers, plus a .gitignore entry ABOVE the BEGIN marker.
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

# The recovery leg runs the wrapper, the local-content carry, and the repo-owned preserve step
# in the workflow's order (TARGET_DIR still exported), proving their RECOVER routing.
# The migration ladder runs first as in the workflow, with the empty OLD_SHA recovery resolves:
# no base tree, so EVERY rung runs - and this fixture crossed them all in the main leg, so each
# is idempotent here: same HEAD, clean tree, both reports written and empty. (A recovery over a
# pre-move fixture is the rung's own unit test.)
recovery_head="$(git rev-parse HEAD)"
recovery_out="$(RUNNER_TEMP="$WORK" OLD_SHA="" PLATFORM_DIR="$GITHUB_WORKSPACE" \
  bun "$GITHUB_WORKSPACE/.github/scripts/sync/run_migrations.ts")" \
  || fail "run_migrations.ts failed on the recovery leg (no base tree)"
# Every rung file on the new tree must have RUN exactly once, in ladder
# (filename) order, and reported a verdict: the no-op postconditions alone
# cannot tell a skipped rung from an idempotent one.
recovery_rungs="$(git -C "$GITHUB_WORKSPACE" ls-tree --name-only "$NEW_TAG" migrations/ | sed -e 's|^migrations/||' -e 's|\.ts$||')" \
  || fail "could not list the new build tree's rung files on the recovery leg"
recovery_ran="$(sed -nE 's/^.*: migration (m[0-9]{4}_[a-z0-9_]+) -> .*$/\1/p' <<<"$recovery_out")"
[ "$recovery_ran" = "$recovery_rungs" ] \
  || fail "the ladder did not run exactly the new tree's rungs once each, in order, on the recovery leg (ran: $(tr '\n' ' ' <<<"$recovery_ran"); rungs: $(tr '\n' ' ' <<<"$recovery_rungs"))"
[ "$(git rev-parse HEAD)" = "$recovery_head" ] \
  || fail "the ladder committed on the recovery leg although every rung was already crossed"
assert_clean_tree . "the ladder modified the tree on the recovery leg although every rung was already crossed"
for report in migrations.md migrations-review.md; do
  test -f "$WORK/$report" || fail "the ladder did not write $report on the recovery leg"
  [ ! -s "$WORK/$report" ] || fail "the ladder wrote a note into $report on the recovery leg"
done
RECOVER=recopy bun "$GITHUB_WORKSPACE/.github/scripts/sync/apply_update.ts"
bun "$GITHUB_WORKSPACE/.github/scripts/sync/preserve_local_content.ts" \
  --summary "$WORK/local-carryover.md" --root .
RECOVER=recopy RUNNER_TEMP="$WORK" bun "$GITHUB_WORKSPACE/.github/scripts/sync/preserve_repo_owned.ts"
bun "$GITHUB_WORKSPACE/actions/shared/stamp_manifest.ts" --root "$PROJECT"

[ "$(sed -n 's/^_commit:[[:space:]]*//p' .github/.copier-answers.yml \
  | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')" \
  = "$(git -C "$GITHUB_WORKSPACE" rev-parse --verify "$NEW_TAG^{commit}" || echo unresolvable)" ] \
  || fail "recovery did not re-record _commit as the commit $NEW_TAG names"
grep -qF "# local checks note" .github/workflows/checks.yml \
  || fail "recovery overwrote the generated-once checks.yml (_skip_if_exists must hold under recopy --overwrite)"
grep -qF "# local issue form note" .github/ISSUE_TEMPLATE/bug_report.yml \
  || fail "recovery overwrote the generated-once bug_report.yml (_skip_if_exists must hold under recopy --overwrite)"
cmp -s "$WORK/registration-before-recopy.yml" .repo-platform.yml \
  || fail "recovery rewrote the repo-owned .repo-platform.yml (_skip_if_exists must hold under recopy --overwrite, or the mirrors declaration is silently lost)"
[ "$(cat LICENSE.md)" = "Repo-owned custom license" ] \
  || fail "recovery touched the repo-owned LICENSE.md (custom-license de-renders it; recopy deletes nothing)"
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
bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$PROJECT"
# The recopy carry steps run after copier's own stamp hook, so the final
# stamp must leave the managed ci.yml hash matching the re-rendered file.
[ "$(mf ".github/workflows/ci.yml" hash)" = "$(file_sha .github/workflows/ci.yml)" ] \
  || fail "recovery left the manifest's ci.yml hash stale (stamping after recopy)"
echo "recovery recopy OK: skip_if_exists, repo-owned files, and repo-local content preserved, managed files re-rendered"

# --- Visibility flip (public -> private) --------------------------------
# A visibility flip between syncs is carried by the update itself: it must
# drop the conditional-filename CONTRIBUTING.md render, leave the repo-owned
# settings.yml starter alone (the managed baseline follows live visibility
# centrally), and strip the codeql machinery from ci.yml. Runs on a fresh
# public fixture (selected on the pre-fold build with settings-sync, the
# fleet's real shape; the fold rung drops the name) through the same
# workflow scripts as the main leg - only the visibility changes.
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
# The CodeQL matrix is armed while public (the disarm assertion after the
# flip would be vacuous otherwise).
grep -qxF "      codeql-languages: '[\"javascript-typescript\"]'" .github/workflows/ci.yml \
  || fail "public fixture ci.yml does not arm the CodeQL matrix for javascript-typescript"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# Same pipeline as the main leg, but the live data says PRIVATE=true while
# the recorded answers still say false - the drift the sync re-renders.
cd "$GITHUB_WORKSPACE"
git show "${prev}:copier.yml" > "$VIS_WORK/copier-old.yml"
git show "$NEW_TAG":copier.yml > "$VIS_WORK/copier-new.yml"
export TARGET_DIR="$VIS"
export TARGET_REF="$NEW_TAG"
RUNNER_TEMP="$VIS_WORK" OLD_SHA="$OLD_SHA_RESOLVED" bun .github/scripts/sync/run_migrations.ts
MODULES="$(select_modules \
  --repo-file "$VIS/.repo-platform.yml" \
  --template-copier "$VIS_WORK/copier-new.yml" \
  --retired-summary "$VIS_WORK/retired-modules.txt")"
export MODULES
export PRIVATE=true
export DESCRIPTION="Visibility-flip project"
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
bun actions/shared/stamp_manifest.ts --root "$VIS"
# Deleting a split-classed file takes its repository-owned half with it,
# so the removal must raise the removed-splits hold that keeps the PR
# manual: CONTRIBUTING.md (class `split` at HEAD - the class-level rule).
test -s "$VIS_WORK/removed-splits.md" \
  || fail "the split-file deletion did not raise the removed-splits hold that keeps the PR manual"
if grep -qF '`SECURITY.md`' "$VIS_WORK/removed-splits.md"; then
  fail "the removed-splits hold names SECURITY.md on the flip (the rung's rename must not read as a deletion)"
fi
grep -qF '`CONTRIBUTING.md`' "$VIS_WORK/removed-splits.md" \
  || fail "the removed-splits hold does not name the deleted split-classed CONTRIBUTING.md"

bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$VIS"

cd "$VIS"
# SECURITY.md is visibility-independent since the ungating: it must
# survive the flip, at its new home.
test -f .github/SECURITY.md || fail ".github/SECURITY.md did not survive the flip to private"
test ! -e SECURITY.md || fail "the root SECURITY.md survived the flip (the rung must have relocated it)"
# The release leg is release-please-gated; this fixture selects no
# release-please, so no leg may render next to the gate.
if grep -qxF -- "  release:" .github/workflows/ci.yml; then
  fail "the flipped ci.yml carries a release leg without the release-please module"
fi
# The public-only base files and gates must retire on the flip.
test ! -e CONTRIBUTING.md || fail "CONTRIBUTING.md survived the flip to private"
test ! -e CODE_OF_CONDUCT.md || fail "the root CODE_OF_CONDUCT.md survived the flip to private"
test ! -e .github/CODE_OF_CONDUCT.md || fail ".github/CODE_OF_CONDUCT.md rendered on the flip to private"
# The manifest's visibility-gated entries must retire with the flip (its
# entries render under the same `not private` gates as the files).
[ "$(mf "CONTRIBUTING.md" class)" = "absent" ] \
  || fail "the manifest still lists CONTRIBUTING.md after the flip to private"
# The license is visibility-independent and (without custom-license)
# template-managed: the flip must leave the fleet LICENSE.md in place.
fleet_license="$(rendered_fleet_license)"
[ -n "$fleet_license" ] || fail "could not render the fleet license"
case "$(cat LICENSE.md)" in
  "$fleet_license"*) ;;
  *) fail "the fleet license is not a prefix of LICENSE.md after the flip to private" ;;
esac
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
  -d 'modules=[]' \
  -d private="false"
cd "$DEL"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"
git rm -q LICENSE.md
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: delete LICENSE.md"
cd "$GITHUB_WORKSPACE"
export MODULES='[]'
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
insert_above_sentinel "$NEXT_SPLIT/template/.github/SECURITY.md.jinja" \
  "Split-rebuild fixture managed line (security)."
# The mirror leg's template change: the fleet LICENSE's managed region
# moves, so the materialized mirrors below must carry the NEW bytes (a
# sync that rewrote only the rendered source once left every declared
# byte-identical copy stale on each LICENSE template change).
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
  -d 'modules=[]' \
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
awk 'NR == 2 { print "split-local hand edit inside the managed region" } { print }' .github/SECURITY.md > .github/SECURITY.md.tmp
mv .github/SECURITY.md.tmp .github/SECURITY.md
grep -qF "split-local hand edit" .github/SECURITY.md || fail "could not plant the managed-region edit"
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
# materialize mirrors, stamp, validate.
cd "$GITHUB_WORKSPACE"
export MODULES='[]'
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
bun actions/shared/stamp_manifest.ts --root "$SPLIT"
bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$SPLIT"

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
cmp -s "$SPLIT_WORK/render-new/.github/SECURITY.md" .github/SECURITY.md \
  || fail ".github/SECURITY.md is not byte-equal to render-new after the managed-region reset"
if grep -qF "split-local hand edit" .github/SECURITY.md; then
  fail "the hand edit inside SECURITY.md's managed region survived the rebuild"
fi
grep -q '^\.github/SECURITY\.md: managed-region edits reset' "$SPLIT_WORK/carry-review.txt" \
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
  for f in AGENTS.md .github/SECURITY.md .gitignore; do
    if grep -qF "\`$f\`" "$SPLIT_WORK/dropped-local-hunks.md"; then
      fail "split file $f appeared in the dropped-hunks summary"
    fi
  done
fi
if grep -rIqF "$split_marker" . --exclude-dir=.git; then
  fail "the split-file rebuild left unresolved copier conflict markers"
fi
echo "split-file rebuild OK: sides byte-preserved, managed regions byte-equal to render-new, managed-region edit reset and flagged"

# Mirror materialization: every declared mirror is
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
      - .github/SECURITY.md
EOF
} > .repo-platform.yml.tmp
mv .repo-platform.yml.tmp .repo-platform.yml
git add .repo-platform.yml
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: hostile mirror fixture"
RUNNER_TEMP="$HOSTILE_WORK" \
  bun "$GITHUB_WORKSPACE/.github/scripts/sync/materialize_mirrors.ts" --root "$SPLIT"
test ! -e "$RUN_DIR/mirror-escape.md" || fail "a traversal mirror target escaped the repository"
cmp -s "$SPLIT_WORK/render-new/.github/SECURITY.md" .github/SECURITY.md \
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
  -d 'modules=[custom-license]' \
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
export MODULES='["custom-license"]'
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
bun actions/shared/stamp_manifest.ts --root "$UNSEL"
bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$UNSEL"
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
  -d 'modules=[]' \
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
  RECOVER="" VALIDATION=passed HIDE_DETAILS="" \
  DRIFT_FILE="$TRIP_WORK/empty.txt" CARRIED_FILE="$TRIP_WORK/empty.txt" \
  CARRY_REVIEW_FILE="$TRIP_WORK/empty.txt" RETIRED_MODULES_FILE="$TRIP_WORK/empty.txt" \
  REMOVED_PATHS_FILE="$TRIP_WORK/empty.txt" WITHHELD_FILE="$TRIP_WORK/empty.txt" \
  MANIFEST_LICENSE_FILE="$TRIP_WORK/empty.txt" SUMMARY_FILE="$TRIP_WORK/empty.txt" \
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

# --- Split-file retirement (a visibility flip de-renders CONTRIBUTING.md) --
# A render condition turning false retires a file from the render, and a
# retired file HEAD's manifest classes `split` carries a repository-owned
# half that leaves WITH the deletion (copier resolves delete-vs-modify by
# dropping the file; retired_cleanup rms retired paths outright). No module
# ships a split file, so the public-only CONTRIBUTING.md going private is
# the case. The class-level hold (preserve_repo_owned.ts ->
# removed-splits.md -> open_pr.ts) must name the leaving content and keep
# the PR manual - on this rule ALONE: no license machinery is involved in
# this leg, and the tail tripwire must stay clear (the retired path is
# absent from the post-sync manifest by design, so the wire never visits
# it).
DESEL="$RUN_DIR/upgrade-deselect"
DESEL_WORK="$RUN_DIR/upgrade-deselect-work"
mkdir -p "$DESEL_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$DESEL" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Split Retirement" \
  -d description="Split-retirement project" \
  -d 'modules=[uv]' \
  -d private="false"
cd "$DESEL"
printf '\n## Local contributing docs\n\ndeselect-local contributing tail\n' >> CONTRIBUTING.md
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with contributing tail"

# The live data says PRIVATE=true (the flip that de-renders the file), then
# the workflow's leg order: apply update, materialize renders, rebuild split files,
# resolve conflicts, retired cleanup, preserve, stamp, tripwire.
cd "$GITHUB_WORKSPACE"
export MODULES='["uv"]'
export PRIVATE=true
export DESCRIPTION="Split-retirement project"
export TARGET_DIR="$DESEL"
export TARGET_REF="$NEW_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
answers_desel="$(git -C "$DESEL" show HEAD:.github/.copier-answers.yml)"
src_path_desel="$(sed -n 's/^_src_path: //p' <<<"$answers_desel")"
test -n "$src_path_desel" || fail "split-retirement fixture records no _src_path"
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
test ! -e "$DESEL/CONTRIBUTING.md" \
  || fail "the de-rendered CONTRIBUTING.md survived retirement on the flip to private"
RECOVER="" RUNNER_TEMP="$DESEL_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
bun actions/shared/stamp_manifest.ts --root "$DESEL"
RUNNER_TEMP="$DESEL_WORK" bun .github/scripts/sync/tail_tripwire.ts --root "$DESEL"
if [ -s "$DESEL_WORK/tail-shrank.md" ]; then
  fail "the tail tripwire fired on a clean split-file retirement (the hold must come from the removal rule alone)"
fi
test -s "$DESEL_WORK/removed-splits.md" \
  || fail "deleting the split-classed CONTRIBUTING.md produced no removed-splits hold"
grep -qF '`CONTRIBUTING.md`' "$DESEL_WORK/removed-splits.md" \
  || fail "the removed-splits hold does not name CONTRIBUTING.md"
grep -qF "deselect-local contributing tail" "$DESEL_WORK/removed-splits.md" \
  || fail "the removed-splits hold does not name the leaving repository-owned content"

# The chain's tail: open_pr.ts must append the section and refuse to arm
# auto-merge on the removed-splits hold alone (the only other non-empty
# inputs - the removed-paths list and the carry summary - are
# informational and never force review; the gh stub from the tripwire leg
# records the body).
echo "build@old" > "$DESEL_WORK/old_commit.txt"
: > "$DESEL_WORK/empty.txt"
GH_CALLS="$DESEL_WORK/gh-calls.txt" PATH="$TRIP_BIN:$PATH" \
  TARGET="Vivswan/split-retirement" RUNNER_TEMP="$DESEL_WORK" \
  GITHUB_REPOSITORY="Vivswan/repo-platform" GITHUB_OUTPUT="$DESEL_WORK/gh-output.txt" \
  BRANCH=automation/repo-platform BASE_BRANCH=main DISPLAY="build@new" \
  RECOVER="" VALIDATION=passed HIDE_DETAILS="" \
  DRIFT_FILE="$DESEL_WORK/empty.txt" CARRIED_FILE="$DESEL_WORK/local-carryover.md" \
  CARRY_REVIEW_FILE="$DESEL_WORK/carry-review.txt" RETIRED_MODULES_FILE="$DESEL_WORK/empty.txt" \
  REMOVED_PATHS_FILE="$DESEL_WORK/removed-paths.txt" WITHHELD_FILE="$DESEL_WORK/empty.txt" \
  MANIFEST_LICENSE_FILE="$DESEL_WORK/empty.txt" SUMMARY_FILE="$DESEL_WORK/empty.txt" \
  bun .github/scripts/sync/open_pr.ts > "$DESEL_WORK/open-pr.out"
grep -qF "auto-merge left off" "$DESEL_WORK/open-pr.out" \
  || fail "open_pr armed auto-merge despite a deleted split-classed file"
grep -qF "deselect-local contributing tail" "$DESEL_WORK/gh-calls.txt" \
  || fail "the PR body does not name the repository-owned content the deletion takes with it"
if grep -q '^gh pr merge' "$DESEL_WORK/gh-calls.txt"; then
  fail "open_pr attempted to arm auto-merge on a removed-splits hold"
fi
echo "split-file retirement OK: de-rendered split file deleted, hold raised, leaving content named, manual review forced"

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
printf 'pages_production: main\npages_staging: false\n' >> .github/.copier-answers.yml
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init in the production/staging era"

cd "$GITHUB_WORKSPACE"
git show "${prev}:copier.yml" > "$PAGES_WORK/copier-old.yml"
git show "$NEW_TAG":copier.yml > "$PAGES_WORK/copier-new.yml"
export TARGET_DIR="$PAGES_FIX"
export TARGET_REF="$NEW_TAG"
RUNNER_TEMP="$PAGES_WORK" OLD_SHA="$OLD_SHA_RESOLVED" bun .github/scripts/sync/run_migrations.ts
if grep -qF '"auto-assign"' "$PAGES_FIX/.repo-platform.yml"; then
  fail "the fold rung left auto-assign in the pages fixture's .repo-platform.yml"
fi
MODULES="$(select_modules \
  --repo-file "$PAGES_FIX/.repo-platform.yml" \
  --template-copier "$PAGES_WORK/copier-new.yml" \
  --retired-summary "$PAGES_WORK/retired-modules.txt")"
export MODULES
export PRIVATE=false
export DESCRIPTION="Pages-retirement project"
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

# --- Module fold arrival (a repo onboarded without the three modules) -------
# A repository rendered before the fold WITHOUT agents, auto-assign, or
# settings-sync has none of their files, and may carry its OWN AGENTS.md.
# The update delivers the files as base content; the m0002 rung finds
# nothing to drop (the control: in-place, no commit); the repository's own
# AGENTS.md rides below the fresh managed region under the recovery
# appendix (HEAD's manifest never declared the path, so its copy cannot be
# split by markers), flagged for manual review; .repo-platform.yml is
# untouched; and the answers file gains the two settings questions every
# repository is asked now.
ARR="$RUN_DIR/upgrade-arrival"
ARR_WORK="$RUN_DIR/upgrade-arrival-work"
mkdir -p "$ARR_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$ARR" \
  --vcs-ref "$prev" --defaults --trust \
  -d project_name="Fold Arrival" \
  -d description="Fold-arrival project" \
  -d 'modules=[uv]' \
  -d private="false"
cd "$ARR"
# The premise: the old build gated the folded files on selection, so none
# of them rendered (`test ! -e` follows symlinks; assert not-a-link too).
for f in AGENTS.md CLAUDE.md .github/agents.md .github/copilot-instructions.md \
  .github/instructions/review.instructions.md .github/workflows/auto-assign.yml \
  .github/workflows/settings-sync.yml .github/workflows/copilot-setup-steps.yml .github/settings.yml; do
  if [ -e "$f" ] || [ -L "$f" ]; then
    fail "the pre-fold fixture rendered $f without selecting its module (the old fixture's gates are not modeled)"
  fi
done
if grep -qF '"AGENTS.md"' .github/repo-platform-manifest.json; then
  fail "the pre-fold fixture's manifest lists AGENTS.md although the file was not rendered"
fi
if grep -qE '^(homepage|topics):' .github/.copier-answers.yml; then
  fail "the pre-fold fixture recorded the settings questions without settings-sync (the old fixture's gates are not modeled)"
fi
printf '# House rules\n\narrival-local agents note\n' > AGENTS.md
cp AGENTS.md "$ARR_WORK/agents-before.md"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with the repository's own AGENTS.md"
cp .repo-platform.yml "$ARR_WORK/registration-before.yml"

cd "$GITHUB_WORKSPACE"
git show "${prev}:copier.yml" > "$ARR_WORK/copier-old.yml"
git show "$NEW_TAG":copier.yml > "$ARR_WORK/copier-new.yml"
export TARGET_DIR="$ARR"
export TARGET_REF="$NEW_TAG"
arrival_head="$(git -C "$ARR" rev-parse HEAD)"
arrival_out="$(RUNNER_TEMP="$ARR_WORK" OLD_SHA="$OLD_SHA_RESOLVED" bun .github/scripts/sync/run_migrations.ts)" \
  || fail "run_migrations.ts failed on the arrival fixture"
# The control: nothing to drop, so the fold rung reports in-place without a
# commit; the pending m0001 still moves the root SECURITY.md (one commit).
grep -qF "migration m0002_fold_base_modules -> in-place" <<<"$arrival_out" \
  || fail "the fold rung did not report in-place for a declaration naming none of the three: $arrival_out"
if grep -qF "migration m0002_fold_base_modules -> in-place (committed)" <<<"$arrival_out"; then
  fail "the fold rung committed although it had nothing to drop"
fi
[ "$(git -C "$ARR" rev-list --count "${arrival_head}..HEAD")" = "1" ] \
  || fail "the ladder did not add exactly one commit (m0001's rename) on the arrival fixture"
cmp -s "$ARR_WORK/registration-before.yml" "$ARR/.repo-platform.yml" \
  || fail "the fold rung rewrote a .repo-platform.yml naming none of the three"
MODULES="$(select_modules \
  --repo-file "$ARR/.repo-platform.yml" \
  --template-copier "$ARR_WORK/copier-new.yml" \
  --retired-summary "$ARR_WORK/retired-modules.txt")"
export MODULES
export PRIVATE=false
export DESCRIPTION="Fold-arrival project"
RECOVER="" bun .github/scripts/sync/apply_update.ts
answers_arr="$(git -C "$ARR" show HEAD:.github/.copier-answers.yml)"
src_path_arr="$(sed -n 's/^_src_path: //p' <<<"$answers_arr")"
test -n "$src_path_arr" || fail "arrival fixture records no _src_path"
RUNNER_TEMP="$ARR_WORK" SRC_PATH="$src_path_arr" OLD_SHA="$OLD_SHA_RESOLVED" \
  bun .github/scripts/sync/clean_renders.ts
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$ARR_WORK/local-carryover.md" --root "$ARR" \
  --needs-review "$ARR_WORK/carry-review.txt" \
  --rebuilt-paths "$ARR_WORK/split-rebuilt-paths.txt" \
  --render-dir "$ARR_WORK/render-new" --old-render-dir "$ARR_WORK/render-old"
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$ARR_WORK/dropped-local-hunks.md" --root "$ARR" \
  --skip "$ARR_WORK/split-rebuilt-paths.txt"
RUNNER_TEMP="$ARR_WORK" SRC_PATH="$src_path_arr" OLD_SHA="$OLD_SHA_RESOLVED" \
  bun .github/scripts/sync/retired_cleanup.ts
RECOVER="" RUNNER_TEMP="$ARR_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
bun actions/shared/stamp_manifest.ts --root "$ARR"
bun "$GITHUB_WORKSPACE/actions/validate-template/validate_generated_files.ts" "$ARR"

cd "$ARR"
# The folded files ARRIVE as base content: the managed ones, the two
# starters, and the three agent-file symlinks.
test -f AGENTS.md || fail "AGENTS.md did not arrive with the update"
# The arriving files are byte-identical to the clean render at the new ref
# (the managed ones and the two fresh starters alike; nothing merged into
# them, the repository had none of them).
for f in .github/instructions/review.instructions.md .github/workflows/auto-assign.yml \
  .github/workflows/settings-sync.yml .github/workflows/copilot-setup-steps.yml .github/settings.yml; do
  test -f "$f" || fail "the folded file $f did not arrive with the update"
  cmp -s "$ARR_WORK/render-new/$f" "$f" || fail "the arriving $f is not byte-identical to the clean render at the new ref"
done
[ "$(readlink CLAUDE.md)" = "AGENTS.md" ] \
  && [ "$(readlink .github/agents.md)" = "../AGENTS.md" ] \
  && [ "$(readlink .github/copilot-instructions.md)" = "../AGENTS.md" ] \
  || fail "an agent-file symlink did not arrive with the update pointing at AGENTS.md"
# The repository's own AGENTS.md: preserved in full BELOW the fresh managed
# region's END marker under the recovery appendix (one marker pair in the
# file), and the carry flagged for manual review.
# The previous copy carried no marker text, so the appendix is the copy
# verbatim: the file ENDS with its exact bytes.
tail -c "$(wc -c < "$ARR_WORK/agents-before.md")" AGENTS.md | cmp -s - "$ARR_WORK/agents-before.md" \
  || fail "the repository's own AGENTS.md was not preserved verbatim below the managed region when the managed file arrived"
grep -qF "repo-platform:recovery-appendix" AGENTS.md \
  || fail "the repository's own AGENTS.md copy was not marked as a recovery appendix"
# region_marker, not marker: $marker is the copier conflict marker the check
# below still reads.
for region_marker in "<!-- BEGIN REPO-PLATFORM MANAGED -->" "<!-- END REPO-PLATFORM MANAGED -->"; do
  [ "$(grep -cF -- "$region_marker" AGENTS.md)" = "1" ] \
    || fail "AGENTS.md does not carry exactly one '$region_marker' after the arrival"
done
[ "$(grep -nF -- "<!-- END REPO-PLATFORM MANAGED -->" AGENTS.md | head -n 1 | cut -d: -f1)" -lt \
  "$(grep -nF "arrival-local agents note" AGENTS.md | head -n 1 | cut -d: -f1)" ] \
  || fail "the repository's own AGENTS.md content does not sit below the managed region's END marker"
grep -q '^AGENTS\.md:' "$ARR_WORK/carry-review.txt" \
  || fail "the appendix carry of the repository's own AGENTS.md was not flagged for review"
grep -qF "recovery-appendix" "$ARR_WORK/local-carryover.md" \
  || fail "the carry summary does not state the appendix disposition"
if grep -rIqF "$marker" . --exclude-dir=.git; then
  fail "the arrival left unresolved copier conflict markers"
fi
# .repo-platform.yml is the repository's (nothing to drop, nothing rewritten);
# the answers file GAINS homepage and topics (absent above), asked of every
# repository now.
cmp -s "$ARR_WORK/registration-before.yml" .repo-platform.yml \
  || fail "the arrival update rewrote a .repo-platform.yml naming none of the three"
for key in homepage topics; do
  grep -qE "^$key:" .github/.copier-answers.yml \
    || fail "the answers file did not record the $key answer after the update"
done
echo "module fold arrival OK: folded files delivered, the repository's own AGENTS.md preserved as a reviewed appendix, rung in-place"

# --- Migration history walk (a rung pruned from the delivered tree) --------
# The ladder runs a rung from the NEWEST build commit that carries it, so a
# rung deleted from main after a repository fell behind still runs for that
# repository, from history. Chain: NEW_TAG -> P1 (adds a self-contained
# probe rung) -> P2 (the probe pruned again). A repo rendered at NEW_TAG
# syncing to P2 must run the probe, loaded from P1; the control, a repo
# rendered at P1, has crossed it and runs nothing.
PROBE_ID="m9999_harness_probe"
P1_TREE="$RUN_DIR/probe1"
P2_TREE="$RUN_DIR/probe2"
cd "$GITHUB_WORKSPACE"
cp -R "$NEXT_TREE" "$P1_TREE"
cat > "$P1_TREE/migrations/$PROBE_ID.ts" <<'PROBE'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default {
  id: "m9999_harness_probe",
  apply(target: { dir: string; oldSha: string | null; newSha: string }) {
    writeFileSync(join(target.dir, ".github", "harness-probe.txt"), `${target.oldSha}\n${target.newSha}\n`);
    Bun.spawnSync(["git", "-C", target.dir, "add", ".github/harness-probe.txt"]);
    return { kind: "verdict", verdict: { kind: "planted", note: { text: "> HARNESS PROBE ran", review: false } } };
  },
};
PROBE
commit_build_tree "$P1_TREE" "$PROBE1_TAG" "$NEW_TAG"
cp -R "$NEXT_TREE" "$P2_TREE"
commit_build_tree "$P2_TREE" "$PROBE2_TAG" "$PROBE1_TAG"
# The premise: P1 carries the probe and the delivered P2 does not (each
# listing captured with its exit code checked, so a failed ls-tree cannot
# read as absence).
p1_rungs="$(git ls-tree --name-only "$PROBE1_TAG" migrations/)" \
  || fail "could not list the probe build's rung files"
p2_rungs="$(git ls-tree --name-only "$PROBE2_TAG" migrations/)" \
  || fail "could not list the delivered build's rung files"
grep -qxF "migrations/$PROBE_ID.ts" <<<"$p1_rungs" \
  || fail "the probe build does not carry the probe rung"
if grep -qxF "migrations/$PROBE_ID.ts" <<<"$p2_rungs"; then
  fail "the delivered build still carries the probe rung (the leg would prove nothing)"
fi
P1_SHA="$(git rev-parse "$PROBE1_TAG^{commit}")"
P2_SHA="$(git rev-parse "$PROBE2_TAG^{commit}")"
walk_fixture() { # <dir> <build tag> -> a rendered, committed repo at that build
  copier copy "$GITHUB_WORKSPACE" "$1" \
    --vcs-ref "$2" --defaults --trust \
    -d project_name="History Walk" \
    -d description="History-walk project" \
    -d 'modules=[]' \
    -d private="false"
  git -C "$1" init -q -b main
  git -C "$1" add --all
  git -C "$1" -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"
}
WALK="$RUN_DIR/upgrade-walk"
WALK_WORK="$RUN_DIR/upgrade-walk-work"
mkdir -p "$WALK_WORK"
walk_fixture "$WALK" "$NEW_TAG"
# OLD_SHA exactly as the sync derives it: the fixture's own recorded _commit.
walk_recorded="$(sed -n 's/^_commit:[[:space:]]*//p' "$WALK/.github/.copier-answers.yml" \
  | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')"
[ "$walk_recorded" = "$NEW_SHA_RESOLVED" ] \
  || fail "the history-walk fixture does not record the commit $NEW_TAG names"
walk_out="$(TARGET_DIR="$WALK" TARGET_REF="$P2_SHA" RUNNER_TEMP="$WALK_WORK" OLD_SHA="$walk_recorded" \
  bun .github/scripts/sync/run_migrations.ts)" \
  || fail "run_migrations.ts failed on the history walk"
grep -qF "migration $PROBE_ID -> planted (committed)" <<<"$walk_out" \
  || fail "the pruned probe rung did not run from build history: $walk_out"
test -f "$WALK/.github/harness-probe.txt" || fail "the probe rung left no trace in the fixture"
[ "$(cat "$WALK/.github/harness-probe.txt")" = "$(printf '%s\n%s' "$NEW_SHA_RESOLVED" "$P2_SHA")" ] \
  || fail "the probe rung saw shas other than the recorded build and the delivered build"
[ "$(git -C "$WALK" log -1 --format='%an <%ae> %s')" = "repo-platform-sync <repo-platform-sync@users.noreply.github.com> chore: run migration $PROBE_ID" ] \
  || fail "the probe rung's change was not committed as the sync identity's 'chore: run migration' commit"
assert_clean_tree "$WALK" "the history walk left the tree dirty"
grep -qF "HARNESS PROBE ran" "$WALK_WORK/migrations.md" \
  || fail "the probe rung's note did not land in the PR-body report"
# The control: a repo rendered at P1 has crossed the probe, so nothing runs.
CTRL="$RUN_DIR/upgrade-walk-control"
CTRL_WORK="$RUN_DIR/upgrade-walk-control-work"
mkdir -p "$CTRL_WORK"
walk_fixture "$CTRL" "$PROBE1_TAG"
ctrl_recorded="$(sed -n 's/^_commit:[[:space:]]*//p' "$CTRL/.github/.copier-answers.yml" \
  | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')"
[ "$ctrl_recorded" = "$P1_SHA" ] \
  || fail "the control fixture does not record the probe build's commit"
ctrl_head="$(git -C "$CTRL" rev-parse HEAD)"
ctrl_out="$(TARGET_DIR="$CTRL" TARGET_REF="$P2_SHA" RUNNER_TEMP="$CTRL_WORK" OLD_SHA="$ctrl_recorded" \
  bun .github/scripts/sync/run_migrations.ts)" \
  || fail "run_migrations.ts failed on the history-walk control"
grep -qF "no pending migrations" <<<"$ctrl_out" \
  || fail "the control did not report 'no pending migrations': $ctrl_out"
if grep -qE "migration m[0-9]{4}_" <<<"$ctrl_out"; then
  fail "the control ran a rung although its recorded build carried every rung: $ctrl_out"
fi
[ "$(git -C "$CTRL" rev-parse HEAD)" = "$ctrl_head" ] \
  || fail "the control's HEAD moved although nothing was pending"
assert_clean_tree "$CTRL" "the control's tree was modified although nothing was pending"
for report in migrations.md migrations-review.md; do
  test -f "$CTRL_WORK/$report" || fail "the control did not write $report"
  [ ! -s "$CTRL_WORK/$report" ] || fail "the control wrote a note into $report although nothing was pending"
done
test ! -e "$CTRL/.github/harness-probe.txt" \
  || fail "the probe rung ran for a repository whose recorded build already carried it"
echo "migration history walk OK: a pruned rung ran from the build commit that carried it; the crossed control ran nothing"
