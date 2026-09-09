# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
# --- Tail tripwire end-to-end (workflow step -> report -> open_pr) --------
# The post-stamp tripwire chain runs nowhere else end-to-end: a repo-owned
# tail line that vanished from the working tree after the stamp must
# produce the RUNNER_TEMP report, land as a PR-body section, and force the
# manual-review path (auto-merge off). Reuses the NEW build (no extra
# tag); gh is stubbed, so open_pr.ts's body and arm decisions are
# observable without a network.
TRIP="$RUN_DIR/upgrade-trip"
TRIP_WORK="$RUN_DIR/upgrade-trip-work"
TRIP_REF="$REF_NS/new"
rm -rf "$TRIP" "$TRIP_WORK"
mkdir -p "$TRIP_WORK"
cd "$GITHUB_WORKSPACE"
copier copy "$GITHUB_WORKSPACE" "$TRIP" \
  --vcs-ref "$TRIP_REF" --defaults --trust \
  -d project_name="Tripwire" \
  -d description="Tripwire project" \
  -d 'modules=[]' \
  -d private="false"
cd "$TRIP"
printf '\n## Local agent docs\n\ntrip-local tail line\n' >> AGENTS.md
git init -q -b main
git add --all
git -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init with tail"
# The sync bug the tripwire exists for: the repo-owned tail line vanishes
# from the working tree AFTER the stamp (the manifest still declares the
# split, HEAD still holds the line).
grep -vF "trip-local tail line" AGENTS.md > AGENTS.md.tmp
mv AGENTS.md.tmp AGENTS.md
cd "$GITHUB_WORKSPACE"
# The workflow step's invocation: the report lands under RUNNER_TEMP by
# the filename constant tail_tripwire.ts shares with open_pr.ts.
RUNNER_TEMP="$TRIP_WORK" bun .github/scripts/sync/tail_tripwire.ts --root "$TRIP"
test -s "$TRIP_WORK/tail-shrank.md" \
  || fail "the tail tripwire produced no tail-shrank.md for a shrunk repo-owned tail"
grep -qF "TAIL TRIPWIRE" "$TRIP_WORK/tail-shrank.md" \
  || fail "the tripwire report lacks its warning heading"
grep -qF "trip-local tail line" "$TRIP_WORK/tail-shrank.md" \
  || fail "the tripwire report does not list the missing tail line"

# The chain's tail: open_pr.ts must append the section and refuse to arm
# auto-merge. The stub gh records its argv and serves the two reads
# open_pr makes; the body itself is the file the create call names with
# --body-file (never argv: a gh timeout prints the argv into the log).
TRIP_BIN="$TRIP_WORK/bin"
mkdir -p "$TRIP_BIN"
cat > "$TRIP_BIN/gh" <<'GHSTUB'
#!/usr/bin/env bash
set -euo pipefail
{ printf 'gh'; printf ' %s' "$@"; printf '\n'; } >> "$GH_CALLS"
case "$1 $2" in
  "pr list") printf '' ;;
  "pr create") echo "https://github.com/o/r/pull/1" ;;
  "pr view") echo "https://github.com/o/r/pull/1" ;;
  *) : ;;
esac
GHSTUB
chmod +x "$TRIP_BIN/gh"
echo "build@old" > "$TRIP_WORK/old_commit.txt"
: > "$TRIP_WORK/empty.txt"
GH_CALLS="$TRIP_WORK/gh-calls.txt" PATH="$TRIP_BIN:$PATH" \
  TARGET="Vivswan/tripwire" RUNNER_TEMP="$TRIP_WORK" \
  GITHUB_REPOSITORY="Vivswan/repo-platform" GITHUB_OUTPUT="$TRIP_WORK/gh-output.txt" \
  BRANCH=automation/repo-platform BASE_BRANCH=main DISPLAY="build@new" \
  RECOVER="" VALIDATION=passed HIDE_DETAILS="" \
  DRIFT_FILE="$TRIP_WORK/empty.txt" CARRIED_FILE="$TRIP_WORK/empty.txt" \
  CARRY_REVIEW_FILE="$TRIP_WORK/empty.txt" \
  REMOVED_PATHS_FILE="$TRIP_WORK/empty.txt" \
  MANIFEST_LICENSE_FILE="$TRIP_WORK/empty.txt" SUMMARY_FILE="$TRIP_WORK/empty.txt" \
  bun .github/scripts/sync/open_pr.ts > "$TRIP_WORK/open-pr.out"
grep -qF "auto-merge left off" "$TRIP_WORK/open-pr.out" \
  || fail "open_pr armed auto-merge despite a tripped tail tripwire"
grep -q '^gh pr create .* --body-file ' "$TRIP_WORK/gh-calls.txt" \
  || fail "open_pr never created the PR with a --body-file body"
grep -qF "TAIL TRIPWIRE" "$TRIP_WORK/pr-body.md" \
  || fail "the PR body lacks the tail tripwire section"
if grep -q '^gh pr merge' "$TRIP_WORK/gh-calls.txt"; then
  fail "open_pr attempted to arm auto-merge on a tripped run"
fi
echo "tail tripwire OK: report produced, PR-body section present, manual review forced"
