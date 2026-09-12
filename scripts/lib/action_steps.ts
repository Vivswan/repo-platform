// The one manifest walk and the bun-setup predicates the pin generator, the ssot bun guard, and the delivery-pin rules share,
// so no two of them can see different action rosters.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EXCLUDED_DIRS } from "../../.github/scripts/build-branches/branch_tree.ts";

/** Parsed structurally rather than grepped: a quoted or flow-style `uses:` counts,
 *  and a `uses:`-shaped line inside a block-scalar `run:` body never does. */
export function actionSteps(text: string): Record<string, unknown>[] {
  const doc = parseYaml(text);
  if (typeof doc !== "object" || doc === null) return [];
  const runs = (doc as Record<string, unknown>).runs;
  if (typeof runs !== "object" || runs === null) return [];
  const steps = (runs as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter(
    (step): step is Record<string, unknown> => typeof step === "object" && step !== null,
  );
}

/** Action identifiers are case-insensitive, so a mixed-case spelling is the same action and must not dodge the pin. */
export function usesSetupBun(step: Record<string, unknown>): boolean {
  return typeof step.uses === "string" && step.uses.toLowerCase().startsWith("oven-sh/setup-bun@");
}

export function actionSetsUpBun(text: string): boolean {
  return actionSteps(text).some(usesSetupBun);
}

interface ActionManifest {
  dir: string;
  file: string;
  abs: string;
}

/** EXCLUDED_DIRS prunes the walk exactly as publication prunes the tree (branch_tree.ts).
 *  A symlink's Dirent kind is the link's own, so isFile and isDirectory both skip it: a linked manifest is not one. */
function actionManifests(actionsDir: string): ActionManifest[] {
  const found: ActionManifest[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isFile() && /^action\.ya?ml$/.test(entry.name)) {
        found.push({ dir: rel, file: `${rel}/${entry.name}`, abs });
      } else if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
        walk(abs, `${rel}/${entry.name}`);
      }
    }
  };
  walk(actionsDir, "actions");
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

export function actionManifestPaths(actionsDir: string): string[] {
  return actionManifests(actionsDir).map(({ file }) => file);
}

/** Its setup-bun reads the caller's pin through the `pin` input, so it carries no .bun-version of its own. */
export const BUN_SETUP_ACTION = "actions/bun-setup";

export function usesBunSetup(step: Record<string, unknown>): boolean {
  return (
    typeof step.uses === "string" &&
    new RegExp(`(^|/)${BUN_SETUP_ACTION}(@|$)`, "i").test(step.uses.trim())
  );
}

export function bunPinnedActionDirs(actionsDir: string): string[] {
  return actionManifests(actionsDir)
    .filter(
      ({ dir, abs }) =>
        dir !== BUN_SETUP_ACTION && actionSteps(readFileSync(abs, "utf-8")).some(usesBunSetup),
    )
    .map(({ dir }) => dir);
}

export function strayActionPinFiles(actionsDir: string): string[] {
  const emitted = new Set(bunPinnedActionDirs(actionsDir));
  const strays: string[] = [];
  const visit = (dir: string, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) visit(join(dir, entry.name), `${rel}/${entry.name}`);
      else if (entry.name === ".bun-version" && !emitted.has(rel)) {
        strays.push(`${rel}/.bun-version`);
      }
    }
  };
  visit(actionsDir, "actions");
  return strays.sort();
}
