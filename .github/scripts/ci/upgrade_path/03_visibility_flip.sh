# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# shellcheck disable=SC2016  # assertion strings carry literal backticks
# shellcheck disable=SC2154  # prev and marker are assigned by the entry and the main leg
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
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

# A repo-owned workflow at the path the NEW post-green starter lands on:
# copier keeps it without a conflict, so the sync must hold the PR and name
# the file, its template caller, and the template's starter.
test ! -e .github/workflows/post-green.yml \
  || fail "the synthetic old fixture already renders post-green.yml (the new-starter hold assertions would be vacuous)"
printf 'name: Own Hook\non: push\njobs:\n  own:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo own\n' \
  > .github/workflows/post-green.yml
cp .github/workflows/post-green.yml "$VIS_WORK/own-post-green.yml"
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: own post-green hook"

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
  --template-copier "$VIS_WORK/copier-new.yml")"
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
# THE NEW-STARTER HOLD: the kept repo-owned post-green.yml is byte-intact
# (skip_if_exists), and the hold names it, its caller ci.yml, and the
# template's starter interface (the sha input) for the reviewer.
cmp -s "$VIS_WORK/own-post-green.yml" "$VIS/.github/workflows/post-green.yml" \
  || fail "the repo-owned post-green.yml did not survive the update byte-for-byte"
test -s "$VIS_WORK/new-starters-review.md" \
  || fail "a new starter at a path the repo already owns raised no new-starters hold"
grep -qF '`.github/workflows/post-green.yml`' "$VIS_WORK/new-starters-review.md" \
  || fail "the new-starters hold does not name post-green.yml"
grep -qF 'named by `.github/workflows/ci.yml`' "$VIS_WORK/new-starters-review.md" \
  || fail "the new-starters hold does not name the template caller ci.yml"
grep -qF "        sha:" "$VIS_WORK/new-starters-review.md" \
  || fail "the new-starters hold does not show the template starter's sha input"
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
