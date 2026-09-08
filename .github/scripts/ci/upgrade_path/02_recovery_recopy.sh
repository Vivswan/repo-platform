# shellcheck shell=bash
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
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
  || fail "the ladder did not run exactly the new tree's rungs once each, in order, on the recovery leg"\
    "(ran: $(tr '\n' ' ' <<<"$recovery_ran"); rungs: $(tr '\n' ' ' <<<"$recovery_rungs"))"
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
  || fail "recovery rewrote the repo-owned .repo-platform.yml (_skip_if_exists must hold under recopy --overwrite,"\
    "or the mirrors declaration is silently lost)"
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
