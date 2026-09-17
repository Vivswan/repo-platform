// The manifest's commit is the one the fleet's validate-managed-files check judges the repository with (its check.ts at
// that commit), so a repository whose tree a sync left as it was keeps its judge, and only a checker change moves it.

import { gitAnswersYes, gitResolvedCommit } from "../../shared/git_yes_no.ts";
import { lastLine } from "../../shared/lines.ts";
import { capture } from "../../shared/proc.ts";

/** The checker's own code and its shared imports, relative to the platform root; a directory ends in a slash. The
 *  writer it runs is not here: a writer change that matters writes a byte, and the stamp moves for that. docs/sync.md
 *  names the same paths, and tests/sync/writer/stamp.test.ts pins the two and the checker's import closure. */
export const CHECKER_SURFACE = ["actions/validate-managed-files/", "actions/shared/"] as const;

/** Whether the checker differs between two commits of the platform checkout at `root`. The operator's build checkout is
 *  one commit deep, so `from` is fetched by sha first when the checkout lacks it. */
export function checkerChanged(root: string, from: string, to: string): boolean {
  const cwd = { cwd: root };
  if (gitResolvedCommit(from, cwd) === "") {
    const fetched = capture(["git", "fetch", "--quiet", "--depth=1", "origin", from], cwd);
    if (fetched.exitCode !== 0) {
      throw new Error(
        `the manifest records commit ${from.slice(0, 12)}, which the build checkout cannot fetch ` +
          `(${lastLine(fetched.stderr) || `exit ${fetched.exitCode}`}); the sync judges nothing against a commit it cannot see`,
      );
    }
  }
  return !gitAnswersYes(["diff", "--quiet", from, to, "--", ...CHECKER_SURFACE], cwd);
}

export interface StampInput {
  /** The commit the manifest named before this run; null when it named none the writer can read. */
  recorded: string | null;
  build: string;
  /** checkerChanged between the recorded commit and the build. */
  checkerMoved: boolean;
  /** Whether this run left a tracked byte different: a file written, retired, or mirrored, or a manifest record moved. */
  wroteChange: boolean;
}

/** The stamp rule, docs/sync.md "The manifest". */
export function judgedCommit({ recorded, build, checkerMoved, wroteChange }: StampInput): string {
  return recorded === null || checkerMoved || wroteChange ? build : recorded;
}
