import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const script = join(import.meta.dir, "../../.github/scripts/post-green/move_stable.ts");
const TAG = "refs/tags/stable";

function verdict(conclusion: string): string {
  return JSON.stringify({
    check_runs: [
      {
        name: "all-green",
        status: "completed",
        conclusion,
        app: { slug: "github-actions" },
      },
    ],
  });
}

interface Scenario {
  tag?: "m1" | "m2" | "m3";
  annotated?: boolean;
  source?: "m1" | "m2" | "m3" | "side";
  conclusion?: string;
  ref?: string;
  brokenOrigin?: boolean;
  /** The stale read a racing mover would push its lease from. */
  staleReadAt?: "m1" | "m2";
  ancestryProbeErrors?: boolean;
  sourceProbeErrors?: boolean;
}

interface Outcome {
  exitCode: number;
  output: string;
  outputs: Record<string, string>;
  ghCalls: string[];
  originTag: () => string;
  m1: string;
  m2: string;
  m3: string;
}

function run(scenario: Scenario): Outcome {
  const root = temp.dir("move-stable-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const ghLog = join(root, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\nprintf '%s' '${verdict(scenario.conclusion ?? "success")}'\n`,
    { mode: 0o755 },
  );
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "--quiet", "--bare", "-b", "main", "origin.git"]);
  const work = join(root, "work");
  fixtureGit(root, ["init", "--quiet", "-b", "main", "work"]);
  fixtureGit(work, ["remote", "add", "origin", origin]);
  fixtureGit(work, ["config", "user.name", "t"]);
  fixtureGit(work, ["config", "user.email", "t@t.test"]);
  const commit = (message: string): string => {
    fixtureGit(work, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return fixtureGit(work, ["rev-parse", "HEAD"]);
  };
  const m1 = commit("one");
  const m2 = commit("two");
  const m3 = commit("three");
  fixtureGit(work, ["push", "--quiet", "origin", "main"]);
  fixtureGit(work, ["switch", "--quiet", "-c", "side", m1]);
  const side = commit("side");
  fixtureGit(work, ["push", "--quiet", "origin", "side"]);
  fixtureGit(work, ["switch", "--quiet", "main"]);
  fixtureGit(work, ["fetch", "--quiet", "origin"]);
  const shas = { m1, m2, m3, side };
  if (scenario.tag !== undefined) {
    const at = shas[scenario.tag];
    if (scenario.annotated === true) {
      fixtureGit(work, ["tag", "-a", "-m", "by hand", "stable", at]);
      fixtureGit(work, ["push", "--quiet", "origin", TAG]);
      fixtureGit(work, ["tag", "-d", "stable"]);
    } else {
      fixtureGit(work, ["push", "--quiet", "origin", `${at}:${TAG}`]);
    }
  }
  const stubbedGit: string[] = [];
  if (scenario.staleReadAt !== undefined) {
    stubbedGit.push(
      `if [ "$1" = ls-remote ]; then printf '%s\\t%s\\n' ${shas[scenario.staleReadAt]} ${TAG}; exit 0; fi`,
    );
  }
  if (scenario.ancestryProbeErrors === true) {
    stubbedGit.push(
      `if [ "$1" = merge-base ] && [ "$4" != origin/main ]; then echo 'fatal: stubbed' >&2; exit 128; fi`,
    );
  }
  if (scenario.sourceProbeErrors === true) {
    stubbedGit.push(
      `if [ "$1" = rev-parse ] && [ "$3" = --quiet ]; then echo 'fatal: stubbed' >&2; exit 128; fi`,
    );
  }
  if (stubbedGit.length > 0) {
    const real = Bun.which("git");
    if (real === null) throw new Error("git is not on PATH");
    writeFileSync(
      join(bin, "git"),
      ["#!/usr/bin/env bash", ...stubbedGit, `exec ${JSON.stringify(real)} "$@"`, ""].join("\n"),
      { mode: 0o755 },
    );
  }
  if (scenario.brokenOrigin === true) {
    fixtureGit(work, ["remote", "set-url", "origin", join(root, "missing.git")]);
  }
  const outputFile = join(root, "output");
  writeFileSync(outputFile, "");
  const proc = boundedSpawnSync([process.execPath, script], {
    cwd: work,
    env: {
      ...fixtureGitEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF: scenario.ref ?? "refs/heads/main",
      GITHUB_OUTPUT: outputFile,
      SOURCE_SHA: shas[scenario.source ?? "m3"],
      // The gate's poll is for a fresh check racing a consumer; a fixture's
      // verdict never changes, so the red case must not wait it out.
      ALL_GREEN_WAIT_MS: "0",
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf-8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    outputs,
    ghCalls: existsSync(ghLog)
      ? readFileSync(ghLog, "utf-8")
          .split("\n")
          .filter((line) => line !== "")
      : [],
    originTag: () => {
      const probe = boundedSpawnSync(
        ["git", "-C", origin, "rev-parse", "--verify", "--quiet", TAG],
        {
          env: fixtureGitEnv(),
        },
      );
      return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
    },
    m1,
    m2,
    m3,
  };
}

describe("move_stable.ts behavior (real git)", () => {
  test("the first move mints the tag at the source with an empty previous", () => {
    const r = run({});
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ previous: "" });
    expect(r.output).toContain("(the first move)");
    expect(r.originTag()).toBe(r.m3);
  });

  test("a forward move reports the commit the tag named before", () => {
    const r = run({ tag: "m1" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ previous: r.m1 });
    expect(r.originTag()).toBe(r.m3);
  });

  test("the move targets SOURCE_SHA, not the checkout's tip: an older main commit is judged and tagged", () => {
    // A queued mover for m2 running after m3 landed on main, before m3's own run.
    const r = run({ tag: "m1", source: "m2" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ previous: r.m1 });
    expect(r.originTag()).toBe(r.m2);
    expect(r.ghCalls).toEqual([
      `api repos/o/r/commits/${r.m2}/check-runs?check_name=all-green&filter=latest&per_page=100`,
    ]);
  });

  test("an annotated previous is leased by its tag object and reported by its commit", () => {
    // A hand-made annotated tag: the lease must name the ref's own value
    // (the tag object) or the server rejects the move, while the previous
    // output stays a commit for the range read downstream.
    const r = run({ tag: "m1", annotated: true });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ previous: r.m1 });
    expect(r.originTag()).toBe(r.m3);
  });

  test("a replay of the commit the tag already names moves nothing - exit 0, no base", () => {
    // A re-run of every job at the commit that moved the tag: the directives
    // read runs on its fallback base (a failed sync is recovered this way).
    const r = run({ tag: "m3" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ previous: "" });
    expect(r.output).toContain("nothing to move");
    expect(r.originTag()).toBe(r.m3);
  });

  test("a STALE source never moves the tag back - newest-green wins, and the directives read stays on", () => {
    // A re-run of this commit's jobs after a newer main commit moved the tag (the recovery of a
    // failed sync). The empty base hands the directives read its fallback: the newer run's range,
    // exclusive at its base, may have excluded this commit.
    const r = run({ tag: "m3", source: "m2" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ previous: "" });
    expect(r.output).toContain(
      `stable names ${r.m3.slice(0, 12)}, which descends from this run's ${r.m2.slice(0, 12)} - newest-green wins, the tag stays`,
    );
    expect(r.originTag()).toBe(r.m3);
  });

  test("a source off main is refused before any remote read", () => {
    // The dispatch hazard: a PR head's own run posted a green check (the
    // stub greens every sha), but the tag names main history only.
    const r = run({ tag: "m1", source: "side" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("is not a commit on main");
    expect(r.outputs).toEqual({});
    expect(r.originTag()).toBe(r.m1);
  });

  test("a red source is refused with the gate's reason", () => {
    const r = run({ tag: "m1", conclusion: "failure" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("is not green - its all-green verdict concluded 'failure'");
    expect(r.originTag()).toBe(r.m1);
  });

  test("a run dispatched on another branch is refused", () => {
    const r = run({ tag: "m1", ref: "refs/heads/feature" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("moves from main only");
    expect(r.originTag()).toBe(r.m1);
  });

  test("an unreadable origin is an operational failure, never a first move", () => {
    const r = run({ brokenOrigin: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("an operational failure, not an absent tag");
    expect(r.outputs).toEqual({});
  });

  test("an ancestry probe that errors is fatal, never a no - the tag is not pushed backwards", () => {
    // Read as a no, exit 128 would lease-push m2 over m3: a rollback of the delivery ref.
    const r = run({ tag: "m3", source: "m2", ancestryProbeErrors: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not answer");
    expect(r.outputs).toEqual({});
    expect(r.originTag()).toBe(r.m3);
  });

  test("a source probe that errors is fatal, never read as a source off main", () => {
    // Read as a no, exit 128 would send the operator after the sha with the
    // wrong diagnostic; the errored look names itself instead.
    const r = run({ tag: "m1", sourceProbeErrors: true });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("could not answer");
    expect(r.output).not.toContain("is not a commit on main");
    expect(r.outputs).toEqual({});
    expect(r.originTag()).toBe(r.m1);
  });

  test("a lease from a stale read loses the race - exit red, tag untouched", () => {
    // The mover read the tag at m1 while origin already holds m2 (another
    // mover moved it in between): the server rejects the lease.
    const r = run({ tag: "m2", staleReadAt: "m1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain("stale info");
    // Nothing reported: a lost lease leaves the directives read on its fallback base.
    expect(r.outputs).toEqual({});
    expect(r.originTag()).toBe(r.m2);
  });
});
