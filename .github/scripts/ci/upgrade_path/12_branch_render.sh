# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# shellcheck disable=SC2016  # assertion strings carry literal backticks
# shellcheck disable=SC2154  # NEW_TAG, PROJECT, WORK, and the resolved shas are the entry's and the main leg's
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
# --- Branch mode: a PR branch that changes the selection gets its render -----
# The fixture (on main, synced to the fresh build by the main leg) grows a
# branch that adds the fuzzer module to .repo-platform.yml, the way a
# managed repository's PR does. The module-render check must read that
# branch as STALE (the negative control), the sync legs run against the
# branch exactly as reusable-template-sync.yml runs them in branch mode,
# and the check must then read the branch as FRESH - with the render
# landed on the branch, the default branch untouched.
echo "Testing branch mode: a selection change on a branch gets its render"
cd "$PROJECT"
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: settle the main leg's tree"
main_head="$(git rev-parse HEAD)"
git switch -q -c select-fuzzer
if grep -qF '"fuzzer"' .repo-platform.yml; then
  fail "the fixture already selects fuzzer; the branch leg needs a module to add"
fi
sed -e 's/\]$/, "fuzzer"]/' .repo-platform.yml > .repo-platform.yml.tmp
mv .repo-platform.yml.tmp .repo-platform.yml
grep -qF '"fuzzer"' .repo-platform.yml || fail "could not add fuzzer to .repo-platform.yml on the branch"
# The branch also carries a local trailing comment in the managed ci.yml:
# copier's merge keeps it (the control below), so without the managed
# delivery module-render would still read the rendered branch as stale.
echo "# local ci note" >> .github/workflows/ci.yml
git -c user.name=ci -c user.email=ci@localhost commit -qam "chore: select the fuzzer module"
branch_base="$(git rev-parse HEAD)"

# The check the fleet-ci module-render job runs, against the fixture's own
# template clone (--src) at the recorded _commit. A tree whose
# selection changed without its render must read STALE naming the two
# managed files a module adds to, with the remedy line - the control that
# proves the FRESH verdict below can fail.
render_check() { # -> the check's exit code; its output lands in $WORK/module-render.out
  local rc=0
  RUNNER_TEMP="$WORK" GITHUB_REPOSITORY="Vivswan/upgrade-test" GITHUB_HEAD_REF="select-fuzzer" \
    bun "$GITHUB_WORKSPACE/actions/module-render/src/render.ts" \
    --root "$PROJECT" --src "$GITHUB_WORKSPACE" > "$WORK/module-render.out" 2>&1 || rc=$?
  return "$rc"
}
if render_check; then
  fail "module-render read the branch as fresh before its render landed: $(cat "$WORK/module-render.out")"
fi
for line in \
  "::error file=.github/workflows/ci.yml::module-render: .github/workflows/ci.yml does not match the render of the selected modules" \
  "::error file=.github/.copier-answers.yml::module-render: .github/.copier-answers.yml does not match the render of the selected modules" \
  "push it with: gh workflow run sync-repos.yml -R Vivswan/repo-platform -f repo=Vivswan/upgrade-test -f branch=select-fuzzer"; do
  grep -qF -- "$line" "$WORK/module-render.out" \
    || fail "module-render's stale verdict lacks '$line': $(cat "$WORK/module-render.out")"
done
if grep -qF "::error file=.github/workflows/nightly-fuzz.yml" "$WORK/module-render.out"; then
  fail "module-render judged the fuzzer STARTER (starters are seeded once, never compared)"
fi
test ! -e "$WORK/module-render" || fail "module-render left its scratch render behind"

# The sync's legs against the branch, in the workflow's order and with the
# branch's selection: the same scripts the main leg ran on main, the branch
# checked out where the workflow's checkout_ref puts it.
cd "$GITHUB_WORKSPACE"
BRANCH_WORK="$RUN_DIR/branch-work"
mkdir -p "$BRANCH_WORK"
export TARGET_DIR="$PROJECT"
export TARGET_REF="$NEW_TAG"
RUNNER_TEMP="$BRANCH_WORK" OLD_SHA="$NEW_SHA_RESOLVED" bun .github/scripts/sync/run_migrations.ts \
  || fail "run_migrations.ts failed on the branch (identical builds: nothing pending)"
MODULES="$(select_modules --repo-file "$PROJECT/.repo-platform.yml" --template-copier "$WORK/copier-new.yml")"
case "$MODULES" in
  *fuzzer*) : ;;
  *) fail "sync/modules.ts did not pick up the branch's fuzzer selection: $MODULES" ;;
