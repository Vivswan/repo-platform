import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitRunWrite, commitStampWrite } from "../../.github/scripts/shared/commit_stamp.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

const script = join(import.meta.dir, "../../.github/scripts/sync/resolve_build.ts");

const SERVER = "https://x.test";
const REPO = "o/r";

// A completed successful verdict greens every source; the gate's own truth table is tests/shared/all_green.test.ts.
const ghVerdict = JSON.stringify({
  check_runs: [
    {
      name: "all-green",
      status: "completed",
      conclusion: "success",
      external_id: "workflow_run",
      app: { slug: "github-actions" },
    },
  ],
});

/** The provenance rebuild runs the SOURCE's own branch_tree.ts after a frozen install there, so the fixture commits this stub. */
const STUB_BUILDER = `
import { cpSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dest = args[args.indexOf("--dest") + 1];
if (!dest) process.exit(2);
cpSync(join(import.meta.dir, "../../../composed"), dest, { recursive: true });
`;

interface Scenario {
  /** The stamped source: the main commit, or a sha no repository holds. */
  stamp?: "main" | "unknown";
  filesConfig?: boolean;
  /** The git question a stubbed git answers with exit 128 (every other call reaches the real git). */
  gitErrorsOn?: "the stamped source question" | "the files.yml question";
}

function run(scenario: Scenario) {
  const root = temp.dir("resolve-build-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s' '${ghVerdict}'\n`, {
    mode: 0o755,
  });
  if (scenario.gitErrorsOn !== undefined) {
    const real = Bun.which("git");
    if (real === null) throw new Error("git is not on PATH");
    // Keyed on the question, not the command: the quiet peel of a source, or any ask about the tip's files.yml.
    const errors = {
      "the stamped source question": `[ "$3" = --quiet ] && [[ "$4" == *'^{commit}' ]]`,
      "the files.yml question": `[[ "$*" == *:files.yml* ]]`,
    }[scenario.gitErrorsOn];
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        `if ${errors}; then echo 'fatal: stubbed' >&2; exit 128; fi`,
        `exec ${JSON.stringify(real)} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  }
  const origin = join(root, "origin.git");
  fixtureGit(root, ["init", "--quiet", "--bare", "-b", "main", "origin.git"]);
  const source = join(root, "source");
  fixtureGit(root, ["init", "--quiet", "-b", "main", "source"]);
  fixtureGit(source, ["remote", "add", "origin", origin]);
  fixtureGit(source, ["config", "user.name", "t"]);
  fixtureGit(source, ["config", "user.email", "t@t.test"]);
  mkdirSync(join(source, ".github/scripts/build-branches"), { recursive: true });
  writeFileSync(join(source, ".github/scripts/build-branches/branch_tree.ts"), STUB_BUILDER);
  writeFileSync(join(source, "package.json"), '{ "name": "fixture", "private": true }\n');
  // A committed lockfile so the rebuild's --frozen-lockfile install passes.
  boundedSpawnSync(["bun", "install", "--silent"], { cwd: source });
  writeFileSync(join(source, ".gitignore"), "node_modules/\n");
  const composed = join(source, "composed");
  mkdirSync(composed);
  writeFileSync(join(composed, "rendered.txt"), "composed content\n");
  if (scenario.filesConfig !== false) writeFileSync(join(composed, "files.yml"), "files: []\n");
  fixtureGit(source, ["add", "-A"]);
  fixtureGit(source, ["commit", "--quiet", "-m", "main"]);
  const main = fixtureGit(source, ["rev-parse", "HEAD"]);
  fixtureGit(source, ["push", "--quiet", "origin", "main"]);
  // The tip: main's composed/ subtree as git already holds it, under a stamp naming main (or a commit nobody has).
  const stamped = scenario.stamp === "unknown" ? "b".repeat(40) : main;
  const tip = fixtureGit(source, [
    "commit-tree",
    `${main}:composed`,
    "-m",
    [
      `build(build): main from ${stamped.slice(0, 12)}`,
      "",
      commitStampWrite(SERVER, REPO, stamped),
      commitRunWrite(`${SERVER}/${REPO}/actions/runs/0`),
    ].join("\n"),
  ]);
  fixtureGit(source, ["push", "--quiet", "origin", `${tip}:refs/heads/build`]);
  // The operator's checkout: a full clone, as sync-repos.yml's fetch-depth 0 gives it.
  const work = join(root, "work");
  fixtureGit(root, ["clone", "--quiet", origin, work]);
  const outputs = join(root, "outputs.txt");
  writeFileSync(outputs, "");
  const runnerTemp = join(root, "runner-temp");
  mkdirSync(runnerTemp);
  const proc = boundedSpawnSync([process.execPath, script], {
    cwd: work,
    env: {
      ...fixtureGitEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: REPO,
      GITHUB_OUTPUT: outputs,
      RUNNER_TEMP: runnerTemp,
    },
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout + proc.stderr,
    outputs: readFileSync(outputs, "utf-8"),
    main,
    tip,
  };
}

describe("resolve_build.ts (real git)", () => {
  test("a green, stamped, provenance-clean tip carrying files.yml resolves: both outputs, one verified line", () => {
    const r = run({});
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain(
      `build ${r.tip.slice(0, 12)} verified: built from green main commit ${r.main.slice(0, 12)}`,
    );
    expect(r.outputs).toBe(`build=${r.tip}\nsource=${r.main}\n`);
  });

  test.each([
    ["the stamped source question", "is not in main's history"],
    ["the files.yml question", "carries no files.yml"],
  ] as const)(
    "a git that errors on %s is fatal with git's own words, never the diagnostic for a no",
    (gitErrorsOn, wrongDiagnostic) => {
      const r = run({ gitErrorsOn });
      expect(r.exitCode).toBe(1);
      expect(r.output).toContain("could not answer (exit 128); refusing to guess: fatal: stubbed");
      expect(r.output).not.toContain(wrongDiagnostic);
      expect(r.outputs).toBe("");
    },
  );

  // The controls for the rows above: the same two questions answered with a real "no" still fail the plan closed.
  test.each([
    {
      reason: "a stamp naming a commit no repository holds is unreachable",
      scenario: { stamp: "unknown" } as Scenario,
      diagnostic: "stamped source bbbbbbbbbbbb is unreachable",
    },
    {
      reason: "a tip without files.yml has nothing to sync from",
      scenario: { filesConfig: false } as Scenario,
      diagnostic: "carries no files.yml",
    },
  ])("$reason", ({ scenario, diagnostic }) => {
    const r = run(scenario);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(diagnostic);
    expect(r.output).not.toContain("refusing to guess");
    expect(r.outputs).toBe("");
  });
});
