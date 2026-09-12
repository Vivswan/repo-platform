// The sync row's failure path end to end, chained as sync-repos.yml chains
// it: the writer refusing a registration that carries a retired key, its
// captured streams becoming the writer log, deliver.ts filing that log
// into the target's failure-report issue with gh and git stubbed on PATH,
// and verdict.ts printing the row's line. Every script runs as a subprocess.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { fixtureGit, fixtureGitEnv } from "../shared/fixture_git";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SCRIPTS = join(REPO_ROOT, ".github/scripts/sync");
const FIXTURES = join(import.meta.dir, "sync_end_to_end/fixtures");
const BUILD = "abcdef0123456789abcdef0123456789abcdef01";
const TARGET = "OwnerOrg/demo";
const PAT = "ghp_SENTINEL";
const RUN_URL = "https://github.com/OwnerOrg/repo-platform/actions/runs/1";

// The real gh refuses `--slurp` beside `--jq` as a flag error before any
// request; the stub does the same, then answers the failure path's calls.
const GH_LINES = [
  'if [[ " $* " == *" --slurp "* && ( " $* " == *" --jq "* || " $* " == *" -q "* || " $* " == *" --template "* || " $* " == *" -t "* ) ]]; then echo "the \\`--slurp\\` option is not supported with \\`--jq\\` or \\`--template\\`" >&2; exit 1; fi',
  'case "$*" in',
  '  "api user "*) echo token-bot ;;',
  '  *"/issues --method GET"*) printf "%s" "${STUB_ISSUE:-}" ;;',
  "esac",
];

describe("the sync row's failure path", () => {
  test("a writer refusal lands in the target's failure issue and the row prints the failed line", () => {
    const root = temp.dir("sync-e2e-failure-");
    const runnerTemp = join(root, "temp");
    const target = join(root, "target");
    mkdirSync(runnerTemp);
    mkdirSync(target);
    writeFileSync(
      join(target, ".repo-platform.yml"),
      "modules: [bun]\nproject: {name: Demo, slug: demo, description: A demo}\npages: {path: docs}\n",
    );
    fixtureGit(target, ["init", "-q", "-b", "main"]);

    // The writer step: both streams to the writer log, as the workflow redirects them.
    const writer = boundedSpawnSync(
      [
        "bun",
        join(SCRIPTS, "writer/sync.ts"),
        "--files",
        join(FIXTURES, "files.yml"),
        "--tree",
        join(FIXTURES, "files"),
        "--target",
        target,
        "--build",
        BUILD,
        "--repository",
        TARGET,
        "--private",
        "false",
        "--summary",
        join(runnerTemp, "summary.json"),
      ],
      { cwd: REPO_ROOT, env: fixtureGitEnv(), timeoutMs: 60_000 },
    );
    writeFileSync(join(runnerTemp, "sync.log"), `${writer.stdout}${writer.stderr}`);
    expect(writer.exitCode).toBe(1);
    expect(writer.stderr).toBe("");
    expect(writer.stdout).toBe(
      '::error::.repo-platform.yml: (top level): Unrecognized key: "pages"\n',
    );
    expect(existsSync(join(runnerTemp, "summary.json"))).toBe(false);

    // The delivery step, with the writer's outcome as the runner reports it.
    const git = argvStub(root, "git");
    const gh = argvStub(root, "gh", GH_LINES);
    const deliver = boundedSpawnSync(["bun", join(SCRIPTS, "deliver.ts")], {
      cwd: root,
      env: {
        PATH: `${gh.bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        RUNNER_TEMP: runnerTemp,
        TARGET,
        TARGET_PRIVATE: "false",
        TARGET_DIR: target,
        PAT,
        GH_TOKEN: PAT,
        BUILD,
        RUN_URL,
        GITHUB_REPOSITORY: "OwnerOrg/repo-platform",
        MANUAL: "false",
        CHECKOUT_OUTCOME: "success",
        WRITER_OUTCOME: "failure",
      },
    });
    expect(deliver).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(runnerTemp, "verdict.txt"), "utf-8")).toBe("failed\n");
    expect(git.calls()).toEqual([]);
    const filed = gh.calls().find((argv) => argv.includes("POST"));
    expect(filed?.slice(1, 5)).toEqual(["api", `repos/${TARGET}/issues`, "--method", "POST"]);
    const body = readFileSync(join(runnerTemp, "failure-issue-body.md"), "utf-8");
    expect(body).toContain(
      "The repo-platform sync for this repository failed: the writer exited with an error.",
    );
    expect(body).toContain(`Run: ${RUN_URL}\nBuild: \`${BUILD}\``);
    expect(body).toContain(`## Writer log\n\n\`\`\`\`text\n${writer.stdout.trimEnd()}\n\`\`\`\``);
    expect(body).toContain("## Delivery log");
    expect(body).not.toContain(PAT);

    // The printer: the one line the public log carries for the row.
    const verdict = boundedSpawnSync(["bun", join(SCRIPTS, "verdict.ts"), "row"], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        RUNNER_TEMP: runnerTemp,
        TARGET,
        ROW: "1",
      },
    });
    expect(verdict).toEqual({
      exitCode: 0,
      stdout: "row 1: failed, report filed in the target repository\n",
      stderr: "",
    });
  });
});
