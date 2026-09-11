// Which module names of a registration files.yml knows: unknown names are
// dropped and reported, never an error that blocks the rest (the plan job
// already failed the PR that introduced them).

import type { FilesConfig } from "../../../../actions/plan/files_config.ts";

/** The requested module names split into the ones files.yml knows (in its
 *  order) and the ones it does not. */
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
