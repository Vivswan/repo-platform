// publish.ts run for real - real git, real rsync, a stubbed gh, and a real
// compose through a stub branch_tree.ts committed in the fixture source - so
// each publish decision is proven behaviorally (the wiring suite pins shape).

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { commitRunWrite, commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";
import { boundedSpawnSync, SPAWN_TIMEOUT_MS } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

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

/** The source commit's builder: publish.ts runs the SOURCE's own
 * .github/scripts/build-branches/branch_tree.ts after a frozen install
 * there, so the fixture commits this stub, which copies the committed
 * composed/ directory to --dest (the real builder needs the whole
 * template tree). */
const STUB_BUILDER = `
import { cpSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dest = args[args.indexOf("--dest") + 1];
if (!dest) process.exit(2);
cpSync(join(import.meta.dir, "../../../composed"), dest, { recursive: true });
`;

/** The marker files a held publish's rsync stub talks through. */
interface Hold {
  /** Written by the stub once it is parked, carrying the stub's own PID. */
  ready: string;
  /** Created by the test to let the stub proceed. */
  release: string;
  /** Created by the stub when its wait ran out unreleased. */
  expired: string;
}

/** An rsync that parks until released: rsync is the first command
 * publish.ts runs after ALL its scratch worktrees exist, so a publish
 * held here sits mid-flight with its worktrees populated. The wait is
 * bounded by the harness bound so an unreleased hold ends loudly
 * instead of pinning the pipes open. */
function heldRsyncStub(hold: Hold): string {
  const real = Bun.which("rsync");
  if (real === null) throw new Error("rsync is not on PATH; publish.ts needs it");
  const polls = Math.ceil(SPAWN_TIMEOUT_MS / 50);
  return [
    "#!/usr/bin/env bash",
    `echo $$ > "${hold.ready}.tmp" && mv "${hold.ready}.tmp" "${hold.ready}"`,
    `for _ in $(seq 1 ${polls}); do`,
    `  [ -e "${hold.release}" ] && exec "${real}" "$@"`,
    "  sleep 0.05",
    "done",
    `: > "${hold.expired}"`,
    'echo "the rsync hold was never released" >&2',
    "exit 70",
    "",
  ].join("\n");
}

interface Scenario {
  /** "same" gives the build tip a tree byte-identical to the composed
   * one; "drift" makes the tip carry a different tree (the source
   * commit's), so the composed tree is a content change. */
  tipTree: "same" | "drift";
  /** The build tip's commit message, handed both main commits; healthy
   * scenarios stamp a real on-main commit with the REAL writer shape. */
  tipMessage: (main: { m1: string; m2: string }) => string;
  /** The SOURCE_SHA under publish: M2 (main's HEAD, which carries the
   * builder) unless a scenario names M1 or the side-branch commit. */
  source?: "m1" | "m2" | "side";
  /** Plants the two measured staging-skew vectors: a .gitignore INSIDE
   * the composed tree hiding a sibling, and an info/exclude in the
   * fixture repo - which the publish's branch worktree inherits - hiding
   * rendered.txt. The publish must stage both hidden files anyway
   * (shared/stage_tree.ts's hermetic argv). */
  hostileIgnores?: boolean;
  /** Composes a tree WITHOUT actions/, the shape publish.ts's
   * unified-tree guard refuses - a publish that exits 1 after its
   * scratch worktrees exist. */
  malformedTree?: boolean;
  /** Puts heldRsyncStub on the publish's PATH. */
  holdInRsync?: boolean;
  /** Parks the release marker under a missing directory, so the harness's
   * own release write fails after the hold. */
  unreleasable?: boolean;
  /** The RUNNER_TEMP handed to the publish; absent = a private one under
   * the fixture. Two publishes sharing one prove the per-run root is
   * what keeps them apart, as on the runner where a job has one. */
  runnerTemp?: string;
}

interface Fixture {
  work: string;
  env: Record<string, string | undefined>;
  m1: string;
  m2: string;
  tip: string;
  composedTree: string;
  origin: string;
  runnerTemp: string;
  hold: Hold;
}

function prepareFixture(scenario: Scenario): Fixture {
  const root = temp.dir("publish-behavior-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const releaseDir = scenario.unreleasable === true ? join(root, "missing") : root;
  const hold = {
    ready: join(root, "rsync-ready"),
    release: join(releaseDir, "rsync-release"),
    expired: join(root, "rsync-expired"),
  };
  if (scenario.holdInRsync === true) {
    writeFileSync(join(bin, "rsync"), heldRsyncStub(hold), { mode: 0o755 });
  }
  const runnerTemp = scenario.runnerTemp ?? join(root, "runner-temp");
  mkdirSync(runnerTemp, { recursive: true });
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "--quiet", "--bare", "-b", "main", "origin.git"]);
  const work = join(root, "work");
  fixtureGit(root, ["init", "--quiet", "-b", "main", "work"]);
  fixtureGit(work, ["remote", "add", "origin", origin]);
  fixtureGit(work, ["config", "user.name", "t"]);
  fixtureGit(work, ["config", "user.email", "t@t.test"]);
  // Two main commits: M1 (an older landing with NO builder, so a publish
  // that composes it fails - which is how the stale test proves the
  // preflight runs first) and M2 (main's HEAD: the builder, its lockfile,
  // and the composed/ tree the builder ships).
  writeFileSync(join(work, "base.txt"), "one\n");
  fixtureGit(work, ["add", "-A"]);
  fixtureGit(work, ["commit", "--quiet", "-m", "one"]);
  const m1 = fixtureGit(work, ["rev-parse", "HEAD"]);
  mkdirSync(join(work, ".github/scripts/build-branches"), { recursive: true });
  writeFileSync(join(work, ".github/scripts/build-branches/branch_tree.ts"), STUB_BUILDER);
  writeFileSync(join(work, "package.json"), '{ "name": "fixture", "private": true }\n');
  // A committed lockfile so publish.ts's --frozen-lockfile install passes.
  boundedSpawnSync(["bun", "install", "--silent"], { cwd: work });
  writeFileSync(join(work, ".gitignore"), "node_modules/\n");
  // The composed tree: the unified shape (actions/ with a manifest)
  // publish.ts's shape guard requires, unless the scenario drops it.
  const composed = join(work, "composed");
  mkdirSync(composed);
  if (scenario.malformedTree !== true) {
    mkdirSync(join(composed, "actions", "demo"), { recursive: true });
    writeFileSync(
      join(composed, "actions", "demo", "action.yml"),
      "name: demo\nruns:\n  using: composite\n  steps: []\n",
    );
  }
  writeFileSync(join(composed, "rendered.txt"), "composed content\n");
  if (scenario.hostileIgnores === true) {
    writeFileSync(join(composed, "hidden.txt"), "must ship\n");
    writeFileSync(join(composed, ".gitignore"), "hidden.txt\n");
  }
  // --force: the composed tree's own .gitignore must not keep the planted
  // sibling out of the SOURCE commit (the builder copies whatever the
  // commit carries).
  fixtureGit(work, ["add", "-A", "--force"]);
  fixtureGit(work, ["commit", "--quiet", "-m", "two"]);
  const m2 = fixtureGit(work, ["rev-parse", "HEAD"]);
  fixtureGit(work, ["push", "--quiet", "origin", "main"]);
  // A commit off main (a PR head shape): green by the gh stub, never a
  // publishable source.
  fixtureGit(work, ["switch", "--quiet", "-c", "side"]);
  writeFileSync(join(work, "side.txt"), "off main\n");
  fixtureGit(work, ["add", "-A"]);
  fixtureGit(work, ["commit", "--quiet", "-m", "side"]);
  const side = fixtureGit(work, ["rev-parse", "HEAD"]);
  fixtureGit(work, ["push", "--quiet", "origin", "side"]);
  fixtureGit(work, ["switch", "--quiet", "main"]);
  fixtureGit(work, ["fetch", "--quiet", "origin"]);
  // The tree hash publish.ts must publish: M2's composed/ subtree as git
  // already holds it (the builder copies it verbatim and the hermetic
  // staging keeps every file).
  const composedTree = fixtureGit(work, ["rev-parse", `${m2}:composed`]);
  if (scenario.hostileIgnores === true) {
    // Planted AFTER the source commit: this exclude hides rendered.txt
    // from every worktree of the checkout, the publish's branch worktree
    // included, and must not hide it from the published tree.
    mkdirSync(join(work, ".git/info"), { recursive: true });
    writeFileSync(join(work, ".git/info/exclude"), "rendered.txt\n");
  }
  // The pre-existing build tip: the composed tree ("same") or the source
  // commit's own tree ("drift" - anything but the composed tree),
  // carrying the scenario's stamp state.
  const tipTree =
    scenario.tipTree === "same" ? composedTree : fixtureGit(work, ["rev-parse", `${m2}^{tree}`]);
  const tip = fixtureGit(work, ["commit-tree", tipTree, "-m", scenario.tipMessage({ m1, m2 })]);
  fixtureGit(work, ["push", "--quiet", "origin", `${tip}:refs/heads/build`]);
  const sources = { m1, m2, side };
  return {
    work,
    // The publisher runs git against these fixtures itself: same pins.
    env: {
      ...fixtureGitEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runnerTemp,
      GITHUB_REPOSITORY: REPO,
      GITHUB_SERVER_URL: SERVER,
      RUN_URL: `${SERVER}/${REPO}/actions/runs/1`,
      GITHUB_REF: "refs/heads/main",
      SOURCE_SHA: sources[scenario.source ?? "m2"],
    },
    m1,
    m2,
    tip,
    composedTree,
    origin,
    runnerTemp,
    hold,
  };
}

