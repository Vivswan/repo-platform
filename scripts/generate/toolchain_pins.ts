// Toolchain pins: the manifests' version pins as dotfiles, the validator's
// TOOLCHAIN_PINS literal and the docs/toolchains.md rows, and the composite
// actions' bun-setup steps that decide which actions carry a .bun-version.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { EXCLUDED_DIRS } from "../../.github/scripts/build-branches/branch_tree.ts";
import type { ModuleManifest } from "../lib/module_manifests.ts";

export interface ToolchainPin {
  module: string;
  file: string;
  version: string;
}

/** The manifests' toolchain pins, in MODULE_ORDER; every pin becomes a
 *  generated templates/<module>/<file> dotfile plus a row in the validator
 *  and docs regions below. */
export function toolchainPins(manifests: ModuleManifest[]): ToolchainPin[] {
  return manifests.flatMap((m) =>
    m.toolchain?.pin ? [{ module: m.module, ...m.toolchain.pin }] : [],
  );
}

/** The version dotfile a pin renders into managed repos: exactly the
 *  version plus a trailing newline (what the setup actions' version-file
 *  readers expect). */
export function pinFileContent(pin: ToolchainPin): string {
  return `${pin.version}\n`;
}

/** validate-template ownership.ts TOOLCHAIN_PINS record literal. */
export function toolchainPinsRegion(manifests: ModuleManifest[]): string[] {
  const pins = toolchainPins(manifests);
  if (pins.length === 0) {
    throw new Error(
      "no manifest declares a toolchain pin, so the validator's " +
        "TOOLCHAIN_PINS record would be empty - declare toolchain: " +
        "{pin: {file, version}} in at least one module.yml",
    );
  }
  return [
    "export const TOOLCHAIN_PINS: Readonly<Partial<Record<string, ToolchainPin>>> = {",
    // Keys stay biome-stable: bare where valid, quoted where a dash in the
    // module name requires it (matching the formatter's as-needed quoting).
    ...pins.map((p) => {
      const key = /^[a-z][a-z0-9]*$/.test(p.module) ? p.module : JSON.stringify(p.module);
      return `  ${key}: { file: "${p.file}", version: "${p.version}" },`;
    }),
    "};",
  ];
}

/** docs/toolchains.md pin table: one row per pinned toolchain module. */
export function toolchainPinRows(manifests: ModuleManifest[]): string[] {
  return toolchainPins(manifests).map((p) => `| \`${p.module}\` | \`${p.file}\` | ${p.version} |`);
}

/** Version-dotfile-shaped files at a module's root that no manifest pin
 *  declares, in the templates tree or the sync writer's files/ tree (its
 *  repo-relative name is `label`): a renamed or removed pin leaves the old
 *  dotfile behind, and composition or the writer would keep shipping it
 *  to every render. Returned (for the caller to throw on) rather than
 *  deleted - the file may be a pin typo to fix, not an orphan to drop. A
 *  module with no directory in the tree lands nothing there. */
export function strayPinFiles(
  manifests: ModuleManifest[],
  dir: string,
  label = "templates",
): string[] {
  const strays: string[] = [];
  for (const m of manifests) {
    if (!existsSync(join(dir, m.module))) continue;
    for (const name of readdirSync(join(dir, m.module)).sort()) {
      if (!/^\.[a-z][a-z0-9.-]*$/.test(name)) continue;
      const path = join(dir, m.module, name);
      if (!lstatSync(path).isFile()) continue;
      if (!/^\d+\.\d+\.\d+\n$/.test(readFileSync(path, "utf-8"))) continue;
      if (m.toolchain?.pin?.file === name) continue;
      strays.push(`${label}/${m.module}/${name}`);
    }
  }
  return strays;
}

/** The steps of a composite action manifest, parsed structurally the way
 *  Actions itself reads them - so a quoted or flow-style `uses:` counts
 *  and a `uses:`-shaped line inside a block-scalar `run:` body never
 *  does, where a text scan gets both wrong. Non-mapping steps and a
 *  missing runs.steps read as empty. */
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

/** Whether one parsed step's `uses:` names oven-sh/setup-bun (at any
 *  ref). GitHub action identifiers are case-insensitive, so the match
 *  normalizes case - a mixed-case spelling is the same action and must
 *  not dodge the pin. The single predicate both the generator and the
 *  actions-bun-guard rule judge with. */
export function usesSetupBun(step: Record<string, unknown>): boolean {
  return typeof step.uses === "string" && step.uses.toLowerCase().startsWith("oven-sh/setup-bun@");
}

/** Whether an action manifest carries a setup-bun step. */
export function actionSetsUpBun(text: string): boolean {
  return actionSteps(text).some(usesSetupBun);
}

/** Every action.yml under `actionsDir`, nested actions included and
 *  EXCLUDED_DIRS pruned as publication prunes them: the manifest's
 *  repo-relative path, its directory's, and its text. */
function actionManifests(actionsDir: string): { dir: string; file: string; text: string }[] {
  const found: { dir: string; file: string; text: string }[] = [];
  const walk = (dir: string, rel: string) => {
    const manifest = join(dir, "action.yml");
    if (existsSync(manifest)) {
      found.push({ dir: rel, file: `${rel}/action.yml`, text: readFileSync(manifest, "utf-8") });
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), `${rel}/${entry.name}`);
    }
  };
  walk(actionsDir, "actions");
  return found;
}

/** The shared setup action every other composite action calls for its bun;
 *  its setup-bun reads the caller's pin through the `pin` input, so it
 *  carries no .bun-version of its own. */
export const BUN_SETUP_ACTION = "actions/bun-setup";

/** Whether one parsed step's `uses:` names the shared bun-setup action in
 *  any spelling: published at any ref, or the relative path (identifiers
 *  are case-insensitive). */
export function usesBunSetup(step: Record<string, unknown>): boolean {
  return (
    typeof step.uses === "string" &&
    new RegExp(`(^|/)${BUN_SETUP_ACTION}(@|$)`, "i").test(step.uses.trim())
  );
}

/** Every directory under actions/ carrying a generated .bun-version, sorted:
 *  each whose action.yml calls the shared bun-setup action, which reads that
 *  pin (EXCLUDED_DIRS bounds the walk), the shared action itself excepted. */
export function bunPinnedActionDirs(actionsDir: string): string[] {
  return actionManifests(actionsDir)
    .filter(({ dir, text }) => dir !== BUN_SETUP_ACTION && actionSteps(text).some(usesBunSetup))
    .map(({ dir }) => dir)
    .sort();
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

/** The bun module's toolchain pin - the single source the action-local
 *  .bun-version dotfiles are generated from. */
export function bunToolchainPin(manifests: ModuleManifest[]): ToolchainPin {
  const bun = manifests.find((m) => m.module === "bun");
  if (bun?.toolchain?.pin === undefined) {
    throw new Error(
      "templates/bun/module.yml declares no toolchain.pin - the composite " +
        "actions' .bun-version dotfiles have no source",
    );
  }
  return { module: bun.module, ...bun.toolchain.pin };
}
