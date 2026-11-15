// The one manifest walk the delivery-pin rules read, so no two readers see different action rosters.

import { globSync } from "node:fs";
import { join, relative } from "node:path";

/** Installed dependencies never count as action directories: each action reinstalls them from its shipped lockfile. */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/** A symlink's Dirent kind is the link's own, so isFile skips a linked manifest. The glob walks no linked directory and no dot directory. */
export function actionManifestPaths(actionsDir: string): string[] {
  return globSync("**/action.{yml,yaml}", {
    cwd: actionsDir,
    withFileTypes: true,
    exclude: (entry) => EXCLUDED_DIRS.has(entry.name),
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join("actions", relative(actionsDir, entry.parentPath), entry.name))
    .sort((a, b) => a.localeCompare(b));
}
