// The one commitlint launch, over the config beside this file. The commit-msg hook (scripts/check/check_commit_subject.ts)
// imports it from here: an action resolves imports from its own directory alone, and node_modules sits in this directory.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(import.meta.resolve("@commitlint/cli/cli.js"));
const CONFIG = fileURLToPath(new URL("commitlint.config.mjs", import.meta.url));

export interface Verdict {
  status: number;
  /** commitlint's report, captured so a caller judging several candidates prints only the one it settles on. */
  report: string;
}

/** Without a message on stdin, `args` names the commit range (--from, --to). */
export function commitlint(args: string[], message?: string): Verdict {
  const result = spawnSync(process.execPath, [CLI, "--config", CONFIG, ...args], {
    input: message,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, report: result.stdout };
}
