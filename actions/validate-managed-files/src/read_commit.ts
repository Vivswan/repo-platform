#!/usr/bin/env bun
// Runs from the caller's checkout; `commit` is what the clone step fetches, and a problem leaves it empty and names
// itself in `problem`, which run.ts reports as the verdict.

import { setFailed, setOutput } from "@actions/core";
import { messageOf } from "../../shared/action_runtime.ts";
import { recordedCommit } from "../../shared/recorded_commit.ts";

try {
  const read = recordedCommit(".");
  const outputs =
    "commit" in read ? { commit: read.commit, problem: "" } : { commit: "", problem: read.problem };
  setOutput("commit", outputs.commit);
  setOutput("problem", outputs.problem);
  if (outputs.commit !== "") console.log(`judged against ${outputs.commit}`);
} catch (cause) {
  setFailed(messageOf(cause));
}
