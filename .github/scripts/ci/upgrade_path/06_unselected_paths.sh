# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
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
