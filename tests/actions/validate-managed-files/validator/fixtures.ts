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

export function gitFreeEnv(): Record<string, string> {
  // Hook-driven runs (husky pre-commit) export GIT_DIR/GIT_INDEX_FILE, which
  // would make the spawned validator's git calls resolve the enclosing repo
  // instead of the scratch tree (or lack thereof).
  const env = { ...process.env } as Record<string, string>;
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

export interface RunValidatorOptions {
  gitInit?: boolean;
  gitAddForce?: string[];
  env?: Record<string, string>;
}

export interface ValidatorResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** tests/shared/temp_dir.ts binds its afterAll to the registering file, so each suite hands in its own TempDirs
 *  and this module never calls tempDirs() itself. */
export function validatorRunner(temp: TempDirs) {
  return function runValidator(
    extra: Record<string, string> = {},
    args: string[] = [],
    opts: RunValidatorOptions = {},
  ): ValidatorResult {
    const root = temp.dir("validate-managed-");
    const tree: Record<string, string> = { ...BASELINE, ...extra };
    for (const [rel, content] of Object.entries(tree)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    if (opts.gitInit) {
      const init = boundedSpawnSync(["git", "-C", root, "init", "-q"], { env: gitFreeEnv() });
      if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`);
    }
    if (opts.gitAddForce?.length) {
      const add = boundedSpawnSync(["git", "-C", root, "add", "-f", "--", ...opts.gitAddForce], {
        env: gitFreeEnv(),
      });
      if (add.exitCode !== 0) throw new Error(`git add -f failed: ${add.stderr}`);
    }
    const result = boundedSpawnSync([process.execPath, VALIDATOR, ...args, root], {
      env: { ...gitFreeEnv(), ...opts.env },
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}
