#!/usr/bin/env bun
// Runs before the install, so node builtins and the dependency-free runtime only. A path that cannot be removed throws,
// which fails the step; a path that does not exist is already clear.

import { rmSync } from "node:fs";
import { requireEnv } from "../../shared/action_runtime.ts";

for (const name of ["SCRATCH_DIR", "VERDICT_FILE", "COMMENT_FILE"]) {
  rmSync(requireEnv(name), { recursive: true, force: true });
}
