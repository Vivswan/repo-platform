import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boundedSpawnSync } from "../../../shared/bounded_spawn.ts";
import type { TempDirs } from "../../../shared/temp_dir.ts";

export const VALIDATOR = join(
  import.meta.dir,
  "../../../../actions/validate-managed-files/validator/validate_managed_files.ts",
);

const B = "<!-- BEGIN REPO-PLATFORM MANAGED -->";
const E = "<!-- END REPO-PLATFORM MANAGED -->";
const HB = "# BEGIN REPO-PLATFORM MANAGED";
const HE = "# END REPO-PLATFORM MANAGED";

export const BASELINE: Record<string, string> = {
  ".repo-platform.yml": "modules: [uv]\n",
  ".gitignore": `# local patterns go here\n\n${HB}\nnode_modules/\n${HE}\n`,
  ".editorconfig": `${HB}\nroot = true\n${HE}\n`,
  "LICENSE.md": `${B}\n# License\n${E}\n`,
  "AGENTS.md": `${B}\n# AGENTS.md\n${E}\n`,
  ".github/workflows/ci.yml": "name: CI\non: [push]\njobs: {}\n",
};

export interface ValidatorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** tests/shared/temp_dir.ts binds its afterAll to the registering file, so each suite hands in its own TempDirs
 *  and this module never calls tempDirs() itself. */
export function validatorRunner(temp: TempDirs) {
  return function runValidator(extra: Record<string, string> = {}): ValidatorResult {
    const root = temp.dir("validate-managed-");
    const tree: Record<string, string> = { ...BASELINE, ...extra };
    for (const [rel, content] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    const result = boundedSpawnSync([process.execPath, VALIDATOR, root]);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}
