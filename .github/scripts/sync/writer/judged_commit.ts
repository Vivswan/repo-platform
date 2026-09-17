// The manifest's commit is the one the fleet's validate-managed-files check judges the repository with (its check.ts at
// that commit), so a repository whose tree a sync left as it was keeps its judge, and only a checker change moves it.

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gitAnswersYes, gitResolvedCommit } from "../../shared/git_yes_no.ts";
import { lastLine } from "../../shared/lines.ts";
import { capture } from "../../shared/proc.ts";

/** The fleet check's entry at a recorded commit; the action's other entries run at `stable` and restamp nothing. */
export const CHECK_ENTRY = "actions/validate-managed-files/check.ts";

/** The checker surface: every file check.ts imports, followed through relative imports (named or side-effect) in the
 *  platform checkout at `root`, as paths relative to it. Derived rather than listed, so an operator script or a stable-run
 *  validator file beside an imported one never restamps the fleet. A change to any of these can turn the recorded
 *  commit's verdict away from the build's with no byte written: the build's registration parser accepts a value the
 *  recorded one rejects, so its check would stay red with no sync PR to move the stamp. */
export function checkerSurface(root: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const source = readFileSync(join(root, path), "utf-8");
    for (const [, spec] of source.matchAll(/(?:from|import)\s+"(\.[^"]+)"/g)) {
      visit(relative(root, resolve(root, dirname(path), spec)));
    }
  };
  visit(CHECK_ENTRY);
  return [...seen].sort();
}

/** Whether the checker differs between two commits of the platform checkout at `root`, the surface read from `to`'s
 *  tree (the checkout). A file imported at `from` and dropped since is covered: dropping an import changes a file still
 *  on the surface. The operator's build checkout is one commit deep, so `from` is fetched by sha first when the checkout
 *  lacks it. */
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
  return !gitAnswersYes(["diff", "--quiet", from, to, "--", ...checkerSurface(root)], cwd);
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
