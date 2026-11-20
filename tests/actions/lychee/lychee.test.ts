// What the callers judge by and lychee itself does not decide: the step's own verdict (red on a report that counts no
// link, red on lychee's exit only when asked), the exit code published either way, the report in three places, the
// arguments handed over one per line, and a lychee that never sees the job's token. The rows plant a lychee that
// writes a given report and exits a given code; the last runs the locked lychee, whose report row the zero-link rule
// reads.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { argvStub } from "../../shared/argv_stub";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { parseGithubOutput } from "../../shared/github_output";
import { tempDirs } from "../../shared/temp_dir";
import { UV_TIMEOUT_MS, uvEnv, uvOnPath } from "../../shared/uv_project";

const temp = tempDirs();
const ACTION = join(REPO_ROOT, "actions/lychee");

const report = (total: number): string =>
  ["# Summary", "", "| Status         | Count |", `| 🔍 Total       | ${total}     |`, ""].join(
    "\n",
  );

interface Outcome {
  exitCode: number;
  exitCodeOutput: string | undefined;
  annotation: string | undefined;
  written: string | undefined;
  logged: boolean;
  summary: string;
}

/** lychee.ts run over a planted lychee that writes `wrote` to its --output (nothing when undefined) and exits `code`. */
function run(planted: { wrote?: string; code: number; fail: string; args?: string }) {
  const root = temp.dir("lychee-action-");
  const wrote = join(root, "planted-report.md");
  if (planted.wrote !== undefined) writeFileSync(wrote, planted.wrote);
  const stub = argvStub(root, "lychee", [
    `printf '%s' "\${GITHUB_TOKEN-unset}" >${JSON.stringify(join(root, "token"))}`,
    `[ ! -f ${JSON.stringify(wrote)} ] || cp ${JSON.stringify(wrote)} "$4"`,
  ]);
  const out = join(root, "report-dir", "report.md");
  const outputs = join(root, "outputs");
  const summary = join(root, "summary");
  writeFileSync(outputs, "");
  writeFileSync(summary, "");
  const proc = boundedSpawnSync([process.execPath, join(ACTION, "lychee.ts")], {
    cwd: root,
    env: {
      PATH: `${stub.bin}:${process.env.PATH ?? ""}`,
      GITHUB_TOKEN: "a-token",
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      INPUT_ARGS: planted.args ?? "--offline\n",
      INPUT_REPORT: out,
      INPUT_FAIL: planted.fail,
      STUB_EXIT: String(planted.code),
    },
  });
  const written = existsSync(out) ? readFileSync(out, "utf8") : undefined;
  const outcome: Outcome = {
    exitCode: proc.exitCode,
    exitCodeOutput: parseGithubOutput(readFileSync(outputs, "utf8"))["exit-code"],
    annotation: /^::error::(.*)$/m.exec(proc.stdout)?.[1],
    written,
    logged: written !== undefined && proc.stdout.includes(written),
    summary: readFileSync(summary, "utf8"),
  };
  return { outcome, calls: stub.calls(), token: () => readFileSync(join(root, "token"), "utf8") };
}

describe("actions/lychee", () => {
  test.each<{ night: string; wrote?: string; code: number; fail: string; outcome: Outcome }>([
    {
      night: "a clean run",
      wrote: report(12),
      code: 0,
      fail: "true",
      outcome: {
        exitCode: 0,
        exitCodeOutput: "0",
        annotation: undefined,
        written: report(12),
        logged: true,
        summary: report(12),
      },
    },
    {
      night: "broken links, the step asked to fail",
      wrote: report(12),
      code: 2,
      fail: "true",
      outcome: {
        exitCode: 1,
        exitCodeOutput: "2",
        annotation: "lychee exited 2",
        written: report(12),
        logged: true,
        summary: report(12),
      },
    },
    {
      night: "broken links, the verdict left to the caller",
      wrote: report(12),
      code: 2,
      fail: "false",
      outcome: {
        exitCode: 0,
        exitCodeOutput: "2",
        annotation: undefined,
        written: report(12),
        logged: true,
        summary: report(12),
      },
    },
    {
      night: "no link extracted, the verdict left to the caller",
      wrote: report(0),
      code: 0,
      fail: "false",
      outcome: {
        exitCode: 1,
        exitCodeOutput: "0",
        annotation: "lychee extracted no link at all, so nothing was checked",
        written: report(0),
        logged: true,
        summary: report(0),
      },
    },
    {
      night: "a lychee that crashed before its report, the verdict left to the caller",
      code: 101,
      fail: "false",
      outcome: {
        exitCode: 0,
        exitCodeOutput: "101",
        annotation: undefined,
        written: undefined,
        logged: false,
        summary: "",
      },
    },
  ])("$night", ({ wrote, code, fail, outcome }) => {
    expect(run({ wrote, code, fail }).outcome).toEqual(outcome);
  });

  // A regex or a remap pair carries spaces and quotes; each line reaches lychee as one argument, unread by a shell.
  test("lychee gets the markdown report path, then each line of args as one argument, and no GITHUB_TOKEN", () => {
    const args =
      "--exclude=^https://a\\.example/(x|y) 'z'$\n--remap=^https://b/(.*)$ file:///c/$1\n\n**/*.html\n";
    const { calls, token } = run({ wrote: report(1), code: 0, fail: "true", args });
    expect(calls).toEqual([
      [
        "lychee",
        "--format",
        "markdown",
        "--output",
        expect.stringMatching(/\/report-dir\/report\.md$/),
        "--exclude=^https://a\\.example/(x|y) 'z'$",
        "--remap=^https://b/(.*)$ file:///c/$1",
        "**/*.html",
      ],
    ]);
    expect(token()).toBe("unset");
  });

  test.skipIf(!uvOnPath())(
    "the step, with the locked lychee: a page with no link at all fails it though lychee exits 0, and a dead link fails it with exit code 2",
    () => {
      const step = stepNamed(loadAction("actions/lychee/action.yml"), "Check the links");
      const check = (page: string) => {
        const root = temp.dir("lychee-step-");
        const site = join(root, "site");
        mkdirSync(site);
        writeFileSync(join(site, "index.html"), `<html><body>${page}</body></html>\n`);
        writeFileSync(join(root, "summary"), "");
        const run = runBashStep(step, {
          context: {
            "github.action_path": ACTION,
            "steps.action-bun.outputs.path": process.execPath,
            "inputs.args": "--offline\n--no-progress\nindex.html\n",
            "inputs.report": join(root, "report.md"),
            "inputs.fail": "true",
          },
          env: { ...uvEnv(), GITHUB_STEP_SUMMARY: join(root, "summary") },
          cwd: site,
          root,
          timeoutMs: UV_TIMEOUT_MS,
        });
        return [run.exitCode, run.outputs["exit-code"], /^::error::(.*)$/m.exec(run.stdout)?.[1]];
      };
      expect([check("no link"), check('<a href="gone.html">gone</a>')]).toEqual([
        [1, "0", "lychee extracted no link at all, so nothing was checked"],
        [1, "2", "lychee exited 2"],
      ]);
    },
    UV_TIMEOUT_MS,
  );
});
