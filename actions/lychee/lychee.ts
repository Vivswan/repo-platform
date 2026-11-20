// Runs the lychee uv put on PATH (action.yml) and publishes what a caller judges by: the markdown report as a file, in
// the log and in the step summary, and lychee's exit code as the `exit-code` output.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import * as core from "@actions/core";
import { messageOf } from "../shared/action_runtime.ts";

/** Whether lychee's markdown report counts no link at all. Excluded links count, so a zero is a check that read
 *  nothing: a wrong input or root, never a clean site. */
export function countsNoLink(report: string): boolean {
  return /\bTotal\s+\|\s+0\s+\|/.test(report);
}

async function main(): Promise<void> {
  // One argument per line, as lychee receives it: no shell reads them, so a value needs no quoting.
  const args = core.getMultilineInput("args", { required: true, trimWhitespace: false });
  const report = core.getInput("report", { required: true });
  const fail = core.getBooleanInput("fail", { required: true });
  mkdirSync(dirname(report), { recursive: true });
  rmSync(report, { force: true });

  // Anonymous, whatever the job exports: given a token, lychee answers a 404 on a github.com URL by asking the API,
  // which calls a private repository alive whatever the path.
  const { GITHUB_TOKEN: _token, ...anonymous } = process.env;
  const lychee = Bun.spawnSync(["lychee", "--format", "markdown", "--output", report, ...args], {
    env: anonymous,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (lychee.exitCode === null) {
    throw new Error(`lychee died on signal ${lychee.signalCode}`);
  }

  core.setOutput("exit-code", lychee.exitCode);
  if (existsSync(report)) {
    const written = readFileSync(report, "utf8");
    console.log(written);
    await core.summary.addRaw(written).write();
    if (countsNoLink(written)) {
      throw new Error("lychee extracted no link at all, so nothing was checked");
    }
  }

  if (fail && lychee.exitCode !== 0) {
    throw new Error(`lychee exited ${lychee.exitCode}`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (cause) {
    core.setFailed(messageOf(cause));
  }
}
