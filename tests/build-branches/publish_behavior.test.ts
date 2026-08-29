// publish.ts run for real - real git, real rsync, a stubbed gh (the
// all-green gate) - proving the no-empty-commits publish decision
// BEHAVIORALLY, where the wiring suite pins only source shape:
//
//   1. a changed composed tree publishes a stamped commit chained onto
//      the tip (also the moved-control for the skip case: the same
//      harness demonstrably CAN move the branch);
//   2. an unchanged tree under a HEALTHY tip stamp publishes NOTHING -
//      the quiet-week case, the tip must not move;
//   3. an unchanged tree under a BROKEN tip stamp publishes the recovery
//      commit - freshly stamped, tree-identical - so dispatching Build
//      Branches heals stamp damage instead of skipping forever.
//
// The harness feeds publish.ts through PREBUILT_REF (a parked pending
// tree on the fixture origin), so no compose runs and no bun child is
// spawned. publish.ts's scratch paths are the real /tmp/src,/tmp/tree,
// /tmp/pub it hardcodes: bun test runs files in one process and these
// tests serially, and publish.ts clears the paths on entry, so the
// fixture repos stay isolated per test while the scratch space is
// per-run.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingRefFor } from "../../.github/scripts/build-branches/pending.ts";
import { commitRunWrite, commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";

const script = join(import.meta.dir, "../../.github/scripts/build-branches/publish.ts");

const SERVER = "https://x.test";
const REPO = "o/r";

// The all-green gate reads check runs through gh; a completed successful
// verdict JSON greens every source, keeping the behavioral focus on the
// publish decision (the gate's own truth table lives in
// tests/shared/all_green.test.ts).
const ghStub = `#!/usr/bin/env bash
printf '%s' '{"check_runs":[{"name":"all-green","status":"completed","conclusion":"success","external_id":"workflow_run","app":{"slug":"github-actions"}}]}'
`;

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args]);
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().trimEnd();
}

interface Scenario {
  /** "same" parks a pending tree byte-identical to the build tip's;
   * "drift" makes the tip carry a different tree (the source commit's),
   * so the pending tree is a content change. */
  tipTree: "same" | "drift";
  /** The build tip's commit message; healthy scenarios stamp a real
   * on-main ancestor with the REAL writer shape. */
  tipMessage: (m1: string) => string;
  /** Plants the two measured staging-skew vectors: a .gitignore INSIDE
   * the pending tree hiding a sibling, and an info/exclude in the
   * fixture repo - which /tmp/pub, a worktree of it, inherits - hiding
   * rendered.txt. The publish must stage both hidden files anyway
   * (shared/stage_tree.ts's hermetic argv). */
  hostileIgnores?: boolean;
}

