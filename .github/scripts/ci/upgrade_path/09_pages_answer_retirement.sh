# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# shellcheck disable=SC2154  # prev is assigned by the entry
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
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
  --template-copier "$PAGES_WORK/copier-new.yml")"
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
