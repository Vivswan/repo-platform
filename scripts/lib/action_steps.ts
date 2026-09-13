// The one manifest walk the delivery-pin rules read, so no two readers see different action rosters.

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Installed dependencies never count as action directories: each action reinstalls them from its shipped lockfile. */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(["node_modules"]);

/** A symlink's Dirent kind is the link's own, so isFile and isDirectory both skip it: a linked manifest is not one. */
export function actionManifestPaths(actionsDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /^action\.ya?ml$/.test(entry.name)) {
        found.push(`${rel}/${entry.name}`);
      } else if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
        walk(join(dir, entry.name), `${rel}/${entry.name}`);
      }
    }
  };
  walk(actionsDir, "actions");
  return found.sort((a, b) => a.localeCompare(b));
}
