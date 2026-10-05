#!/usr/bin/env bun
// Runs from the caller's checkout; `commit` is what the clone step fetches, and a problem leaves it empty and names
// itself in `problem`, which run.ts reports as the verdict.

import { appendFileSync } from "node:fs";
import { requireEnv } from "../../shared/action_runtime.ts";
import { recordedCommit } from "../../shared/recorded_commit.ts";

const read = recordedCommit(".");
const outputs =
  "commit" in read ? { commit: read.commit, problem: "" } : { commit: "", problem: read.problem };
appendFileSync(
  requireEnv("GITHUB_OUTPUT"),
  `commit=${outputs.commit}\nproblem=${outputs.problem}\n`,
);
if (outputs.commit !== "") console.log(`judged against ${outputs.commit}`);
