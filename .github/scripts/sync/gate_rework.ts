#!/usr/bin/env bun
// Detects the meta-check gate rework and writes its PR-body note: when
// the target's pre-update HEAD still carries the retired verdict wrapper
// (.github/workflows/all-green.yml), the delivered tree deletes it, and
// the delivered ci.yml carries the all-green gate job, this update is
// the one-time transition from the workflow_run verdict to the in-run
// gate. The note is informational (the PR gates ITSELF: its own CI run's
// all-green job posts the required check, so no bootstrap path exists
// any more), but it names what a reviewer sees at merge time: the old
// wrapper goes red on this PR's CI completion until the deletion merges
// (it still runs the default branch's copy, whose reusable no longer
// exists), and the release leg - where the repo selects release-please -
// now lives in ci.yml and fires from the first post-merge main push.
//
// Invoked by reusable-template-sync.yml after the preserve steps (the
// working tree is the delivered content, HEAD is still the pre-update
// default branch tip) and by rehearse.ts in the same slot. When
// commit_push.ts's Workflows-scope withhold restores either workflow
// file, it clears the note so the PR body never claims a rework the
// push withheld.
//
// Self-retiring: once a repo's HEAD no longer carries all-green.yml, the
// condition never holds again and the report stays empty - delete this
// script when the fleet has crossed.
//
// Value-free by construction: the note and the log lines name only
// managed filenames and job ids - template data, never target content.
//
// Usage:
//   bun gate_rework.ts [--root target] [--report FILE]
//     [--hide-details true|false]

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv } from "../shared/gha.ts";
import { headEntry } from "../shared/git_head.ts";
import { GATE_REWORK_NAME } from "./section_files.ts";

/** The managed CI workflow's path in every rendered tree (also
 * commit_push.ts's withhold-reconciliation key for this note). */
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

/** The RETIRED verdict wrapper's path: this update deletes it. */
export const WRAPPER_WORKFLOW_PATH = ".github/workflows/all-green.yml";

/** The PR-body note, or "" when the condition does not hold: the note
 * exists exactly when HEAD still carries the wrapper, the delivered tree
 * deletes it, and the delivered ci.yml carries the gate job - all three,
 * so the note never claims a rework a partial delivery did not make. */
export function gateReworkNote(
  headHasWrapper: boolean,
  deliveredHasWrapper: boolean,
  deliveredCiHasGate: boolean,
): string {
  if (!headHasWrapper || deliveredHasWrapper || !deliveredCiHasGate) return "";
  return [
    "> [!NOTE]",
    "> GATE REWORK: this update deletes the verdict wrapper",
    `> \`${WRAPPER_WORKFLOW_PATH}\` - the required \`all-green\` check is now the`,
    `> \`all-green\` JOB's own check run in the managed \`${CI_WORKFLOW_PATH}\`,`,
    "> posted by this PR's own CI run (no bootstrap path exists any more).",
    "> Until this PR merges, a still-runnable old wrapper keeps firing the",
    "> default branch's copy on each CI completion and goes red there -",
    "> noise, not a gate; it stops with the merge. Where this repository selects",
    "> release-please, the release leg now lives in ci.yml and fires from",
    "> the first post-merge push to main.",
    "",
  ].join("\n");
}

/** Whether a line is exactly the given 2-space-indented job id. */
function hasJobLine(text: string, jobId: string): boolean {
  return text.split("\n").includes(`  ${jobId}:`);
}

/** Whether the delivered working tree carries `rel` as a regular file,
 * probed fail-closed: ENOENT/ENOTDIR read as absent, non-files read as
 * absent, any other error throws. */
function deliveredFile(root: string, rel: string): string | null {
  const path = join(root, rel);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  return readFileSync(path, "utf-8");
}

function main(argv: string[]): number {
  const flags = parseFlags(argv, [] as const, ["--root", "--report", "--hide-details"] as const);
  const root = flags["--root"] ?? "target";
  const report = flags["--report"] ?? join(requireEnv("RUNNER_TEMP"), GATE_REWORK_NAME);
  const hideDetails = flags["--hide-details"] === "true";

  // headEntry throws on a broken repository rather than reading damage as
  // "absent at HEAD". ANY entry at HEAD counts as "carries it": a
  // non-blob there (a directory, a symlink) is hand damage this very
  // update deletes with the rendered file either way.
  const headHasWrapper = headEntry(root, WRAPPER_WORKFLOW_PATH).kind !== "absent";
  const deliveredCi = deliveredFile(root, CI_WORKFLOW_PATH);
  const note = gateReworkNote(
    headHasWrapper,
    deliveredFile(root, WRAPPER_WORKFLOW_PATH) !== null,
    deliveredCi !== null && hasJobLine(deliveredCi, "all-green"),
  );
  writeFileSync(report, note, "utf-8");

  if (note === "") {
    console.log("gate rework: not applicable (no wrapper-to-in-run-gate transition here)");
  } else if (hideDetails) {
    // Whether HEAD still carries the wrapper is target state; a hidden
    // target gets the detail only in the PR body.
    console.log("gate rework note written (detail in the PR body: private repository)");
  } else {
    console.log(
      "gate rework: this update deletes the all-green.yml verdict wrapper and hands the " +
        "required check to ci.yml's own all-green job - the PR body carries the note",
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
