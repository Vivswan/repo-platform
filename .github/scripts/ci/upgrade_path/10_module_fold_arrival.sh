# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# shellcheck disable=SC2016  # assertion strings carry literal backticks
# shellcheck disable=SC2154  # prev and marker are assigned by the entry and the main leg
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
# --- Module fold arrival (a repo onboarded without the three modules) -------
# A repository rendered before the fold WITHOUT agents, auto-assign, or
# settings-sync has none of their files, and may carry its OWN AGENTS.md.
# The update delivers the files as base content; the m0002 rung finds
# nothing to drop but FOLDS the repository's own copilot-instructions.md
# (a regular file where a managed symlink now lands) into AGENTS.md and
# holds the PR; the repository's own AGENTS.md, folded block included,
# rides below the fresh managed region under the recovery appendix (HEAD's
# manifest never declared the path, so its copy cannot be split by
# markers), flagged for manual review; .repo-platform.yml is untouched;
# and the answers file gains the two settings questions every repository
# is asked now.
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
# The repository's own Copilot instructions at a path the fold makes a
# managed symlink: without the rung's fold, copier replaces the file and
# its content is gone with no report (measured before the arm existed).
printf '# Our own Copilot rules\n\narrival-local copilot line\n' > .github/copilot-instructions.md
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
# Nothing to drop from the declaration, but the alias fold commits: the
# rung reports in-place+aliases (committed) and holds the PR; with m0001's
# rename that is two commits.
grep -qF "migration m0002_fold_base_modules -> in-place+aliases (committed)" <<<"$arrival_out" \
  || fail "the fold rung did not report in-place+aliases (committed) for the repository's own alias file: $arrival_out"
[ "$(git -C "$ARR" rev-list --count "${arrival_head}..HEAD")" = "2" ] \
  || fail "the ladder did not add exactly two commits (m0001's rename, m0002's alias fold) on the arrival fixture"
grep -qF "AGENT FILES FOLDED" "$ARR_WORK/migrations-review.md" \
  || fail "the alias fold did not write its review-holding note"
[ "$(git -C "$ARR" log -1 --name-status --format=)" = "$(printf 'D\t.github/copilot-instructions.md\nM\tAGENTS.md')" ] \
  || fail "the alias fold's commit is not 'remove the alias, grow AGENTS.md': $(git -C "$ARR" log -1 --name-status --format=)"
# The rung's whole output on AGENTS.md: the repository's own file, then the
# folded block for the alias, byte for byte (the block's text is the
# rung's; this harness restates it rather than importing it).
{
  printf '# House rules\n\narrival-local agents note\n'
  printf '\n## Folded from .github/copilot-instructions.md\n\n'
  printf 'This repository carried its own `.github/copilot-instructions.md` before the agent files became managed symlinks to `AGENTS.md`; '
  printf 'its content follows verbatim. Reconcile it into the sections above.\n\n'
  printf '# Our own Copilot rules\n\narrival-local copilot line\n'
} > "$ARR_WORK/agents-before.md"
cmp -s "$ARR_WORK/agents-before.md" "$ARR/AGENTS.md" \
  || fail "the fold rung's AGENTS.md is not the repository's own file plus the folded alias block:"\
    "$(diff "$ARR_WORK/agents-before.md" "$ARR/AGENTS.md")"
cmp -s "$ARR_WORK/registration-before.yml" "$ARR/.repo-platform.yml" \
  || fail "the fold rung rewrote a .repo-platform.yml naming none of the three"
MODULES="$(select_modules \
  --repo-file "$ARR/.repo-platform.yml" \
  --template-copier "$ARR_WORK/copier-new.yml")"
export MODULES
export PRIVATE=false
export DESCRIPTION="Fold-arrival project"
# The repository never recorded homepage or topics (it never selected
# settings-sync), so the sync seeds both from the LIVE repository: the
# starter must declare what the repository already shows, never clear it.
export HOMEPAGE="https://arrival.example"
export TOPICS="alpha,beta"
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
bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$ARR"

cd "$ARR"
# The folded files ARRIVE as base content: the managed ones, the two
# starters, and the three agent-file symlinks.
test -f AGENTS.md || fail "AGENTS.md did not arrive with the update"
# The arriving files are byte-identical to the clean render at the new ref
# (the managed ones and the two fresh starters alike; nothing merged into
# them, the repository had none of them).
for f in .github/instructions/review.instructions.md .github/workflows/auto-assign.yml \
  .github/workflows/copilot-setup-steps.yml .github/settings.yml; do
  test -f "$f" || fail "the folded file $f did not arrive with the update"
  cmp -s "$ARR_WORK/render-new/$f" "$f" || fail "the arriving $f is not byte-identical to the clean render at the new ref"
done
# The retired settings-sync.yml never arrives: the new build renders no such file.
test ! -e .github/workflows/settings-sync.yml \
  || fail "the retired settings-sync.yml arrived with the update"
for link in CLAUDE.md:AGENTS.md .github/agents.md:../AGENTS.md .github/copilot-instructions.md:../AGENTS.md; do
  [ "$(readlink "${link%%:*}")" = "${link#*:}" ] \
    || fail "the agent-file symlink ${link%%:*} did not arrive with the update pointing at AGENTS.md (points at '$(readlink "${link%%:*}")')"
done
# The repository's own AGENTS.md: preserved in full BELOW the fresh managed
# region's END marker under the recovery appendix (one marker pair in the
# file), and the carry flagged for manual review.
# The previous copy (house rules plus the folded Copilot rules) carried no
# marker text, so the appendix is the copy verbatim: the file ENDS with its
# exact bytes, and the folded content is in it.
tail -c "$(wc -c < "$ARR_WORK/agents-before.md")" AGENTS.md | cmp -s - "$ARR_WORK/agents-before.md" \
  || fail "the repository's own AGENTS.md was not preserved verbatim below the managed region when the managed file arrived"
grep -qF "## Folded from .github/copilot-instructions.md" AGENTS.md \
  || fail "the folded Copilot rules did not ride the appendix into the delivered AGENTS.md"
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
grep -qxF "homepage: https://arrival.example" .github/.copier-answers.yml \
  || fail "the answers file did not record the LIVE homepage: $(grep -E '^homepage:' .github/.copier-answers.yml)"
grep -qxF "topics: alpha,beta" .github/.copier-answers.yml \
  || fail "the answers file did not record the LIVE topics: $(grep -E '^topics:' .github/.copier-answers.yml)"
# The starter declares the live values (the render-new byte comparison
# above already holds, so the clean render was seeded identically).
grep -qxF '  homepage: "https://arrival.example"' .github/settings.yml \
  || fail "the settings.yml starter does not declare the live homepage (the apply would clear it)"
grep -qxF '  topics: "alpha,beta"' .github/settings.yml \
  || fail "the settings.yml starter does not declare the live topics (the apply would clear them)"
unset HOMEPAGE TOPICS
echo "module fold arrival OK: folded files delivered, the repository's own AGENTS.md and Copilot rules preserved as a reviewed appendix"
