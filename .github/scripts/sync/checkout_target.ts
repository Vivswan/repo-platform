#!/usr/bin/env bun
// Clones the target repository for a sync row with git's every line kept
// off the public log: actions/checkout echoes git's diagnostics, and git
// quotes target file text in some of them (a malformed .gitattributes
// entry), so the clone runs here with both streams captured. The token
// rides the clone URL alone and is stripped from the remote afterwards;
// deliver.ts authenticates its own push.
//
// Env: TARGET (GITHUB_ENV), PAT, RUNNER_TEMP; TARGET_DIR (default target).

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { env, requireEnv } from "../shared/gha.ts";
import { capture, redactText } from "../shared/proc.ts";

const target = requireEnv("TARGET");
const targetDir = env("TARGET_DIR", "target");
const logFile = join(requireEnv("RUNNER_TEMP"), "checkout.log");

function logged(argv: string[], label: string): number {
  const result = capture(argv);
  appendFileSync(
    logFile,
    redactText(
      `$ ${label} -> exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.stdout}${result.stderr}`,
    ),
  );
  return result.exitCode;
}

const cloned = logged(
  [
    "git",
    "clone",
    "--quiet",
    "--depth",
    "1",
    `https://x-access-token:${requireEnv("PAT")}@github.com/${target}.git`,
    targetDir,
  ],
  "git clone",
);
if (cloned !== 0) process.exit(cloned);
process.exit(
  logged(
    ["git", "-C", targetDir, "remote", "set-url", "origin", `https://github.com/${target}.git`],
    "git remote set-url",
  ),
);
