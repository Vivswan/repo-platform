import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const script = join(import.meta.dir, "../../.github/scripts/sync/resolve_build.ts");
const TAG = "refs/tags/stable";

function verdict(conclusion: string): string {
  return JSON.stringify({
    check_runs: [
      {
        name: "all-green",
        status: "completed",
        conclusion,
        external_id: "workflow_run",
        app: { slug: "github-actions" },
      },
    ],
  });
}

interface Scenario {
  /** m0 predates files.yml; m1..m3 carry it; side is off main. */
  tag?: "m0" | "m1" | "m2" | "m3" | "side";
  annotated?: boolean;
  /** The operator's checkout already holds a local `stable` tag at this commit from an earlier fetch. */
  staleLocalTag?: "m0" | "m1" | "m2" | "m3" | "side";
  conclusion?: string;
  /** The git question a stubbed git answers with exit 128 (every other call reaches the real git). */
  gitErrorsOn?: GitQuestion;
}

type GitQuestion = "the ancestry question" | "the files.yml question";

// Keyed on the question, not the command: the ancestry ask is merge-base, the data-file ask names <tip>:files.yml.
const GIT_ERRORS: Record<GitQuestion, string> = {
  "the ancestry question": `[ "$1" = merge-base ]`,
  "the files.yml question": `[[ "$*" == *:files.yml* ]]`,
};

interface Outcome {
  exitCode: number;
  output: string;
  outputs: Record<string, string>;
  ghCalls: string[];
  shas: Record<"m0" | "m1" | "m2" | "m3" | "side", string>;
}

function run(scenario: Scenario): Outcome {
  const root = temp.dir("resolve-build-");
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
    fixtureGit(work, ["add", "-A"]);
    fixtureGit(work, ["commit", "--quiet", "--allow-empty", "-m", message]);
    return fixtureGit(work, ["rev-parse", "HEAD"]);
  };
  const m0 = commit("before the data file");
  writeFileSync(join(work, "files.yml"), "placeholders: []\nfiles: []\n");
  const m1 = commit("one");
  const m2 = commit("two");
  const m3 = commit("three");
  fixtureGit(work, ["push", "--quiet", "origin", "main"]);
  fixtureGit(work, ["switch", "--quiet", "-c", "side", m1]);
  const side = commit("side");
  fixtureGit(work, ["push", "--quiet", "origin", "side"]);
  fixtureGit(work, ["switch", "--quiet", "main"]);
  const shas = { m0, m1, m2, m3, side };
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
  // The operator's checkout knows main, and with it the tag as origin held it at fetch time (a fetch follows tags
  // into fetched history); a move after that leaves the local tag stale, which the resolver's forced fetch overwrites.
  fixtureGit(work, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  if (scenario.staleLocalTag !== undefined) {
    fixtureGit(work, ["tag", "-f", "stable", shas[scenario.staleLocalTag]]);
  }
  if (scenario.gitErrorsOn !== undefined) {
    const real = Bun.which("git");
    if (real === null) throw new Error("git is not on PATH");
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        `if ${GIT_ERRORS[scenario.gitErrorsOn]}; then echo 'fatal: stubbed' >&2; exit 128; fi`,
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  const outputFile = join(root, "output");
  writeFileSync(outputFile, "");
  const proc = boundedSpawnSync([process.execPath, script], {
    cwd: work,
    env: {
      ...fixtureGitEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_OUTPUT: outputFile,
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
    shas,
  };
}

describe("resolve_build.ts behavior (real git)", () => {
  test("the commit the stable tag names, green and on main, is the run's build", () => {
    const r = run({ tag: "m3" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ build: r.shas.m3 });
    expect(r.ghCalls).toEqual([
      `api repos/o/r/commits/${r.shas.m3}/check-runs?check_name=all-green&filter=latest&per_page=100`,
    ]);
    expect(r.output).toContain(`build ${r.shas.m3.slice(0, 12)} verified`);
  });

  test("an annotated tag resolves to the commit it names, never the tag object", () => {
    const r = run({ tag: "m2", annotated: true });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ build: r.shas.m2 });
  });

  test("a local stable tag left by an earlier fetch is overwritten, never shipped", () => {
    // Without the forced refspec git refuses to move the existing local tag and the resolve fails, so every sync
    // after a move would fail once the checkout's fetch had followed the tag.
    const r = run({ tag: "m3", staleLocalTag: "m1" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs).toEqual({ build: r.shas.m3 });
  });

  test("a tag off main's history is refused before the green gate is read", () => {
    const r = run({ tag: "side" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("is not on main's history");
    expect(r.output).not.toContain("refusing to guess");
    expect(r.ghCalls).toEqual([]);
    expect(r.outputs).toEqual({});
  });

  test("a red commit under the tag is refused with the gate's reason", () => {
    const r = run({ tag: "m3", conclusion: "failure" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("is not green: its all-green verdict concluded 'failure'");
    expect(r.outputs).toEqual({});
  });

  test("no stable tag on origin names the dispatch that mints it", () => {
    const r = run({});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("fetching the stable tag failed");
    expect(r.output).toContain("Dispatch post-green.yml");
    expect(r.outputs).toEqual({});
  });

  test("a tagged commit without the writer's data file is refused", () => {
    const r = run({ tag: "m0" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("carries no files.yml");
    expect(r.output).not.toContain("refusing to guess");
    expect(r.outputs).toEqual({});
  });

  // The two tests above are the controls: the same questions answered with a real "no" still fail closed.
  test.each([
    ["the ancestry question", "is not on main's history"],
    ["the files.yml question", "carries no files.yml"],
  ] as const)(
    "a git that errors on %s is fatal with git's own words, never the diagnostic for a no",
    (gitErrorsOn, wrongDiagnostic) => {
      const r = run({ tag: "m3", gitErrorsOn });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("could not answer (exit 128); refusing to guess: fatal: stubbed");
      expect(r.output).not.toContain(wrongDiagnostic);
      expect(r.outputs).toEqual({});
    },
  );
});
