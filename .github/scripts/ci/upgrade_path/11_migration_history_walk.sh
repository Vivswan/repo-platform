# shellcheck shell=bash
# shellcheck disable=SC2164  # strict mode is the entry's: set -e aborts the run on a failed cd
# Leg of upgrade_path_test.sh, sourced in run order after the shared setup: it shares the harness's strict mode, variables, functions, and cwd.
# --- Migration history walk (a rung pruned from the delivered tree) --------
# The ladder runs a rung from the NEWEST build commit that carries it, so a
# rung deleted from main after a repository fell behind still runs for that
# repository, from history. Chain: NEW_TAG -> P1 (adds a self-contained
# probe rung) -> P2 (the probe pruned again). A repo rendered at NEW_TAG
# syncing to P2 must run the probe, loaded from P1; the control, a repo
# rendered at P1, has crossed it and runs nothing.
PROBE_ID="m9999_harness_probe"
P1_TREE="$RUN_DIR/probe1"
P2_TREE="$RUN_DIR/probe2"
cd "$GITHUB_WORKSPACE"
cp -R "$NEXT_TREE" "$P1_TREE"
cat > "$P1_TREE/migrations/$PROBE_ID.ts" <<'PROBE'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default {
  id: "m9999_harness_probe",
  apply(target: { dir: string; oldSha: string | null; newSha: string }) {
    writeFileSync(join(target.dir, ".github", "harness-probe.txt"), `${target.oldSha}\n${target.newSha}\n`);
    Bun.spawnSync(["git", "-C", target.dir, "add", ".github/harness-probe.txt"]);
    return { kind: "verdict", verdict: { kind: "planted", note: { text: "> HARNESS PROBE ran", review: false } } };
  },
};
PROBE
commit_build_tree "$P1_TREE" "$PROBE1_TAG" "$NEW_TAG"
cp -R "$NEXT_TREE" "$P2_TREE"
commit_build_tree "$P2_TREE" "$PROBE2_TAG" "$PROBE1_TAG"
# The premise: P1 carries the probe and the delivered P2 does not (each
# listing captured with its exit code checked, so a failed ls-tree cannot
# read as absence).
p1_rungs="$(git ls-tree --name-only "$PROBE1_TAG" migrations/)" \
  || fail "could not list the probe build's rung files"
p2_rungs="$(git ls-tree --name-only "$PROBE2_TAG" migrations/)" \
  || fail "could not list the delivered build's rung files"
grep -qxF "migrations/$PROBE_ID.ts" <<<"$p1_rungs" \
  || fail "the probe build does not carry the probe rung"
if grep -qxF "migrations/$PROBE_ID.ts" <<<"$p2_rungs"; then
  fail "the delivered build still carries the probe rung (the leg would prove nothing)"
fi
P1_SHA="$(git rev-parse "$PROBE1_TAG^{commit}")"
P2_SHA="$(git rev-parse "$PROBE2_TAG^{commit}")"
walk_fixture() { # <dir> <build tag> -> a rendered, committed repo at that build
  copier copy "$GITHUB_WORKSPACE" "$1" \
    --vcs-ref "$2" --defaults --trust \
    -d project_name="History Walk" \
    -d description="History-walk project" \
    -d 'modules=[]' \
    -d private="false"
  git -C "$1" init -q -b main
  git -C "$1" add --all
  git -C "$1" -c user.name=ci -c user.email=ci@localhost commit -q -m "chore: init"
}
WALK="$RUN_DIR/upgrade-walk"
WALK_WORK="$RUN_DIR/upgrade-walk-work"
mkdir -p "$WALK_WORK"
walk_fixture "$WALK" "$NEW_TAG"
# OLD_SHA exactly as the sync derives it: the fixture's own recorded _commit.
walk_recorded="$(sed -n 's/^_commit:[[:space:]]*//p' "$WALK/.github/.copier-answers.yml" \
  | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')"
[ "$walk_recorded" = "$NEW_SHA_RESOLVED" ] \
  || fail "the history-walk fixture does not record the commit $NEW_TAG names"
walk_out="$(TARGET_DIR="$WALK" TARGET_REF="$P2_SHA" RUNNER_TEMP="$WALK_WORK" OLD_SHA="$walk_recorded" \
  bun .github/scripts/sync/run_migrations.ts)" \
  || fail "run_migrations.ts failed on the history walk"
grep -qF "migration $PROBE_ID -> planted (committed)" <<<"$walk_out" \
  || fail "the pruned probe rung did not run from build history: $walk_out"
test -f "$WALK/.github/harness-probe.txt" || fail "the probe rung left no trace in the fixture"
[ "$(cat "$WALK/.github/harness-probe.txt")" = "$(printf '%s\n%s' "$NEW_SHA_RESOLVED" "$P2_SHA")" ] \
  || fail "the probe rung saw shas other than the recorded build and the delivered build"
[ "$(git -C "$WALK" log -1 --format='%an <%ae> %s')" = "repo-platform-sync <repo-platform-sync@users.noreply.github.com> chore: run migration $PROBE_ID" ] \
  || fail "the probe rung's change was not committed as the sync identity's 'chore: run migration' commit"
assert_clean_tree "$WALK" "the history walk left the tree dirty"
grep -qF "HARNESS PROBE ran" "$WALK_WORK/migrations.md" \
  || fail "the probe rung's note did not land in the PR-body report"
# The control: a repo rendered at P1 has crossed the probe, so nothing runs.
CTRL="$RUN_DIR/upgrade-walk-control"
CTRL_WORK="$RUN_DIR/upgrade-walk-control-work"
mkdir -p "$CTRL_WORK"
walk_fixture "$CTRL" "$PROBE1_TAG"
ctrl_recorded="$(sed -n 's/^_commit:[[:space:]]*//p' "$CTRL/.github/.copier-answers.yml" \
  | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/')"
[ "$ctrl_recorded" = "$P1_SHA" ] \
  || fail "the control fixture does not record the probe build's commit"
ctrl_head="$(git -C "$CTRL" rev-parse HEAD)"
ctrl_out="$(TARGET_DIR="$CTRL" TARGET_REF="$P2_SHA" RUNNER_TEMP="$CTRL_WORK" OLD_SHA="$ctrl_recorded" \
  bun .github/scripts/sync/run_migrations.ts)" \
  || fail "run_migrations.ts failed on the history-walk control"
grep -qF "no pending migrations" <<<"$ctrl_out" \
  || fail "the control did not report 'no pending migrations': $ctrl_out"
if grep -qE "migration m[0-9]{4}_" <<<"$ctrl_out"; then
  fail "the control ran a rung although its recorded build carried every rung: $ctrl_out"
fi
[ "$(git -C "$CTRL" rev-parse HEAD)" = "$ctrl_head" ] \
  || fail "the control's HEAD moved although nothing was pending"
assert_clean_tree "$CTRL" "the control's tree was modified although nothing was pending"
for report in migrations.md migrations-review.md; do
  test -f "$CTRL_WORK/$report" || fail "the control did not write $report"
  [ ! -s "$CTRL_WORK/$report" ] || fail "the control wrote a note into $report although nothing was pending"
done
test ! -e "$CTRL/.github/harness-probe.txt" \
  || fail "the probe rung ran for a repository whose recorded build already carried it"
echo "migration history walk OK: a pruned rung ran from the build commit that carried it; the crossed control ran nothing"