esac
export MODULES
RECOVER="" bun .github/scripts/sync/apply_update.ts
branch_src_path="$(sed -n 's/^_src_path: //p' "$PROJECT/.github/.copier-answers.yml")"
cp "$WORK/copier-new.yml" "$BRANCH_WORK/copier-new.yml"
cp "$WORK/copier-new.yml" "$BRANCH_WORK/copier-old.yml"
RUNNER_TEMP="$BRANCH_WORK" SRC_PATH="$branch_src_path" OLD_SHA="$NEW_SHA_RESOLVED" \
  bun .github/scripts/sync/clean_renders.ts
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$BRANCH_WORK/local-carryover.md" --root "$PROJECT" \
  --needs-review "$BRANCH_WORK/carry-review.txt" \
  --rebuilt-paths "$BRANCH_WORK/split-rebuilt-paths.txt" \
  --render-dir "$BRANCH_WORK/render-new" --old-render-dir "$BRANCH_WORK/render-old"
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$BRANCH_WORK/dropped-local-hunks.md" --root "$PROJECT" \
  --skip "$BRANCH_WORK/split-rebuilt-paths.txt"
grep -qF "# local ci note" "$PROJECT/.github/workflows/ci.yml" \
  || fail "copier's update dropped the local note from ci.yml on its own; the managed-delivery control is vacuous"
RUNNER_TEMP="$BRANCH_WORK" SRC_PATH="$branch_src_path" OLD_SHA="$NEW_SHA_RESOLVED" \
  bun .github/scripts/sync/reset_managed.ts
cmp -s "$BRANCH_WORK/render-new/.github/workflows/ci.yml" "$PROJECT/.github/workflows/ci.yml" \
  || fail "the managed delivery did not replace the branch's ci.yml with the clean render's bytes: $(diff "$BRANCH_WORK/render-new/.github/workflows/ci.yml" "$PROJECT/.github/workflows/ci.yml")"
grep -qF -- '- `.github/workflows/ci.yml`' "$BRANCH_WORK/managed-replaced.md" \
  || fail "the managed delivery's report does not name the branch's ci.yml: $(cat "$BRANCH_WORK/managed-replaced.md")"
RUNNER_TEMP="$BRANCH_WORK" SRC_PATH="$branch_src_path" OLD_SHA="$NEW_SHA_RESOLVED" \
  bun .github/scripts/sync/retired_cleanup.ts
RECOVER="" RUNNER_TEMP="$BRANCH_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
bun actions/shared/stamp_manifest.ts --root "$PROJECT"
bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$PROJECT"

# The render landed: the branch's tree carries what a fuzzer render adds,
# the local note is gone with it, and the check now reads it FRESH; nothing
# touched the default branch.
cd "$PROJECT"
if grep -qF "# local ci note" .github/workflows/ci.yml; then
  fail "the local note survived the branch render in the managed ci.yml"
fi
grep -qF -- '"fuzzer"' .github/workflows/ci.yml \
  || fail "the branch render did not add fuzzer to ci.yml's fleet-ci modules input"
grep -qE -- '^- "?fuzzer"?$' .github/.copier-answers.yml \
  || fail "the branch render did not record fuzzer in the answers file"
test -f .github/workflows/nightly-fuzz.yml \
  || fail "the branch render did not seed the fuzzer starter"
[ "$(mf ".github/workflows/nightly-fuzz.yml" class)" = "starter" ] \
  || fail "the manifest does not list the fuzzer starter after the branch render"
render_check || fail "module-render still reads the rendered branch as stale: $(cat "$WORK/module-render.out")"
grep -qF "managed files match" "$WORK/module-render.out" \
  || fail "module-render's fresh verdict lacks the match line: $(cat "$WORK/module-render.out")"
# The commit the sync's push step would make, with the branch-mode subject
# branch_subject.ts derives from the two selections (commit_push.ts's own
# push is GitHub-bound; its unit test pins the wiring).
git add --all
git -c user.name=repo-platform-sync -c user.email=repo-platform-sync@users.noreply.github.com \
  commit -q -m "chore: render the fuzzer module"
[ "$(git rev-list --count "${branch_base}..HEAD")" = "1" ] \
  || fail "the branch render is not one commit on top of the selection change"
[ "$(git rev-parse main)" = "$main_head" ] \
  || fail "the branch render moved the default branch"
git diff --quiet "main" -- .github/workflows/nightly-fuzz.yml && fail "main gained the fuzzer starter"
git switch -q main
test ! -e .github/workflows/nightly-fuzz.yml || fail "the fuzzer starter leaked onto main's tree"
echo "branch mode OK: stale before, the sync legs rendered onto the branch, fresh after, main untouched"
