#!/usr/bin/env bun
// Detects the all-green bootstrap gap and writes its PR-body note: when
// this update INTRODUCES .github/workflows/all-green.yml (the delivered
// tree carries it, the target's pre-update HEAD does not), the PR that
// adds the verdict workflow can never receive its own verdict - GitHub
// runs workflow_run-triggered workflows only from the copy on the
// repository's default branch, which does not exist until that very PR
// merges, and the workflow_dispatch unwedge runs under the same
// constraint. The note names the one-time path (an admin-bypass merge)
// and that it self-heals from the next PR on (docs/all-green.md).
//
// Invoked by reusable-template-sync.yml after the preserve steps (the
// working tree is the delivered content, HEAD is still the pre-update
// default branch tip - the same split preserve_local_content.ts reads),
// and by rehearse.ts in the same slot. When commit_push.ts's
// Workflows-scope withhold keeps the file from being delivered, it clears
// the note so the PR body never claims an introduction the push withheld.
//
// The probes read this run's own snapshot - the checkout's HEAD and the
// delivered working tree - like every other leg of the pipeline: a
// default-branch change racing the run surfaces on the NEXT run, which
// regenerates the rolling branch and re-detects. ANY entry at HEAD counts
// as "carries it": a non-blob there (a directory, a symlink) is hand
// damage this very update replaces with the rendered file, so the
// runnable copy exists once the PR merges either way - at worst the note
// is missed once on an already-damaged repo.
//
// Value-free by construction: the note and the log lines name only the
// workflow file and the check - template data, never target content.
//
// Usage:
//   bun all_green_bootstrap.ts [--root target] [--report FILE]
//     [--hide-details true|false]
//
// --report defaults to RUNNER_TEMP/<ALL_GREEN_BOOTSTRAP_NAME> - the shared
// constant open_pr.ts reads from (section_files.ts), so the workflow never
// names the file and the pair cannot drift.

import { lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_NAME } from "../shared/all_green.ts";
import { parseFlags } from "../shared/flags.ts";
import { requireEnv } from "../shared/gha.ts";
import { headBytes } from "../shared/git_head.ts";
import { ALL_GREEN_BOOTSTRAP_NAME } from "./section_files.ts";

/** The verdict workflow's path in every rendered tree. Exported for
 * commit_push.ts's withhold reconciliation - the two sides must test the
 * same path or a withheld introduction would keep a false note. */
export const ALL_GREEN_WORKFLOW_PATH = ".github/workflows/all-green.yml";

/** The PR-body note, or "" when the condition does not hold: the note
 * exists exactly when the update delivers the verdict workflow AND the
 * target's default branch does not already carry it. */
export function bootstrapNote(deliversWorkflow: boolean, defaultBranchHasIt: boolean): string {
  if (!deliversWorkflow || defaultBranchHasIt) return "";
  return [
    "> [!IMPORTANT]",
    "> FIRST VERDICT DELIVERY: this update introduces",
    `> \`${ALL_GREEN_WORKFLOW_PATH}\`, the workflow that posts the`,
    `> required \`${CHECK_NAME}\` check - and GitHub runs \`workflow_run\`-triggered`,
    "> workflows only from the copy on the default branch, which does not",
    "> exist until this PR merges. No verdict can ever land on this PR, and",
    "> the `workflow_dispatch` unwedge runs under the same default-branch",
    "> constraint, so it cannot help here either. Merge this PR once with",
    "> admin bypass; it self-heals immediately - every later PR is judged",
    "> by the merged copy.",
    "",
  ].join("\n");
}

/** Whether the delivered working tree carries the verdict workflow as a
 * regular file, probed FAIL-CLOSED like starter_pin_rollout's content
 * probe: ENOENT and ENOTDIR mean the path is genuinely absent (the render
 * delivers no verdict workflow), a symlink or directory reads absent too
 * (not the rendered workflow - copier renders regular files), and any
 * OTHER lstat error throws - a permission failure reading as "not
 * delivered" would silently skip the note. */
function deliversWorkflow(root: string): boolean {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(join(root, ALL_GREEN_WORKFLOW_PATH));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
  return stat.isFile();
}

function main(argv: string[]): number {
  const flags = parseFlags(argv, [] as const, ["--root", "--report", "--hide-details"] as const);
  const root = flags["--root"] ?? "target";
  const report = flags["--report"] ?? join(requireEnv("RUNNER_TEMP"), ALL_GREEN_BOOTSTRAP_NAME);
  const hideDetails = flags["--hide-details"] === "true";

  // headBytes throws on a broken repository rather than reading damage as
  // "absent at HEAD" - a false note is mild, but fail closed like every
  // other HEAD probe in this pipeline.
  const note = bootstrapNote(
    deliversWorkflow(root),
    headBytes(root, ALL_GREEN_WORKFLOW_PATH) !== null,
  );
  writeFileSync(report, note, "utf-8");

  if (note === "") {
    console.log(
      "all-green bootstrap: not applicable (the verdict workflow is not newly introduced)",
    );
  } else if (hideDetails) {
    // Whether the default branch carries the workflow is target state; a
    // hidden target gets the detail only in the PR body.
    console.log("all-green bootstrap note written (detail in the PR body: private repository)");
  } else {
    console.log(
      `all-green bootstrap: this update introduces ${ALL_GREEN_WORKFLOW_PATH}, which the ` +
        "default branch does not carry, so no verdict can land on this PR - the PR body " +
        "names the one-time admin-bypass merge",
    );
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
