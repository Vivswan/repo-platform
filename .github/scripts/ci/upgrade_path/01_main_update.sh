# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# shellcheck disable=SC2016  # assertion strings carry literal backticks
# shellcheck disable=SC2154  # prev is assigned by the entry
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
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

# Local modifications a real repo carries into a sync, each asserted after
# the update: repo-owned and generated-once files (settings.yml, checks.yml,
# bug_report.yml) gain edits that must SURVIVE; LICENSE.md swaps to a
# repo-owned license with the custom-license module selected (must survive
# the de-render and retired cleanup); retired-sentinel.txt is resurrected so
# its deletion provably comes from retired_cleanup.ts; src/keep_me.txt is
# never-rendered content; .repo-platform.yml still names the pre-fold
# modules the m0002 rung must drop; SECURITY.md's tail feeds the m0001 rung.
echo "# local settings note" >> .github/settings.yml
# SECURITY.md carries a repository-owned tail below its END marker: the
# security-policy rung must carry it byte-for-byte to .github/SECURITY.md.
test -f SECURITY.md \
  || fail "the synthetic old fixture must render SECURITY.md at the root (or the move assertions below are vacuous)"
test ! -e .github/SECURITY.md \
  || fail "the synthetic old fixture already carries .github/SECURITY.md"
printf '\nScope note: upgrade-local security tail\n' >> SECURITY.md
echo "# local checks note" >> .github/workflows/checks.yml
# A MANAGED file with a local trailing comment: copier's three-way merge
# keeps it (asserted below as the control), the managed delivery must
# replace the whole file with the clean render's bytes.
echo "# local ci note" >> .github/workflows/ci.yml
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
for f in .github/workflows/auto-assign.yml \
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
sync_identity="repo-platform-sync <repo-platform-sync@users.noreply.github.com>"
[ "$(git -C "$PROJECT" rev-list --count "${control_head}..HEAD")" = "2" ] \
  || fail "the ladder did not add exactly two commits for the two pending rungs"
[ "$(git -C "$PROJECT" log -1 --format='%an <%ae> %s' HEAD~1)" = "$sync_identity chore: run migration m0001_security_policy_to_github" ] \
  || fail "the first rung's commit is not the sync identity's 'chore: run migration' commit:" \
    "$(git -C "$PROJECT" log -1 --format='%an <%ae> %s' HEAD~1)"
[ "$(git -C "$PROJECT" log -1 --name-status --format= HEAD~1)" = "$(printf 'R100\tSECURITY.md\t.github/SECURITY.md')" ] \
  || fail "the first rung's commit is not a pure rename of SECURITY.md"
[ "$(git -C "$PROJECT" log -1 --format='%an <%ae> %s')" = "$sync_identity chore: run migration m0002_fold_base_modules" ] \
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
  || fail "the fold rung's rewrite of .repo-platform.yml is not the pre-ladder copy minus exactly the three items: $(diff \
    <(sed -e 's/"agents", //' -e 's/, "agents"//' -e 's/"auto-assign", //' -e 's/, "auto-assign"//' \
      -e 's/"settings-sync", //' -e 's/, "settings-sync"//' "$WORK/registration-before-ladder.yml") \
    "$PROJECT/.repo-platform.yml")"
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
  --template-copier "$WORK/copier-new.yml")"
echo "selected modules: ${MODULES}"
case "$MODULES" in
  *agents* | *auto-assign* | *settings-sync*) fail "sync/modules.ts kept a folded module name after the m0002 rung: $MODULES" ;;
esac
case "$MODULES" in
  *custom-license*) : ;;
  *) fail "sync/modules.ts dropped the newly selected custom-license" ;;
esac
export MODULES
# The seeded-answer CONTROL: this fixture RECORDED homepage and topics (the
# pre-fold render asked them with settings-sync), so live values must not
# win over the recorded ones - the answers and the starter keep "".
export HOMEPAGE="https://must-not-win.example"
export TOPICS="must,not,win"
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
# The managed delivery's CONTROL: copier's merge kept the local note in the
# managed ci.yml, so the byte-equality below can only come from the leg.
grep -qF "# local ci note" "$PROJECT/.github/workflows/ci.yml" \
  || fail "copier's update dropped the local note from ci.yml on its own; the managed-delivery control is vacuous"
RUNNER_TEMP="$WORK" SRC_PATH="$src_path" OLD_SHA="$OLD_SHA_RESOLVED" \
  bun .github/scripts/sync/reset_managed.ts
cmp -s "$WORK/render-new/.github/workflows/ci.yml" "$PROJECT/.github/workflows/ci.yml" \
  || fail "the managed delivery did not replace ci.yml with the clean render's bytes: $(diff "$WORK/render-new/.github/workflows/ci.yml" "$PROJECT/.github/workflows/ci.yml")"
grep -qF -- '- `.github/workflows/ci.yml`' "$WORK/managed-replaced.md" \
  || fail "the managed delivery's PR-body report does not name ci.yml: $(cat "$WORK/managed-replaced.md")"
