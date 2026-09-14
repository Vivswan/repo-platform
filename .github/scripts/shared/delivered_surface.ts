// What a sync writes into a repository is decided by these paths alone, so two platform commits that agree on them
// deliver the same tree, and the writer keeps a repository's recorded commit across such a pair (its judgedCommit).

import { gitAnswersYes, gitResolvedCommit } from "./git_yes_no.ts";
import { lastLine } from "./lines.ts";
import { capture } from "./proc.ts";

/** The writer's data, its import closure, and its dependency versions, relative to the platform root; a directory ends in
 *  a slash. docs/sync.md lists the same paths, and a test pins the two. bun.lock is on it because the settings library's
 *  version decides the rendered settings.yml's key order; package.json because its postinstall decides which action-local
 *  dependencies the writer resolves. */
export const DELIVERED_SURFACE = [
  "files.yml",
  "files/",
  "actions/",
  ".github/scripts/sync/",
  ".github/scripts/shared/",
  "migrations/",
  "bun.lock",
  "package.json",
] as const;

/** Whether the delivered surface differs between two commits of the platform checkout at `root`. The operator's build
 *  checkout is one commit deep, so `from` is fetched by sha first when the checkout lacks it. */
export function deliveredSurfaceChanged(root: string, from: string, to: string): boolean {
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
  return !gitAnswersYes(["diff", "--quiet", from, to, "--", ...DELIVERED_SURFACE], cwd);
}