/** The publish's whole observable outcome: its exit and output, plus
 * accessors read at assertion time for the fixture origin's build tip
 * and the scratch residue - anything under the run's RUNNER_TEMP plus
 * any worktree still registered in the checkout beyond the checkout
 * itself (git lists registered worktrees by real path). The residue
 * must be empty once every publish sharing that RUNNER_TEMP has exited,
 * however each ended. */
function outcome(f: Fixture, proc: { exitCode: number; stdout: string; stderr: string }) {
  const own = realpathSync(f.work);
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    m1: f.m1,
    m2: f.m2,
    tip: f.tip,
    composedTree: f.composedTree,
    origin: f.origin,
    scratchLeftovers: () => [
      ...readdirSync(f.runnerTemp),
      ...fixtureGit(f.work, ["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .filter((path) => path !== own),
    ],
    originTip: () => fixtureGit(f.origin, ["rev-parse", "refs/heads/build"]),
    originTipMessage: () => fixtureGit(f.origin, ["log", "-1", "--format=%B", "refs/heads/build"]),
    originTipTree: () => fixtureGit(f.origin, ["rev-parse", "refs/heads/build^{tree}"]),
  };
}

type Outcome = ReturnType<typeof outcome>;

function runPublish(scenario: Scenario): Outcome {
  const f = prepareFixture(scenario);
  return outcome(f, boundedSpawnSync([process.execPath, script], { cwd: f.work, env: f.env }));
}

/** Runs a holdInRsync publish, runs `meanwhile` while it is parked, releases
 * it, and returns both results. Child and stub are dead and the pipes drained
 * before this returns or throws; a signal death or a pre-hold exit throws. */
async function runPublishHeldAcross<T>(
  f: Fixture,
  meanwhile: () => T,
): Promise<{ held: Outcome; meanwhile: T }> {
  // Its own process group: the stub is a grandchild holding the same pipes,
  // so a kill aimed at the child alone would leave it polling to its bound.
  const child = Bun.spawn([process.execPath, script], {
    cwd: f.work,
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const killAll = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  const deadline = setTimeout(killAll, SPAWN_TIMEOUT_MS);
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const settle = async () => {
    const [stdout, stderr] = await output;
    return { exitCode: await child.exited, stdout, stderr };
  };
  try {
    while (!existsSync(f.hold.ready) && child.exitCode === null && child.signalCode === null) {
      await Bun.sleep(50);
    }
    if (!existsSync(f.hold.ready)) {
      const early = await settle();
      throw new Error(
        `publish.ts exited ${early.exitCode} before reaching its rsync hold - failed to look, not a result\n${early.stdout}${early.stderr}`,
      );
    }
    let ran: { result: T } | { error: unknown };
    try {
      ran = { result: meanwhile() };
    } catch (error) {
      ran = { error };
    }
    writeFileSync(f.hold.release, "");
    const done = await settle();
    if ("error" in ran) throw ran.error;
    if (child.signalCode !== null) {
      throw new Error(
        `publish.ts died on ${child.signalCode} - failed to look, not a result\n${done.stdout}${done.stderr}`,
      );
    }
    return { held: outcome(f, done), meanwhile: ran.result };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) killAll();
    await Promise.all([child.exited, output]);
  }
}

/** Whether `pid` still exists; a zombie counts until its parent reaps it. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

const stampOf = (source: string) =>
  [
    `build(build): main from ${source.slice(0, 12)}`,
    "",
    commitStampWrite(SERVER, REPO, source),
    commitRunWrite(`${SERVER}/${REPO}/actions/runs/0`),
  ].join("\n");

/** The common tip: stamped with the OLDER landing, so M2 is a step forward. */
const healthyStamp = ({ m1 }: { m1: string }) => stampOf(m1);

function expectContentChangePublished(r: Outcome): void {
  expect(r.exitCode).toBe(0);
  expect(r.output).toContain("(content change)");
  const newTip = r.originTip();
  expect(newTip).not.toBe(r.tip);
  expect(fixtureGit(r.origin, ["rev-parse", `${newTip}^`])).toBe(r.tip);
  expect(r.originTipTree()).toBe(r.composedTree);
  const message = r.originTipMessage();
  expect(message).toContain(`build(build): main from ${r.m2.slice(0, 12)}`);
  expect(message).toContain(commitStampWrite(SERVER, REPO, r.m2));
  expect(message).toContain(commitRunWrite(`${SERVER}/${REPO}/actions/runs/1`));
  expect(r.scratchLeftovers()).toEqual([]);
}

describe("publish.ts behavior (real git)", () => {
  test("a changed tree publishes a stamped commit chained onto the tip", () => {
    expectContentChangePublished(runPublish({ tipTree: "drift", tipMessage: healthyStamp }));
  });

  test("a composed tree carrying its own .gitignore publishes VERBATIM - producer staging matches the verifier's", () => {
    // The staging-skew class end-to-end: the composed tree hides
    // hidden.txt behind an in-tree .gitignore and rendered.txt behind
    // the repo's own info/exclude (which the branch worktree, a worktree
    // of the checkout, inherits). The old plain `add -A` dropped both,
    // publishing a tree the verifier's hermetic rebuild could never
    // match - a fleet-wide false tamper accusation. The published tree
    // must BE the composed tree, byte for byte.
    const r = runPublish({ tipTree: "drift", tipMessage: healthyStamp, hostileIgnores: true });
    expectContentChangePublished(r);
    const names = fixtureGit(r.origin, ["ls-tree", "-r", "--name-only", r.originTipTree()]);
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
    expect(r.scratchLeftovers()).toEqual([]);
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
    expect(fixtureGit(r.origin, ["rev-parse", `${newTip}^`])).toBe(r.tip);
    expect(r.originTipTree()).toBe(r.composedTree);
    const message = r.originTipMessage();
    expect(message).toContain(`build(build): main from ${r.m2.slice(0, 12)}`);
    expect(message).toContain(commitStampWrite(SERVER, REPO, r.m2));
    expect(message).toContain(commitRunWrite(`${SERVER}/${REPO}/actions/runs/1`));
    expect(r.scratchLeftovers()).toEqual([]);
  });

  test("a STALE source is skipped green before anything is composed - newest-green wins", () => {
    // The tip already ships M2, a descendant of the M1 this run would
    // publish (a queued publisher running after a newer main published).
    // M1 carries no builder, so a publish that composed before the
    // preflight would exit red here: the green exit plus the untouched
    // tip prove the preflight decided first.
    const r = runPublish({ tipTree: "drift", tipMessage: ({ m2 }) => stampOf(m2), source: "m1" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("newest-green wins");
    expect(r.output).toContain(r.m2.slice(0, 12));
    expect(r.originTip()).toBe(r.tip);
    expect(r.scratchLeftovers()).toEqual([]);
  });

  test("a REPLAY of the tip's own source is not stale - a drifted tree republishes", () => {
    // The equal-source arm of newest-green-wins: a re-run of the commit
    // the tip already stamps proceeds to the tree diff, so a tip whose
    // tree drifted from that commit's composition (a hand edit under a
    // healthy stamp) is repaired instead of being skipped as stale.
    expectContentChangePublished(
      runPublish({ tipTree: "drift", tipMessage: ({ m2 }) => stampOf(m2) }),
    );
  });

  test("a source off main is refused before any mutation - the stamp must name main history", () => {
    // The dispatch hazard: a PR head's own CI run posts an all-green
    // check (the gh stub greens every sha), but stamping it would fail
    // the sync's stamp check 1 and wedge every sync on the tip.
    const r = runPublish({ tipTree: "drift", tipMessage: healthyStamp, source: "side" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("is not a commit on main");
    expect(r.originTip()).toBe(r.tip);
    expect(r.scratchLeftovers()).toEqual([]);
  });

  test("a refused publish leaves no scratch behind either - the exit hook runs on the failure route", () => {
    // The shape guard fires after every scratch worktree exists, so this
    // exit 1 is the failure route WITH scratch on disk: the tip must not
    // move, and the worktrees must be gone and unregistered.
    const r = runPublish({ tipTree: "drift", tipMessage: healthyStamp, malformedTree: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("carries no actions/ subtree");
    expect(r.originTip()).toBe(r.tip);
    expect(r.scratchLeftovers()).toEqual([]);
  });

  test(
    "a publish held mid-flight is untouched by another running start to finish",
    async () => {
      // The collision the per-run root retires, under ONE RUNNER_TEMP as
      // a runner job has: one publish is parked in rsync with every
      // scratch worktree populated - visibly, as the sole root under
      // that RUNNER_TEMP - while the other runs start to finish. Under
      // one shared path the second would have replaced the first's
      // branch worktree with its own, and the first's commit would have
      // landed on the second's origin. Each fixture's outcome must be
      // the single-publish outcome, scratch residue included.
      const runnerTemp = temp.dir("publish-behavior-runner-temp-");
      const { held, meanwhile } = await runPublishHeldAcross(
        prepareFixture({
          tipTree: "drift",
          tipMessage: healthyStamp,
          holdInRsync: true,
          runnerTemp,
        }),
        () => {
          const parked = readdirSync(runnerTemp);
          expect(parked).toHaveLength(1);
          expect(parked[0]).toStartWith("build-branches-");
          expect(readdirSync(join(runnerTemp, parked[0] ?? "")).sort()).toEqual([
            "out",
            "src",
            "tree",
          ]);
          return runPublish({ tipTree: "drift", tipMessage: healthyStamp, runnerTemp });
        },
      );
      expectContentChangePublished(held);
      expectContentChangePublished(meanwhile);
    },
    2 * SPAWN_TIMEOUT_MS,
  );

  test(
    "a harness failure after the hold leaves no publish or stub running",
    async () => {
      // The release write fails once the publish is parked, so the harness
      // must take child and stub down itself. The stub's PID off its marker
      // proves the hold was reached; no expiry marker means it was killed.
      const f = prepareFixture({
        tipTree: "drift",
        tipMessage: healthyStamp,
        holdInRsync: true,
        unreleasable: true,
      });
      await expect(runPublishHeldAcross(f, () => undefined)).rejects.toThrow("ENOENT");
      const stub = Number(readFileSync(f.hold.ready, "utf-8"));
      expect(stub).toBeGreaterThan(1);
      // A reparented stub is reaped by init a moment after its death.
      for (let i = 0; i < 40 && alive(stub); i++) await Bun.sleep(50);
      expect(alive(stub)).toBe(false);
      expect(existsSync(f.hold.expired)).toBe(false);
      expect(fixtureGit(f.origin, ["rev-parse", "refs/heads/build"])).toBe(f.tip);
    },
    2 * SPAWN_TIMEOUT_MS,
  );
});