function runPublish(scenario: Scenario) {
  const root = mkdtempSync(join(tmpdir(), "publish-behavior-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const origin = join(root, "origin.git");
  git(root, ["init", "--quiet", "--bare", "-b", "main", "origin.git"]);
  const work = join(root, "work");
  git(root, ["init", "--quiet", "-b", "main", "work"]);
  git(work, ["remote", "add", "origin", origin]);
  git(work, ["config", "user.name", "t"]);
  git(work, ["config", "user.email", "t@t.test"]);
  // Two main commits: M1 (an older landing, healthy tips stamp it) and
  // M2 (main's HEAD, the SOURCE_SHA under publish).
  writeFileSync(join(work, "base.txt"), "one\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "one"]);
  const m1 = git(work, ["rev-parse", "HEAD"]);
  writeFileSync(join(work, "base.txt"), "one\ntwo\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "--quiet", "-m", "two"]);
  const m2 = git(work, ["rev-parse", "HEAD"]);
  git(work, ["push", "--quiet", "origin", "main"]);
  git(work, ["fetch", "--quiet", "origin"]);
  // The parked pending tree for M2: the unified shape (actions/ with a
  // manifest) publish.ts's shape guard requires.
  const pend = join(root, "pend");
  git(work, ["worktree", "add", "--quiet", "--detach", pend, m2]);
  git(pend, ["switch", "--quiet", "--orphan", "pending"]);
  mkdirSync(join(pend, "actions", "demo"), { recursive: true });
  writeFileSync(
    join(pend, "actions", "demo", "action.yml"),
    "name: demo\nruns:\n  using: composite\n  steps: []\n",
  );
  writeFileSync(join(pend, "rendered.txt"), "composed content\n");
  if (scenario.hostileIgnores === true) {
    writeFileSync(join(pend, "hidden.txt"), "must ship\n");
    writeFileSync(join(pend, ".gitignore"), "hidden.txt\n");
    mkdirSync(join(work, ".git/info"), { recursive: true });
    writeFileSync(join(work, ".git/info/exclude"), "rendered.txt\n");
  }
  // --force mirrors build_pending.ts's staging (the shared hermetic
  // argv): without it the hostile fixture's own park would drop the
  // very files the scenario plants.
  git(pend, ["add", "-A", "--force"]);
  git(pend, ["commit", "--quiet", "-m", "pending"]);
  const pendTree = git(pend, ["rev-parse", "HEAD^{tree}"]);
  git(pend, ["push", "--quiet", "origin", `HEAD:${pendingRefFor(m2)}`]);
  // The pre-existing build tip: same tree as the pending build ("same")
  // or the source commit's own tree ("drift" - anything but the pending
  // tree), carrying the scenario's stamp state.
  const tipTree = scenario.tipTree === "same" ? pendTree : git(work, ["rev-parse", `${m2}^{tree}`]);
  const tip = git(work, ["commit-tree", tipTree, "-m", scenario.tipMessage(m1)]);
  git(work, ["push", "--quiet", "origin", `${tip}:refs/heads/build`]);
  const proc = Bun.spawnSync([process.execPath, script], {
    cwd: work,
    timeout: 15000,
    killSignal: "SIGKILL",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: REPO,
      GITHUB_SERVER_URL: SERVER,
      RUN_URL: `${SERVER}/${REPO}/actions/runs/1`,
      GITHUB_REF: "refs/heads/main",
      SOURCE_SHA: m2,
      PREBUILT_REF: pendingRefFor(m2),
    },
  });
  if (proc.exitedDueToTimeout === true) {
    throw new Error(`publish.ts exceeded the harness bound\n${proc.stdout.toString()}`);
  }
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    m1,
    m2,
    tip,
    pendTree,
    origin,
    originTip: () => git(origin, ["rev-parse", "refs/heads/build"]),
    originTipMessage: () => git(origin, ["log", "-1", "--format=%B", "refs/heads/build"]),
    originTipTree: () => git(origin, ["rev-parse", "refs/heads/build^{tree}"]),
  };
}

const healthyStamp = (m1: string) =>
  [
    `build(build): main from ${m1.slice(0, 12)}`,
    "",
    commitStampWrite(SERVER, REPO, m1),
    commitRunWrite(`${SERVER}/${REPO}/actions/runs/0`),
  ].join("\n");

describe("publish.ts behavior (real git)", () => {
  test("a changed tree publishes a stamped commit chained onto the tip", () => {
    const r = runPublish({ tipTree: "drift", tipMessage: healthyStamp });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("(content change)");
    const newTip = r.originTip();
    expect(newTip).not.toBe(r.tip);
    expect(git(r.origin, ["rev-parse", `${newTip}^`])).toBe(r.tip);
    expect(r.originTipTree()).toBe(r.pendTree);
    const message = r.originTipMessage();
    expect(message).toContain(`build(build): main from ${r.m2.slice(0, 12)}`);
    expect(message).toContain(commitStampWrite(SERVER, REPO, r.m2));
    expect(message).toContain(commitRunWrite(`${SERVER}/${REPO}/actions/runs/1`));
  });

  test("a composed tree carrying its own .gitignore publishes VERBATIM - producer staging matches the verifier's", () => {
    // The staging-skew class end-to-end: the pending tree hides
    // hidden.txt behind an in-tree .gitignore and rendered.txt behind
    // the repo's own info/exclude (which /tmp/pub, a worktree,
    // inherits). The old plain `add -A` dropped both, publishing a tree
    // the verifier's hermetic rebuild could never match - a fleet-wide
    // false tamper accusation. The published tree must BE the parked
    // tree, byte for byte.
    const r = runPublish({ tipTree: "drift", tipMessage: healthyStamp, hostileIgnores: true });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("(content change)");
    expect(r.originTipTree()).toBe(r.pendTree);
    const names = git(r.origin, ["ls-tree", "-r", "--name-only", r.originTipTree()]);
    expect(names).toContain("hidden.txt");
    expect(names).toContain("rendered.txt");
    expect(names).toContain(".gitignore");
  });

  test("an unchanged tree under a healthy stamp publishes NOTHING - the tip stays put", () => {
    // The no-empty-commits rule itself; the changed-tree case above is
    // the moved-control proving this harness can advance the branch.
    const r = runPublish({ tipTree: "same", tipMessage: healthyStamp });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("nothing to publish");
    expect(r.originTip()).toBe(r.tip);
  });

  test("an unchanged tree under a BROKEN stamp publishes the freshly-stamped recovery commit", () => {
    // The guarded exception: an unstamped tip (a hand-push shape) with
    // an identical tree must not skip - the composed tree never changes
    // just because the stamp broke, so without this lane no dispatch
    // could ever heal it. The recovery commit is tree-identical and
    // carries the full fresh message shape.
    const r = runPublish({
      tipTree: "same",
      tipMessage: () => "build(build): seeded\n\nno stamp lines here",
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("stamp recovery");
    const newTip = r.originTip();
    expect(newTip).not.toBe(r.tip);
    expect(git(r.origin, ["rev-parse", `${newTip}^`])).toBe(r.tip);
    expect(r.originTipTree()).toBe(r.pendTree);
    const message = r.originTipMessage();
    expect(message).toContain(`build(build): main from ${r.m2.slice(0, 12)}`);
    expect(message).toContain(commitStampWrite(SERVER, REPO, r.m2));
    expect(message).toContain(commitRunWrite(`${SERVER}/${REPO}/actions/runs/1`));
  });
});
