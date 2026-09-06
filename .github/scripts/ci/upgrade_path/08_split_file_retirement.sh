# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# shellcheck disable=SC2016  # assertion strings carry literal backticks
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
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
  CARRY_REVIEW_FILE="$DESEL_WORK/carry-review.txt" \
  REMOVED_PATHS_FILE="$DESEL_WORK/removed-paths.txt" \
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
