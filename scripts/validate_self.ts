#!/usr/bin/env bun
// `bun run validate`: this checkout judged as fleet CI judges every repository, by the check.ts of the commit its
// manifest records (extracted with git archive, its dependencies installed, removed on every path), then by the hygiene
// checks. A shallow checkout fetches the recorded commit by sha first.
//
// Usage: bun scripts/validate_self.ts [checkout root]

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitResolvedCommit } from "../.github/scripts/shared/git_yes_no.ts";
import { passthrough, redactCommand } from "../.github/scripts/shared/proc.ts";
import { PLATFORM_NAME, PLATFORM_SLUG } from "../actions/shared/platform.ts";
import { recordedCommit } from "../actions/shared/recorded_commit.ts";

const CHECK = "actions/validate-managed-files/check.ts";
const HYGIENE = "actions/validate-managed-files/validator/validate_managed_files.ts";

/** Throws instead of exiting (proc.ts's must), so the extract's finally runs on a failed step. */
function step(command: string[], cwd: string): void {
  const code = passthrough(command, { cwd });
  if (code !== 0) throw new Error(`${redactCommand(command)} exited ${code}`);
}

function judgeAtRecordedCommit(root: string, commit: string): number {
  if (gitResolvedCommit(commit, { cwd: root }) === "") {
    step(["git", "fetch", "--quiet", "--depth=1", "origin", commit], root);
  }
  const extract = mkdtempSync(join(tmpdir(), `${PLATFORM_NAME}-at-`));
  try {
    const tree = join(extract, "tree");
    mkdirSync(tree);
    step(["git", "archive", "--format=tar", `--output=${extract}/tree.tar`, commit], root);
    step(["tar", "-xf", join(extract, "tree.tar"), "-C", tree], root);
    step([process.execPath, "install", "--frozen-lockfile", "--silent"], tree);
    console.log(`judging against ${PLATFORM_NAME} at ${commit.slice(0, 12)}`);
    return passthrough(
      [
        process.execPath,
        join(tree, CHECK),
        "--target",
        root,
        "--repository",
        PLATFORM_SLUG,
        "--private",
        "false",
        "--build",
        commit,
      ],
      { cwd: root },
    );
  } finally {
    rmSync(extract, { recursive: true, force: true });
  }
}

const root = resolve(process.argv[2] ?? ".");
const read = recordedCommit(root);
if ("problem" in read) {
  console.error(`error: ${read.problem}`);
  process.exit(1);
}
let judged: number;
try {
  judged = judgeAtRecordedCommit(root, read.commit);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const hygiene = passthrough([process.execPath, join(root, HYGIENE), "--self", root], { cwd: root });
process.exit(judged !== 0 ? judged : hygiene);
