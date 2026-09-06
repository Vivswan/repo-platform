// A composite action step's run block, invoked the way the runner invokes
// it: written to a script file that replaces `{0}` in the action's shell
// string (tests/shared owns the file; the caller's temp dir owns its life).

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS_BASH_SHELL } from "../../scripts/check_ssot";

let scripts = 0;

export function actionStepArgv(run: string, dir: string): string[] {
  const file = join(dir, `step-${scripts++}.sh`);
  writeFileSync(file, run);
  return ACTIONS_BASH_SHELL.split(" ").map((word) => (word === "{0}" ? file : word));
}
