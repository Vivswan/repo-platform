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
# (protected from cleanup and restored if copier de-renders it). That main
# update is upgrade_path/01_main_update.sh; the numbered legs after it each
# prove one more transition (recovery, a visibility flip, the module fold's
# arrival, a rung run from build history, ...) and upgrade_path/lib.sh holds
# their shared helpers. This file owns the namespace, the cleanup, and the
# synthetic old fixture, then sources the legs in order into this shell.
#
# Both template refs must live in ONE clone (copier re-renders the old
# version from _src_path), so build trees are committed to local orphan
# refs + tags. The old fixture is SYNTHETIC: the current templates
# assembled by the current tooling, plus a sentinel file the new build no
# longer renders and the pre-transition shapes the legs model.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
GITHUB_WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
# The script cd's around; pin repo-scoped git calls and cleanup to the root.
REPO_ROOT="$(pwd)"
# The shared helpers and the legs, sourced into this shell in run order.
UPGRADE_PATH_DIR="$REPO_ROOT/.github/scripts/ci/upgrade_path"

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
# are already gone). The namespace records its owner in its own annotated
# `<namespace>/run` tag (pid, host, start time, fixture dir), which is how
# the sweeper tells a dead run's leftovers from a live run next door:
#   bun .github/scripts/ci/sweep_harness_namespaces.ts            # plan
#   bun .github/scripts/ci/sweep_harness_namespaces.ts --execute  # act
# NEVER delete another namespace by hand: its token says nothing about
# who owns it, and a wrong guess kills a live run mid-flight.
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
RUN_TAG="$REF_NS/run"
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
# the first fixture can leak it. The owner record goes last: a cleanup that
# dies halfway leaves a namespace the sweeper can still attribute.
cleanup() {
  git -C "$REPO_ROOT" worktree remove --force "$WT" 2>/dev/null || true
  git -C "$REPO_ROOT" branch -q -D "$REF_NS" 2>/dev/null || true
  git -C "$REPO_ROOT" tag -d "$OLD_TAG" "$NEW_TAG" "$SPLIT_TAG" "$PROBE1_TAG" "$PROBE2_TAG" 2>/dev/null || true
  rm -rf "$RUN_DIR"
  git -C "$REPO_ROOT" tag -d "$RUN_TAG" 2>/dev/null || true
}
trap cleanup EXIT

# The owner record, the namespace's FIRST ref: sweep_harness_namespaces.ts
# deletes a namespace only when this pid is dead on this host, and a run
# killed before writing it has left no namespace at all.
git -C "$REPO_ROOT" -c user.name=ci -c user.email=ci@localhost tag -a "$RUN_TAG" HEAD \
  -m "pid=$$ host=$(hostname) started=$(date -u +%Y-%m-%dT%H:%M:%SZ) dir=$RUN_DIR"

# shellcheck source=upgrade_path/lib.sh
source "$UPGRADE_PATH_DIR/lib.sh"

# $RUN_DIR is fresh by construction, so there is nothing of ours to clear
# first - and nothing of anyone else's to destroy, which is exactly what
# the old fixed-path cleanup did to a concurrent run.
mkdir -p "$WORK"
# Safe under concurrency: this only drops admin entries whose working tree
# directory is already GONE - it cannot touch a live run's, and it does
# NOT collect after a SIGKILLed run (the directory survives; the
# sweeper in the header attributes and collects the refs).
git worktree prune

bun install --frozen-lockfile

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
# The old build rendered a managed settings-sync.yml that the new build
# retired outright: retired-file cleanup must delete it, no rung. Planted
# before gate_old_entry wraps the manifest entries, so it rides its own gate.
printf '# This file is managed by Vivswan/repo-platform.\nname: Settings Sync\non:\n  push:\n    branches: [main]\n' \
  > "$OLD_TREE/template/.github/workflows/settings-sync.yml"
python3 - "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" <<'PY'
import sys
path = sys.argv[1]
text = open(path).read()
anchor = """{%- set _ = entries.append('    ".github/workflows/auto-assign.yml": {"class": "managed", "hash": null}') -%}\n"""
assert text.count(anchor) == 1, "the manifest template's auto-assign.yml entry is not where this harness expects it"
entry = """{%- set _ = entries.append('    ".github/workflows/settings-sync.yml": {"class": "managed", "hash": null}') -%}\n"""
open(path, "w").write(text.replace(anchor, anchor + entry))
PY
grep -qF '".github/workflows/settings-sync.yml":' "$OLD_TREE/template/.github/repo-platform-manifest.json.jinja" \
  || fail "could not model the old fixture's manifest entry for settings-sync.yml"
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
# Model the fleet state before the post-green starter existed, so the update
# introduces a NEW generated-once starter: rendered where absent (the main
# leg, the control), HELD where the repo owns a file (the visibility-flip leg).
rm "$OLD_TREE/template/.github/workflows/post-green.yml.jinja"
grep -vF "workflows/post-green.yml" \
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

# The legs, in run order. Each is sourced into this shell, so it sees the
# variables, functions, and cwd its predecessors left (the recovery leg
# starts inside the main leg's fixture, for one).
# shellcheck source=upgrade_path/01_main_update.sh
source "$UPGRADE_PATH_DIR/01_main_update.sh"
# shellcheck source=upgrade_path/02_recovery_recopy.sh
source "$UPGRADE_PATH_DIR/02_recovery_recopy.sh"
# shellcheck source=upgrade_path/03_visibility_flip.sh
source "$UPGRADE_PATH_DIR/03_visibility_flip.sh"
# shellcheck source=upgrade_path/04_license_deletion.sh
source "$UPGRADE_PATH_DIR/04_license_deletion.sh"
# shellcheck source=upgrade_path/05_split_file_rebuild.sh
source "$UPGRADE_PATH_DIR/05_split_file_rebuild.sh"
# shellcheck source=upgrade_path/06_unselected_paths.sh
source "$UPGRADE_PATH_DIR/06_unselected_paths.sh"
# shellcheck source=upgrade_path/07_tail_tripwire.sh
source "$UPGRADE_PATH_DIR/07_tail_tripwire.sh"
# shellcheck source=upgrade_path/08_split_file_retirement.sh
source "$UPGRADE_PATH_DIR/08_split_file_retirement.sh"
# shellcheck source=upgrade_path/09_pages_answer_retirement.sh
source "$UPGRADE_PATH_DIR/09_pages_answer_retirement.sh"
# shellcheck source=upgrade_path/10_module_fold_arrival.sh
source "$UPGRADE_PATH_DIR/10_module_fold_arrival.sh"
# shellcheck source=upgrade_path/11_migration_history_walk.sh
source "$UPGRADE_PATH_DIR/11_migration_history_walk.sh"
