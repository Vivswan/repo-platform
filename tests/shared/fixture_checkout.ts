// A git checkout fixture for a check that lists its files through git: the tracked files staged, the untracked ones
// written beside them, under the fixture git config.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixtureGit } from "./fixture_git";
import type { TempDirs } from "./temp_dir";

export function checkout(
  temp: TempDirs,
  prefix: string,
  tracked: Record<string, string>,
  untracked: Record<string, string> = {},
): string {
  const root = temp.dir(prefix);
  fixtureGit(root, ["init", "-q"]);
  for (const [rel, text] of Object.entries({ ...tracked, ...untracked })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const names = Object.keys(tracked);
  if (names.length > 0) fixtureGit(root, ["add", "--", ...names]);
  return root;
}