# The manifest differs only in its stamp-derived hashes here, not in what
# it declares, so the report must not list it.
if grep -qF 'repo-platform-manifest.json' "$WORK/managed-replaced.md"; then
  fail "the managed delivery's PR-body report lists the manifest although only its stamped hashes differed"
fi
# Current copier already deletes the de-rendered sentinel during update, so
# without help the rm loop below would run over an empty set and pass even
# if it were broken. Resurrect the file the way an older copier (or a merge
# driver) can leave it, so the loop must really delete it. Same for the
# retired managed rerun-copilot-gate.yml and settings-sync.yml: their
# retirement must provably come from retired_cleanup, not only from
# copier's own delete.
echo "retired sentinel" > "$PROJECT/.github/retired-sentinel.txt"
printf 'name: Rerun Copilot Gate\non: [pull_request_review]\n' \
  > "$PROJECT/.github/workflows/rerun-copilot-gate.yml"
printf 'name: Settings Sync\non: [push]\n' > "$PROJECT/.github/workflows/settings-sync.yml"
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
grep -qF '.github/workflows/settings-sync.yml' "$WORK/retired-paths.json" \
  || fail "retired_paths did not flag the retired settings-sync.yml"
grep -qF '.github/workflows/settings-sync.yml' "$WORK/removed-paths.txt" \
  || fail "retired_cleanup's rm loop did not delete the resurrected settings-sync.yml"

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
# template between builds despite its local edit, the managed
# rerun-copilot-gate.yml was retired outright when the Copilot review
# wait moved into the ruleset's required checks, and the managed
# settings-sync.yml when settings became centrally applied only.
for f in .github/retired-sentinel.txt .github/workflows/rerun-copilot-gate.yml \
  .github/workflows/settings-sync.yml; do
  test ! -e "$f" || fail "retired file survived the update: $f"
done
# THE MODULE FOLD's postcondition on a repository that selected the three:
# their files are base content now and land UNCHANGED (byte-identical to
# the pre-sync render; the starter is untouched by construction), the
# declaration keeps the rung's rewrite, and the answers file - which copier
# rewrote from the filtered -d selection, accepting the stale recorded
# list that still named the three - carries the filtered list.
for f in .github/workflows/auto-assign.yml \
  .github/workflows/copilot-setup-steps.yml .github/instructions/review.instructions.md .github/settings.yml; do
  cmp -s "$WORK/folded-before/$f" "$f" || fail "the folded file $f did not land unchanged"
done
for link in CLAUDE.md:AGENTS.md .github/agents.md:../AGENTS.md .github/copilot-instructions.md:../AGENTS.md; do
  [ "$(readlink "${link%%:*}")" = "${link#*:}" ] \
    || fail "the agent-file symlink ${link%%:*} did not survive the fold with its target (points at '$(readlink "${link%%:*}")')"
done
for m in agents auto-assign settings-sync; do
  if grep -qF "\"$m\"" .repo-platform.yml; then
    fail ".repo-platform.yml still lists $m after the update"
  fi
done
# The recorded `modules` block itself (the items under that key, quotes
# stripped, in copier's choice order), not any list in the file.
recorded_modules="$(awk '
  /^modules:/ { on = 1; next }
  on && /^- / { sub(/^- /, ""); sub(/^["\x27]/, ""); sub(/["\x27]$/, ""); print; next }
  on { exit }
' .github/.copier-answers.yml | tr '\n' ' ')"
[ "$recorded_modules" = "uv release-please issue-templates pr-title custom-license " ] \
  || fail "the recorded modules list is not exactly the five surviving modules in choice order: ${recorded_modules}"
{ grep -qE "^homepage: ''$" .github/.copier-answers.yml && grep -qE "^topics: ''$" .github/.copier-answers.yml; } \
  || fail "a live homepage/topics value overrode the RECORDED answers: $(grep -E '^(homepage|topics):' .github/.copier-answers.yml | tr '\n' ' ')"
if grep -qF "must-not-win" .github/settings.yml .github/.copier-answers.yml; then
  fail "a live homepage/topics value reached a file although the answers were recorded"
fi
unset HOMEPAGE TOPICS
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
# starter fails every push to main). The old fixture never rendered it, so
# this is the new-starter CONTROL: a target without the file gets the
# template's starter and no hold is raised.
test -f .github/workflows/post-green.yml \
  || fail "the update rendered the post-green caller without the post-green.yml starter"
if [ -s "$WORK/new-starters-review.md" ]; then
  fail "the new-starter hold fired for a target that never had post-green.yml (the control must stay clear)"
fi
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
[ "$(mf ".github/workflows/ci.yml" class)" = "managed" ] \
  || fail "the manifest lost ci.yml's managed entry across the update"
[ "$(mf ".github/workflows/settings-sync.yml" class)" = "absent" ] \
  || fail "the manifest still lists the retired settings-sync.yml"
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
[ "$(mf ".github/repo-platform-manifest.json" commit)" \
  = "$(git -C "$GITHUB_WORKSPACE" rev-parse --verify "$NEW_TAG^{commit}" || echo unresolvable)" ] \
  || fail "the manifest's provenance commit was not stamped with the updated render's _commit"
echo "upgrade path OK: retired files deleted, sentinels preserved, configuration kept, folded modules dropped from the declaration"
