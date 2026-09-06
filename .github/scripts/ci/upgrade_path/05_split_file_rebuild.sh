# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# shellcheck disable=SC2016  # assertion strings carry literal backticks
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
# --- Split-file structural rebuild (regenerate-and-splice) ----------------
# The primary sync path discards copier's merged result for every
# split-class file and rebuilds it structurally: the managed half from the
# clean render at the new ref, the repository-owned sides byte-for-byte
# from HEAD (preserve_local_content.ts --render-dir, files and markers
# from the new render's ownership manifest). This leg plants a local
# AGENTS.md tail, a local .gitignore entry above the managed BEGIN, and a
# hand edit INSIDE SECURITY.md's managed region, then updates to a build
# whose template changed each file's managed region - the overlap that
# used to end in merge conflicts or merge luck. Sides must ride through
# byte-preserved, managed regions must equal render-new byte-for-byte,
# the managed-region edit must be reset and flagged for review, and no
# split file may appear in the dropped-hunks summary. Self-contained: fresh fixture, its own build tag
# (the run namespace's split tag, chained on its new tag). No trap layer of
# its own any more - the one cleanup already owns every tag in the
# namespace, and nothing of a previous run can be in the way.
SPLIT="$RUN_DIR/upgrade-split"
SPLIT_WORK="$RUN_DIR/upgrade-split-work"
NEXT_SPLIT="$RUN_DIR/next-split"
mkdir -p "$SPLIT_WORK"

cd "$GITHUB_WORKSPACE"
cp -R "$NEXT_TREE" "$NEXT_SPLIT"
# Perturb the managed region of each split file in the new build: a line
# above AGENTS.md's and SECURITY.md's END marker, a pattern inside
# .gitignore's managed region.
insert_above_sentinel() { # <file> <line>
  awk -v insert="$2" \
    '{ if ($0 == "<!-- END REPO-PLATFORM MANAGED -->" && !done) { print insert; done = 1 } print }' \
    "$1" > "$1.tmp"
  mv "$1.tmp" "$1"
  grep -qF "$2" "$1" || fail "could not perturb the managed region of $1"
}
agents_tpl="$(find "$NEXT_SPLIT/template" -maxdepth 1 -name "*AGENTS.md*.jinja" | head -n 1)"
test -n "$agents_tpl" || fail "no AGENTS.md template in the assembled build tree"
insert_above_sentinel "$agents_tpl" "Split-rebuild fixture managed line (agents)."
insert_above_sentinel "$NEXT_SPLIT/template/.github/SECURITY.md.jinja" \
  "Split-rebuild fixture managed line (security)."
# The mirror leg's template change: the fleet LICENSE's managed region
# moves, so the materialized mirrors below must carry the NEW bytes (a
# sync that rewrote only the rendered source once left every declared
# byte-identical copy stale on each LICENSE template change).
insert_above_sentinel "$NEXT_SPLIT/template/LICENSE.md.jinja" \
  "Split-rebuild fixture managed line (license)."
awk '{ print } $0 == "# BEGIN REPO-PLATFORM MANAGED" && !done { print "split-rebuild-fixture.tmp"; done = 1 }' \
  "$NEXT_SPLIT/template/.gitignore.jinja" > "$NEXT_SPLIT/template/.gitignore.jinja.tmp"
mv "$NEXT_SPLIT/template/.gitignore.jinja.tmp" "$NEXT_SPLIT/template/.gitignore.jinja"
grep -qxF "split-rebuild-fixture.tmp" "$NEXT_SPLIT/template/.gitignore.jinja" \
  || fail "could not perturb .gitignore's managed section"
commit_build_tree "$NEXT_SPLIT" "$SPLIT_TAG" "$NEW_TAG"

copier copy "$GITHUB_WORKSPACE" "$SPLIT" \
  --vcs-ref "$NEW_TAG" --defaults --trust \
  -d project_name="Split Rebuild" \
  -d description="Split-rebuild project" \
  -d 'modules=[]' \
  -d private="false"
