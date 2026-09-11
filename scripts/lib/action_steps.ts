// The composite actions' manifests and step lists, read the way Actions
// reads them: the one manifest walk and the bun-setup predicates that the
// pin generator, the ssot bun guard, and the delivery-pin rules all judge
// with, so no two of them can ever see different action rosters.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EXCLUDED_DIRS } from "../../.github/scripts/build-branches/branch_tree.ts";

/** The steps of a composite action manifest, parsed structurally so a
 *  quoted or flow-style `uses:` counts and a `uses:`-shaped line inside a
 *  block-scalar `run:` body never does. Non-mapping steps and a missing
 *  runs.steps read as empty. */
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

/** Whether one parsed step's `uses:` names oven-sh/setup-bun at any ref.
 *  Action identifiers are case-insensitive, so a mixed-case spelling is
 *  the same action and must not dodge the pin. */
export function usesSetupBun(step: Record<string, unknown>): boolean {
  return typeof step.uses === "string" && step.uses.toLowerCase().startsWith("oven-sh/setup-bun@");
}

/** Whether an action manifest carries a setup-bun step. */
export function actionSetsUpBun(text: string): boolean {
  return actionSteps(text).some(usesSetupBun);
}

interface ActionManifest {
  /** The action's directory, repo-relative (`actions/<name>`). */
  dir: string;
  /** The manifest's repo-relative path. */
  file: string;
  abs: string;
}

/** Every action manifest (action.yml or action.yaml) under `actionsDir`,
 *  nested actions included, EXCLUDED_DIRS pruned as publication prunes
 *  them, sorted by path. A symbolic link is not a manifest: Dirent's kind
 *  is the link's own, so it is neither read nor walked into. */
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

/** The repo-relative path of every action manifest under `actionsDir`. */
export function actionManifestPaths(actionsDir: string): string[] {
  return actionManifests(actionsDir).map(({ file }) => file);
}

/** The shared setup action every other composite action calls for its bun;
 *  its setup-bun reads the caller's pin through the `pin` input, so it
 *  carries no .bun-version of its own. */
export const BUN_SETUP_ACTION = "actions/bun-setup";

/** Whether one parsed step's `uses:` names the shared bun-setup action in
 *  any spelling: published at any ref, or the relative path. */
export function usesBunSetup(step: Record<string, unknown>): boolean {
  return (
    typeof step.uses === "string" &&
    new RegExp(`(^|/)${BUN_SETUP_ACTION}(@|$)`, "i").test(step.uses.trim())
  );
}

/** Every directory under actions/ carrying a generated .bun-version, sorted:
 *  each whose manifest calls the shared bun-setup action, which reads that
 *  pin, the shared action itself excepted. */
export function bunPinnedActionDirs(actionsDir: string): string[] {
  return actionManifests(actionsDir)
    .filter(
      ({ dir, abs }) =>
        dir !== BUN_SETUP_ACTION && actionSteps(readFileSync(abs, "utf-8")).some(usesBunSetup),
    )
    .map(({ dir }) => dir);
}

/** .bun-version files under actions/ that bunPinnedActionDirs no longer
 *  emits: a stale pin the generator stopped refreshing. The caller throws. */
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
