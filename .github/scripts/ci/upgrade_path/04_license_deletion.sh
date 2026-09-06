# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
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