cd "$SPLIT"
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"

# The local state a real repo carries into the sync: a tail below
# AGENTS.md's END marker, a .gitignore entry above the managed BEGIN, and
# - the deliberate ownership violation - a hand edit inside SECURITY.md's
# managed region.
split_tail_body='## Local agent docs

split-local agents tail'
printf '\n%s\n' "$split_tail_body" >> AGENTS.md
awk '/^# BEGIN REPO-PLATFORM MANAGED$/ && !done { print "split-local-cache/"; done = 1 } { print }' .gitignore > .gitignore.tmp
mv .gitignore.tmp .gitignore
# The expected post-update above-side: the rebuild must carry everything
# above the managed BEGIN byte-for-byte.
awk '/^# BEGIN REPO-PLATFORM MANAGED$/ { exit } { print }' .gitignore > "$SPLIT_WORK/local-expected.txt"
awk 'NR == 2 { print "split-local hand edit inside the managed region" } { print }' .github/SECURITY.md > .github/SECURITY.md.tmp
mv .github/SECURITY.md.tmp .github/SECURITY.md
grep -qF "split-local hand edit" .github/SECURITY.md || fail "could not plant the managed-region edit"
# The mirror fixture, shaped like the skills repo: a repo-owned tail below
# LICENSE.md's END marker (the mirrors must copy the WHOLE delivered file,
# repo-owned side included), a stale copy in template/ and in one skill
# folder, a second skill folder with NO copy yet (the glob must create it
# with no declaration edit), and the repo-owned `mirrors` declaration in
# .repo-platform.yml - which must itself ride through the copier update.
printf '\nsplit-local license tail\n' >> LICENSE.md
mkdir -p skills/alpha skills/beta template
printf 'stale mirror (must be overwritten)\n' > template/LICENSE.md
printf 'stale mirror (must be overwritten)\n' > skills/alpha/LICENSE.md
printf 'name: beta\n' > skills/beta/SKILL.md
cat >> .repo-platform.yml <<'EOF'
mirrors:
  - source: LICENSE.md
    targets:
      - template/LICENSE.md
      - skills/*/LICENSE.md
EOF
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: local modifications"

# The workflow's leg order: apply update, materialize the clean renders,
# rebuild split files, resolve conflicts, retired cleanup, preserve,
# materialize mirrors, stamp, validate.
cd "$GITHUB_WORKSPACE"
export MODULES='[]'
export PRIVATE=false
export DESCRIPTION="Split-rebuild project"
export TARGET_DIR="$SPLIT"
export TARGET_REF="$SPLIT_TAG"
RECOVER="" bun .github/scripts/sync/apply_update.ts
answers_split="$(git -C "$SPLIT" show HEAD:.github/.copier-answers.yml)"
src_path_split="$(sed -n 's/^_src_path: //p' <<<"$answers_split")"
test -n "$src_path_split" || fail "split fixture records no _src_path"
RUNNER_TEMP="$SPLIT_WORK" SRC_PATH="$src_path_split" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/clean_renders.ts
bun .github/scripts/sync/preserve_local_content.ts \
  --summary "$SPLIT_WORK/local-carryover.md" --root "$SPLIT" \
  --needs-review "$SPLIT_WORK/carry-review.txt" \
  --rebuilt-paths "$SPLIT_WORK/split-rebuilt-paths.txt" \
  --render-dir "$SPLIT_WORK/render-new" --old-render-dir "$SPLIT_WORK/render-old"
bun .github/scripts/sync/resolve_copier_conflicts.ts \
  --summary "$SPLIT_WORK/dropped-local-hunks.md" --root "$SPLIT" \
  --skip "$SPLIT_WORK/split-rebuilt-paths.txt"
git show "$NEW_TAG:copier.yml" > "$SPLIT_WORK/copier-old.yml"
git show "$SPLIT_TAG:copier.yml" > "$SPLIT_WORK/copier-new.yml"
RUNNER_TEMP="$SPLIT_WORK" SRC_PATH="$src_path_split" \
  OLD_SHA="$(git rev-parse "$NEW_TAG^{commit}")" \
  bun .github/scripts/sync/retired_cleanup.ts
RECOVER="" RUNNER_TEMP="$SPLIT_WORK" bun .github/scripts/sync/preserve_repo_owned.ts
# The workflow's mirror step: materialize the repo's own declared mirror
# copies from the freshly delivered tree, before the final stamp.
RUNNER_TEMP="$SPLIT_WORK" bun .github/scripts/sync/materialize_mirrors.ts --root "$SPLIT"
bun actions/shared/stamp_manifest.ts --root "$SPLIT"
bun "$GITHUB_WORKSPACE/actions/validate-template-report/validator/validate_generated_files.ts" "$SPLIT"

cd "$SPLIT"
# AGENTS.md: managed region byte-equal to render-new, the local tail
# byte-preserved below it - the whole file is exactly render-new + tail.
{ cat "$SPLIT_WORK/render-new/AGENTS.md"; printf '\n%s\n' "$split_tail_body"; } \
  | cmp -s - AGENTS.md \
  || fail "AGENTS.md is not byte-equal to render-new plus the preserved local tail"
grep -qF "Split-rebuild fixture managed line (agents)." AGENTS.md \
  || fail "AGENTS.md did not receive the template's managed-region change"
# SECURITY.md: the hand edit inside the managed region is RESET - the file
# is byte-equal to render-new, and the reset is flagged for review.
cmp -s "$SPLIT_WORK/render-new/.github/SECURITY.md" .github/SECURITY.md \
  || fail ".github/SECURITY.md is not byte-equal to render-new after the managed-region reset"
if grep -qF "split-local hand edit" .github/SECURITY.md; then
  fail "the hand edit inside SECURITY.md's managed region survived the rebuild"
fi
grep -q '^\.github/SECURITY\.md: managed-region edits reset' "$SPLIT_WORK/carry-review.txt" \
  || fail "the managed-region reset was not flagged in the carry-review file"
grep -qF 'RESET to the fresh render' "$SPLIT_WORK/local-carryover.md" \
  || fail "the carry summary does not state the managed-region reset loudly"
# The clean carries stay auto-merge-eligible: none of AGENTS.md,
# .gitignore, or LICENSE.md (its tail is a clean side-restore) may appear
# in the review flag.
if grep -qE '^(AGENTS\.md|\.gitignore|LICENSE\.md):' "$SPLIT_WORK/carry-review.txt"; then
  fail "a clean split-file carry was flagged for review"
fi
# .gitignore: the whole above-side byte-preserved, the managed region
# (BEGIN marker to end of file - nothing sits below END here) byte-equal
# to render-new's.
awk '/^# BEGIN REPO-PLATFORM MANAGED$/ { exit } { print }' .gitignore > "$SPLIT_WORK/local-actual.txt"
cmp -s "$SPLIT_WORK/local-expected.txt" "$SPLIT_WORK/local-actual.txt" \
  || fail ".gitignore's repo-owned above-side is not byte-preserved"
awk '/^# BEGIN REPO-PLATFORM MANAGED$/, 0' .gitignore > "$SPLIT_WORK/managed-actual.txt"
awk '/^# BEGIN REPO-PLATFORM MANAGED$/, 0' "$SPLIT_WORK/render-new/.gitignore" \
  > "$SPLIT_WORK/managed-expected.txt"
cmp -s "$SPLIT_WORK/managed-expected.txt" "$SPLIT_WORK/managed-actual.txt" \
  || fail ".gitignore's managed region is not byte-equal to render-new"
grep -qxF "split-rebuild-fixture.tmp" .gitignore \
  || fail ".gitignore did not receive the template's managed-region change"
# The split files never reach the conflict resolver: no split-file section
# in the dropped-hunks summary, no leftover markers. The marker is built
# here (not reused from an earlier leg) so this block stays self-contained.
split_marker="$(printf '<%.0s' 1 2 3 4 5 6 7) before updating"
if [ -s "$SPLIT_WORK/dropped-local-hunks.md" ]; then
  for f in AGENTS.md .github/SECURITY.md .gitignore; do
    if grep -qF "\`$f\`" "$SPLIT_WORK/dropped-local-hunks.md"; then
      fail "split file $f appeared in the dropped-hunks summary"
    fi
  done
fi
if grep -rIqF "$split_marker" . --exclude-dir=.git; then
  fail "the split-file rebuild left unresolved copier conflict markers"
fi
echo "split-file rebuild OK: sides byte-preserved, managed regions byte-equal to render-new, managed-region edit reset and flagged"

# Mirror materialization: every declared mirror is
# byte-identical to the DELIVERED LICENSE.md - the fresh managed-region
# change AND the repo-owned tail included - and the glob created the copy
# the new skill folder never had, with no declaration edit. The PR-body
# note lists the writes; nothing is refused.
for m in template/LICENSE.md skills/alpha/LICENSE.md skills/beta/LICENSE.md; do
  cmp -s LICENSE.md "$m" || fail "mirror $m is not byte-identical to the delivered LICENSE.md"
done
grep -qF "Split-rebuild fixture managed line (license)." skills/alpha/LICENSE.md \
  || fail "the mirror does not carry the template's fresh managed-region change"
grep -qF "split-local license tail" skills/alpha/LICENSE.md \
  || fail "the mirror does not carry the repository-owned tail"
grep -qF '`template/LICENSE.md` <- `LICENSE.md`' "$SPLIT_WORK/mirrors.md" \
  || fail "the PR-body mirror note does not list the materialized write"
if [ -s "$SPLIT_WORK/mirrors-review.md" ]; then
  fail "clean mirror declarations were refused (mirrors-review.md is non-empty)"
fi
grep -qF 'mirrors:' .repo-platform.yml \
  || fail "the repo-owned mirrors declaration did not survive the copier update"

# (The old "recopy shape" re-run - a recovery re-render dropping the
# mirrors key from the working tree, restored from HEAD by
# restoreMirrorsKey - is structurally impossible since the registration
# file became a repo-owned starter: no sync leg rewrites an existing
# .repo-platform.yml, which the recovery leg above asserts byte-for-byte.
# The restore path was retired with it; declarationSource's HEAD preference
# keeps its own unit tests.)

# Hostile mirror declarations, committed the way a hostile repo would
# carry them (the declaration is read from HEAD): a traversal target and a
# template-owned target must be REFUSED with no write (open_pr.ts holds
# the PR for review on a non-empty mirrors-review.md).
HOSTILE_WORK="$RUN_DIR/upgrade-split-hostile"
mkdir -p "$HOSTILE_WORK"
{
  grep '^modules:' .repo-platform.yml
  cat <<'EOF'
mirrors:
  - source: LICENSE.md
    targets:
      - ../mirror-escape.md
      - .github/SECURITY.md
EOF
} > .repo-platform.yml.tmp
mv .repo-platform.yml.tmp .repo-platform.yml
git add .repo-platform.yml
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: hostile mirror fixture"
RUNNER_TEMP="$HOSTILE_WORK" \
  bun "$GITHUB_WORKSPACE/.github/scripts/sync/materialize_mirrors.ts" --root "$SPLIT"
test ! -e "$RUN_DIR/mirror-escape.md" || fail "a traversal mirror target escaped the repository"
cmp -s "$SPLIT_WORK/render-new/.github/SECURITY.md" .github/SECURITY.md \
  || fail "a template-owned mirror target was overwritten"
[ -s "$HOSTILE_WORK/mirrors-review.md" ] || fail "hostile mirror declarations were not refused"
grep -qF 'SECURITY.md' "$HOSTILE_WORK/mirrors-review.md" \
  || fail "the refusal report does not name the template-owned target"
echo "mirror materialization OK: byte-identical copies, glob-created skill copy, hostile declarations refused"
