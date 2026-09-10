// Migration history walk (a rung pruned from the delivered tree): the
// ladder runs a rung from the NEWEST build commit that carries it, so a
// rung deleted from main after a repository fell behind still runs for
// that repository, from history. Chain: new -> probe1 (adds a
// self-contained probe rung) -> probe2 (the probe pruned again). A repo
// rendered at the new build syncing to probe2 must run the probe, loaded
// from probe1; the control, a repo rendered at probe1, has crossed it and
// runs nothing.

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { linesOf } from "./edits";
import {
  answersOf,
  type Build,
  commitIdentityLine,
  describeLeg,
  type Fixture,
  git,
  isCleanTree,
  isEmptyFile,
  legTest,
  lexists,
  REPO_ROOT,
  readText,
  recordedCommit,
  renderProject,
  SYNC_IDENTITY,
  syncScript,
  upgradePathHarness,
  writeText,
} from "./fixture";

const harness = upgradePathHarness();

const PROBE_ID = "m9999_harness_probe";
const PROBE_RUNG_FILE = `migrations/${PROBE_ID}.ts`;
const PROBE_TRACE = ".github/harness-probe.txt";
const PROBE_RUNG = [
  'import { writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "export default {",
  `  id: "${PROBE_ID}",`,
  "  apply(target: { dir: string; oldSha: string | null; newSha: string }) {",
  '    writeFileSync(join(target.dir, ".github", "harness-probe.txt"), `${target.oldSha}\\n${target.newSha}\\n`);',
  '    Bun.spawnSync(["git", "-C", target.dir, "add", ".github/harness-probe.txt"]);',
  '    return { kind: "verdict", verdict: { kind: "planted", note: { text: "> HARNESS PROBE ran", review: false } } };',
  "  },",
  "};",
  "",
].join("\n");

const ANSWERS = {
  projectName: "History Walk",
  description: "History-walk project",
  modules: [],
  private: false,
};

/** A build's rung files, the listing's exit code checked before it is read. */
function rungFiles(tag: string): string[] {
  return linesOf(git(REPO_ROOT, "ls-tree", "--name-only", tag, "migrations/"));
}

describeLeg("11 migration history walk", () => {
  let fx: Fixture;
  let probe1: Build;
  let probe2: Build;

  legTest("the probe build carries the probe rung and the delivered build prunes it", () => {
    fx = harness.fixture();
    const probe1Tree = fx.copyNewTree("probe1");
    writeText(join(probe1Tree, PROBE_RUNG_FILE), PROBE_RUNG);
    probe1 = fx.commitBuildTree(probe1Tree, "probe1", fx.new);
    probe2 = fx.commitBuildTree(fx.copyNewTree("probe2"), "probe2", probe1);
    expect(rungFiles(probe1.tag)).toContain(PROBE_RUNG_FILE);
    expect(rungFiles(probe2.tag)).not.toContain(PROBE_RUNG_FILE);
  });

  legTest("a repo behind the probe runs it from the build commit that carried it", () => {
    const walk = fx.path("upgrade-walk");
    const work = fx.mkdir("upgrade-walk-work");
    renderProject(walk, fx.new.tag, ANSWERS);
    // OLD_SHA exactly as the sync derives it: the fixture's own recorded _commit.
    const recorded = recordedCommit(answersOf(walk));
    expect(recorded).toBe(fx.new.sha);
    const out = syncScript("run_migrations", {
      TARGET_DIR: walk,
      TARGET_REF: probe2.sha,
      RUNNER_TEMP: work,
      OLD_SHA: recorded,
    });
    expect(out).toContain(`migration ${PROBE_ID} -> planted (committed)`);
    expect(readText(join(walk, PROBE_TRACE))).toBe(`${fx.new.sha}\n${probe2.sha}\n`);
    expect(commitIdentityLine(walk)).toBe(`${SYNC_IDENTITY} chore: run migration ${PROBE_ID}`);
    expect(isCleanTree(walk)).toBe(true);
    expect(readText(join(work, "migrations.md"))).toContain("HARNESS PROBE ran");
  });

  legTest("the control rendered at the probe build has crossed it and runs nothing", () => {
    const control = fx.path("upgrade-walk-control");
    const work = fx.mkdir("upgrade-walk-control-work");
    renderProject(control, probe1.tag, ANSWERS);
    const recorded = recordedCommit(answersOf(control));
    expect(recorded).toBe(probe1.sha);
    const headBefore = git(control, "rev-parse", "HEAD");
    const out = syncScript("run_migrations", {
      TARGET_DIR: control,
      TARGET_REF: probe2.sha,
      RUNNER_TEMP: work,
      OLD_SHA: recorded,
    });
    expect(out).toContain("no pending migrations");
    expect(out).not.toMatch(/migration m[0-9]{4}_/);
    expect(git(control, "rev-parse", "HEAD")).toBe(headBefore);
    expect(isCleanTree(control)).toBe(true);
    for (const report of ["migrations.md", "migrations-review.md"]) {
      expect(existsSync(join(work, report))).toBe(true);
      expect(isEmptyFile(join(work, report))).toBe(true);
    }
    expect(lexists(join(control, PROBE_TRACE))).toBe(false);
  });
});
