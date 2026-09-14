#!/usr/bin/env bun
// Runs from the caller's checkout BEFORE the platform checkout, whose `ref:` is the `commit` output; a problem leaves
// `commit` empty and names itself in `problem`, which run.ts reports as the verdict. The checkout lands inside the
// caller's workspace, so a repository path already there is refused: the checkout would replace it, and check.ts would
// then read repo-platform's bytes as the repository's.

import { appendFileSync, lstatSync } from "node:fs";
import { relative } from "node:path";
import { capture, requireEnv, succeeded } from "../../shared/action_runtime.ts";
import { PLATFORM_NAME } from "../../shared/platform.ts";
import { recordedCommit } from "../../shared/recorded_commit.ts";

const GIT_TIMEOUT_MS = 60_000;

/** On disk (a file, a link, an ignored or untracked tree) or in the index (a tracked path deleted from the working
 *  tree, which the checkout would supply repo-platform's bytes for). A failed look is fatal, never "free". */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const tracked = capture(["git", "ls-files", "-z", "--cached", "--", relative(".", path)], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (!succeeded(tracked.exit)) {
    throw new Error(`git ls-files could not answer for ${path}: ${tracked.stderr.trim()}`);
  }
  return tracked.stdout !== "";
}

const platformDir = requireEnv("PLATFORM_DIR");
const read = occupied(platformDir)
  ? {
      problem:
        `the repository holds a path at ${relative(".", platformDir)}, where the check places its checkout of ` +
        `${PLATFORM_NAME}; move it`,
    }
  : recordedCommit(".");
const outputs =
  "commit" in read ? { commit: read.commit, problem: "" } : { commit: "", problem: read.problem };
appendFileSync(
  requireEnv("GITHUB_OUTPUT"),
  `commit=${outputs.commit}\nproblem=${outputs.problem}\n`,
);
if (outputs.commit !== "") console.log(`judged against ${outputs.commit}`);
