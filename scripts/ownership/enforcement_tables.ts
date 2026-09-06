// The validator's enforcement tables derived from the declarations plus
// each source's decoration and filename gates: the per-module entries and
// the base tree's entries with their render conditions.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleManifest } from "../lib/module_manifests.ts";
import {
  loadBaseOwnership,
  type OwnershipDeclaration,
  SETTINGS_LAYER_NAMES,
} from "./declarations.ts";
import { hasManagedHeader } from "./decoration_checks.ts";
import { landedPathAndGates } from "./landed_paths.ts";

export type OwnershipEntry =
  | { path: string; kind: "header" }
  | { path: string; kind: "class-only" }
  | { path: string; kind: "region"; begin: string; end: string };

/** Render conditions the validator can evaluate from a rendered repo's
 *  answers and modules list, translated from declared filename gates. */
export interface RenderWhen {
  publicOnly?: true;
  withoutModule?: string;
}

export type BaseOwnershipEntry = OwnershipEntry & { when?: RenderWhen };

/** A source folder's landed files: landed path -> gates + source text
 *  (null for symlinks - no text to read decoration from). */
function landedFiles(
  folder: string,
): Map<string, { gates: string[]; source: string | null; templateRel: string }> {
  const out = new Map<string, { gates: string[]; source: string | null; templateRel: string }>();
  const visit = (rel: string) => {
    for (const name of readdirSync(join(folder, rel)).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (childRel === "fragments" || childRel === "module.yml" || childRel === "ownership.yml") {
        continue;
      }
      // The module's settings layers are module METADATA like the manifest:
      // read by the fleet's settings merge, never rendered into a repository,
      // so they land nowhere and declare no ownership class.
      if (SETTINGS_LAYER_NAMES.has(childRel)) continue;
      const stat = lstatSync(join(folder, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        visit(childRel);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const rendered = childRel.replace(/\.jinja$/, "");
      const { path, gates } = landedPathAndGates(rendered);
      out.set(path, {
        gates,
        source: stat.isSymbolicLink() ? null : readFileSync(join(folder, childRel), "utf-8"),
        templateRel: childRel,
      });
    }
  };
  visit("");
  return out;
}

/** The enforcement a declaration gets in the validator's tables, mapped
 *  from the DECLARATION alone (see the schema's headerless note): "header"
 *  for a managed file, "class-only" for a managed file declared headerless
 *  (nothing to check in-file, but the path must still reach the manifest
 *  cross-check or a hand-flipped class would silently exempt it from byte
 *  parity), and "region" for splits, carrying the declared BEGIN/END
 *  marker pair. null for starters (repo-owned; nothing to enforce). */
function enforcementOf(declaration: OwnershipDeclaration): OwnershipEntry | null {
  switch (declaration.class) {
    case "starter":
      return null;
    case "managed":
      return declaration.headerless === true
        ? { path: declaration.path, kind: "class-only" }
        : { path: declaration.path, kind: "header" };
    case "split":
      return {
        path: declaration.path,
        kind: "region",
        begin: declaration.begin,
        end: declaration.end,
      };
    default: {
      const unhandled: never = declaration;
      throw new Error(`unhandled ownership class: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The one error a managed declaration's header mode can produce against
 *  its source, or null. Both drift directions are loud: a deleted header
 *  fails regeneration instead of silently downgrading enforcement, and a
 *  headerless declaration whose file grew a header names the stale
 *  declaration. */
function headerModeError(
  declaration: OwnershipDeclaration,
  source: string | null,
  where: string,
): string | null {
  if (declaration.class !== "managed") return null;
  if (declaration.headerless === true) {
    return source !== null && hasManagedHeader(source)
      ? `${where}: '${declaration.path}' is declared headerless but its source opens ` +
          "with the managed header - the validator would not enforce the header it " +
          "carries; drop `headerless: true` or the header"
      : null;
  }
  return source === null || !hasManagedHeader(source)
    ? `${where}: '${declaration.path}' is declared managed but its source does not ` +
        "open with the managed header - the validator enforces the header on every " +
        "rendered copy; add the header, or declare `headerless: true` if the format " +
        "has no comment channel"
    : null;
}

/** The rendered paths, per module, whose ownership declaration the
 *  validator enforces while the module is selected - derived from the
 *  module.yml `ownership:` declarations plus each source's decoration
 *  (header presence, the declared marker). A declared path with no
 *  template file, or a landed file with no declaration, throws: the
 *  composer reports the same drift as a compose error, and this generator
 *  must never emit tables from a tree it cannot account for. */
export function moduleOwnershipEntries(
  manifests: ModuleManifest[],
  templatesDir: string,
): Record<string, OwnershipEntry[]> {
  const result: Record<string, OwnershipEntry[]> = {};
  for (const m of manifests) {
    const where = `templates/${m.module}/module.yml`;
    const files = landedFiles(join(templatesDir, m.module));
    const declarations = m.ownership ?? [];
    const declared = new Set(declarations.map((d) => d.path));
    for (const [path, { templateRel }] of files) {
      if (!declared.has(path)) {
        throw new Error(
          `templates/${m.module}/${templateRel}: lands at '${path}' with no ownership ` +
            `declaration - add the entry to ${where}'s ownership list`,
        );
      }
    }
    const entries: OwnershipEntry[] = [];
    for (const declaration of declarations) {
      const file = files.get(declaration.path);
      if (file === undefined) {
        throw new Error(
          `${where}: ownership declares '${declaration.path}', but no templates/` +
            `${m.module}/ file lands there - fix the path or delete the entry`,
        );
      }
      // Checked before the gate handling: a gated managed file's header
      // mode must hold too, even though the module tables never enforce it.
      const headerDrift = headerModeError(declaration, file.source, where);
      if (headerDrift !== null) throw new Error(headerDrift);
      const entry = enforcementOf(declaration);
      if (entry === null) continue;
      // Module selection alone does not render a filename-gated file, and
      // the module-keyed tables carry no render conditions - an entry here
      // would false-positive on renders whose gate is off, while dropping
      // it silently (the old behavior) exempted the file from enforcement
      // with nothing said. The composer refuses module filename gates
      // outright (custom gates live in module.yml, module-wide), so this
      // only fires on a tree the composer would reject too.
      if (file.gates.length > 0) {
        throw new Error(
          `${where}: '${declaration.path}' is enforceable but filename-gated ` +
            `(${file.gates.join(" and ")}), and the validator's module tables carry no ` +
            "render conditions, so it would silently fall out of enforcement - module " +
            "files must not carry filename gates (gate CONTENT with jinja instead, or " +
            "set the module-wide gate in module.yml)",
        );
      }
      entries.push(entry);
    }
    if (entries.length > 0) result[m.module] = entries;
  }
  if (Object.keys(result).length === 0) {
    throw new Error(
      "no module declaration yields an enforceable entry, so the validator's " +
        "MODULE_OWNERSHIP record would be empty - the managed module " +
        "workflows are expected to carry the header",
    );
  }
  return result;
}

/** Declared filename gates translated to conditions the validator can
 *  evaluate client-side. Only the forms the base tree uses are known; an
 *  enforced file behind an untranslatable gate throws so it cannot
 *  silently fall out of the tables. */
export function translateGates(gates: string[], where: string): RenderWhen | undefined {
  if (gates.length === 0) return undefined;
  const when: RenderWhen = {};
  for (const gate of gates) {
    const withoutModule = /^'([a-z][a-z0-9-]*)' not in modules$/.exec(gate);
    if (gate === "not private") {
      when.publicOnly = true;
    } else if (withoutModule) {
      if (when.withoutModule !== undefined && when.withoutModule !== withoutModule[1]) {
        throw new Error(
          `${where}: two module-exclusion gates ('${when.withoutModule}', ` +
            `'${withoutModule[1]}') gate one file - RenderWhen carries a single ` +
            "withoutModule; extend it to a list before stacking exclusions",
        );
      }
      when.withoutModule = withoutModule[1];
    } else {
      throw new Error(
        `${where}: filename gate '${gate}' has no client-side translation - the ` +
          "validator could not tell when the file renders; extend translateGates " +
          "(scripts/ownership/enforcement_tables.ts) alongside the new gate form",
      );
    }
  }
  return when;
}

/** The validator's base tables from templates/base/ownership.yml plus each base source's
 *  decoration and filename gates. Drift between the declarations and the base tree throws. */
export function baseOwnershipTables(templatesDir: string): {
  enforced: BaseOwnershipEntry[];
} {
  const where = "templates/base/ownership.yml";
  const declarations = loadBaseOwnership(templatesDir);
  const files = landedFiles(join(templatesDir, "base"));
  const declared = new Set(declarations.map((d) => d.path));
  for (const [path, { templateRel }] of files) {
    if (!declared.has(path)) {
      throw new Error(
        `templates/base/${templateRel}: lands at '${path}' with no ownership ` +
          `declaration - add the entry to ${where}`,
      );
    }
  }
  const enforced: BaseOwnershipEntry[] = [];
  for (const declaration of declarations) {
    const file = files.get(declaration.path);
    if (file === undefined) {
      throw new Error(
        `${where}: declares '${declaration.path}', but no templates/base/ file ` +
          "lands there - fix the path or delete the entry",
      );
    }
    const headerDrift = headerModeError(declaration, file.source, where);
    if (headerDrift !== null) throw new Error(headerDrift);
    const entry = enforcementOf(declaration);
    if (entry === null) continue;
    const when = translateGates(file.gates, `templates/base/${file.templateRel}`);
    enforced.push(when === undefined ? entry : { ...entry, when });
  }
  if (
    !enforced.some((entry) => entry.kind === "region") ||
    !enforced.some((entry) => entry.kind !== "region")
  ) {
    throw new Error(
      `${where}: the derived validator tables would miss a whole enforcement kind ` +
        "(no region split, or no header/class-only file) - the base tree always carries both",
    );
  }
  return { enforced };
}
