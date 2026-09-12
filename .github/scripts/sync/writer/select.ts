// Unknown module names are dropped and reported, never an error: the plan job already failed the PR that introduced them.

import type { FilesConfig } from "../../../../actions/plan/files_config.ts";

export function resolveModules(
  config: FilesConfig,
  requested: string[],
): { selected: string[]; dropped: string[] } {
  const known = Object.keys(config.modules);
  return {
    selected: known.filter((name) => requested.includes(name)),
    dropped: requested.filter((name) => !known.includes(name)),
  };
}
