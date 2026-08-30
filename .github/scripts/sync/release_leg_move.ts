#!/usr/bin/env bun
// Detects the release job's home move and writes its PR-body note: when
// the target's pre-update HEAD carries the retired `info-release` job in
// the managed ci.yml, the delivered ci.yml no longer does, and the
// delivered all-green.yml carries the verdict-gated release leg, the
// release trigger is moving files. The note is informational (releases
// keep working), but it names the one workflow_run caveat worth knowing
// at merge time: the wrapper executes the default branch's copy, so the
// new leg goes live on the first push to main AFTER the PR merges.
//
// Invoked by reusable-template-sync.yml after the preserve steps (the
// working tree is the delivered content, HEAD is still the pre-update
// default branch tip) and by rehearse.ts in the same slot. When
// commit_push.ts's Workflows-scope withhold keeps all-green.yml from
// being delivered, it clears the note so the PR body never claims a
// move the push withheld.
//
// Self-retiring: once a repo's HEAD no longer carries info-release, the
// condition never holds again and the report stays empty - delete this
// script when the fleet has crossed.
//
// Value-free by construction: the note and the log lines name only
// managed filenames and job ids - template data, never target content.
//
// Usage:
//   bun release_leg_move.ts [--root target] [--report FILE]
//     [--hide-details true|false]

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv } from "../shared/gha.ts";
import { headEntry } from "../shared/git_head.ts";
import { RELEASE_LEG_MOVE_NAME } from "./section_files.ts";

/** The managed CI workflow's path in every rendered tree. */
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/** The managed verdict wrapper's path (also all_green_bootstrap.ts's
 * ALL_GREEN_WORKFLOW_PATH - spelled here too so this one-time script
 * stays deletable without touching the bootstrap pair). */
export const WRAPPER_WORKFLOW_PATH = ".github/workflows/all-green.yml";

/** The PR-body note, or "" when the condition does not hold: the note
 * exists exactly when HEAD's ci.yml still carries the retired
 * info-release job, the DELIVERED ci.yml no longer does, and the
 * delivered all-green.yml carries the leg - all three, so the note never
 * claims a move a partial delivery did not make. */
export function releaseLegMoveNote(
  headCiHasInfoRelease: boolean,
  deliveredCiHasInfoRelease: boolean,
  deliversLeg: boolean,
): string {
  if (!headCiHasInfoRelease || deliveredCiHasInfoRelease || !deliversLeg) return "";
  return [
    "> [!NOTE]",
    "> RELEASE HOME MOVE: this update removes the `info-release` job from",
    `> the managed \`${CI_WORKFLOW_PATH}\` and delivers the release leg inside`,
    `> \`${WRAPPER_WORKFLOW_PATH}\`, gated on the all-green VERDICT instead of`,
    "> the CI run's own jobs. `workflow_run`-triggered workflows execute the",
    "> default branch's copy, so the new leg goes live on the first push to",
    "> main after this PR merges - only the release trigger moves; the",
    "> release pipeline itself is unchanged.",
    "",
  ].join("\n");
}

/** Whether a line is exactly the given 2-space-indented job id. */
function hasJobLine(text: string, jobId: string): boolean {
  return text.split("\n").includes(`  ${jobId}:`);
}

/** Whether the delivered working tree carries `jobId` in `rel` as a
 * regular file's line, probed fail-closed like all_green_bootstrap.ts's
 * deliversWorkflow: ENOENT/ENOTDIR read as absent, non-files read as
 * absent, any other error throws. */
function deliveredFileHasJob(root: string, rel: string, jobId: string): boolean {
  const path = join(root, rel);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  if (!stat.isFile()) return false;
  return hasJobLine(readFileSync(path, "utf-8"), jobId);
}

function main(argv: string[]): number {
  const flags = parseFlags(argv, [] as const, ["--root", "--report", "--hide-details"] as const);
  const root = flags["--root"] ?? "target";
  const report = flags["--report"] ?? join(requireEnv("RUNNER_TEMP"), RELEASE_LEG_MOVE_NAME);
  const hideDetails = flags["--hide-details"] === "true";

  // headEntry throws on a broken repository rather than reading damage as
  // "absent at HEAD"; only a regular blob can carry the retired job, so
  // non-blob shapes read as not-carrying (the move story needs a readable
  // managed ci.yml on the old side).
  const entry = headEntry(root, CI_WORKFLOW_PATH);
  const headHasInfoRelease =
    entry.kind === "blob" && hasJobLine(entry.bytes.toString("utf-8"), "info-release");
  const note = releaseLegMoveNote(
    headHasInfoRelease,
    deliveredFileHasJob(root, CI_WORKFLOW_PATH, "info-release"),
    deliveredFileHasJob(root, WRAPPER_WORKFLOW_PATH, "release"),
  );
  writeFileSync(report, note, "utf-8");

  if (note === "") {
    console.log("release leg move: not applicable (no info-release-to-wrapper transition here)");
  } else if (hideDetails) {
    // Whether HEAD still carries the old job is target state; a hidden
    // target gets the detail only in the PR body.
    console.log("release leg move note written (detail in the PR body: private repository)");
  } else {
    console.log(
      "release leg move: this update moves the release job from ci.yml's info-release to " +
        "the verdict-gated leg in all-green.yml - the PR body carries the go-live note",
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
