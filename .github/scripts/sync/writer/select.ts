// The registration's modules in files.yml order. A name files.yml does not offer is refused in the plan's words
// (actions/plan/registration.ts), never dropped: the PR check and the sync speak one refusal.

import type { FilesConfig } from "../../../../actions/plan/files_config.ts";
import { unknownModuleProblems } from "../../../../actions/plan/registration.ts";

export function selectModules(config: FilesConfig, requested: string[]): string[] {
  const known = Object.keys(config.modules);
  const problems = unknownModuleProblems(requested, known);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return known.filter((name) => requested.includes(name));
}
