// The validator's ownership.ts record literals (KNOWN_MODULES,
// MODULE_OWNERSHIP, BASE_OWNERSHIP) laid out the way biome's formatter
// prints them; TOOLCHAIN_PINS renders beside the pins in toolchain_pins.ts.

import type { ModuleManifest } from "../lib/module_manifests.ts";
import type { BaseOwnershipEntry, OwnershipEntry } from "../ownership/enforcement_tables.ts";

/** validate-template ownership.ts KNOWN_MODULES set literal. */
export function knownModules(manifests: ModuleManifest[]): string[] {
  return [
    "export const KNOWN_MODULES: ReadonlySet<string> = new Set([",
    ...manifests.map((m) => `  "${m.module}",`),
    "]);",
  ];
}

/** One object literal, laid out the way biome's formatter (lineWidth 100)
 *  prints it: inline while the whole line fits, otherwise one property per
 *  line. Throws when even a single property line cannot fit - regeneration
 *  and formatting must never disagree. */
function objectLiteralLines(fields: string[], indent: string, suffix: string): string[] {
  const inline = `${indent}{ ${fields.join(", ")} }${suffix}`;
  if (inline.length <= 100) return [inline];
  const lines = [`${indent}{`];
  for (const field of fields) {
    const line = `${indent}  ${field},`;
    if (line.length > 100) {
      throw new Error(
        `ownership table entry property exceeds the formatter's line width ` +
          `(${field}) - shorten the rendered path or marker`,
      );
    }
    lines.push(line);
  }
  lines.push(`${indent}}${suffix}`);
  return lines;
}

/** An ownership table entry's property list, in the emitted field order. */
function ownedFileFields(entry: BaseOwnershipEntry): string[] {
  const fields = [`path: ${JSON.stringify(entry.path)}`, `kind: "${entry.kind}"`];
  if (entry.kind === "region") {
    fields.push(`begin: ${JSON.stringify(entry.begin)}`, `end: ${JSON.stringify(entry.end)}`);
  }
  if (entry.when !== undefined) {
    const when: string[] = [];
    if (entry.when.publicOnly) when.push("publicOnly: true");
    if (entry.when.withoutModule !== undefined) {
      when.push(`withoutModule: ${JSON.stringify(entry.when.withoutModule)}`);
    }
    fields.push(`when: { ${when.join(", ")} }`);
  }
  return fields;
}

/** validate-template ownership.ts MODULE_OWNERSHIP record literal, sourced
 *  from the module.yml ownership declarations (moduleOwnershipEntries) and
 *  laid out the way biome's formatter prints it. */
export function moduleOwnershipRegion(ownership: Record<string, OwnershipEntry[]>): string[] {
  // References the hand-written OwnedFile union above the region: inlining
  // it would push the line past the formatter's width.
  const lines = [
    "export const MODULE_OWNERSHIP: Readonly<Partial<Record<string, readonly OwnedFile[]>>> = {",
  ];
  for (const [module, entries] of Object.entries(ownership)) {
    // Keys quoted as-needed, like TOOLCHAIN_PINS (toolchain_pins.ts), to stay biome-stable.
    const key = /^[a-z][a-z0-9]*$/.test(module) ? module : JSON.stringify(module);
    const literals = entries.map((entry) => `{ ${ownedFileFields(entry).join(", ")} }`);
    const inline = `  ${key}: [${literals.join(", ")}],`;
    if (inline.length <= 100) {
      lines.push(inline);
      continue;
    }
    lines.push(`  ${key}: [`);
    for (const entry of entries) {
      lines.push(...objectLiteralLines(ownedFileFields(entry), "    ", ","));
    }
    lines.push("  ],");
  }
  lines.push("};");
  return lines;
}

/** validate-template ownership.ts BASE_OWNERSHIP literal, sourced from
 *  templates/base/ownership.yml (baseOwnershipTables): the enforced base
 *  files - header, class-only, and region-split entries - with their
 *  render conditions. */
export function baseOwnershipRegion(tables: { enforced: BaseOwnershipEntry[] }): string[] {
  const lines = ["export const BASE_OWNERSHIP: readonly BaseOwnedFile[] = ["];
  for (const entry of tables.enforced) {
    lines.push(...objectLiteralLines(ownedFileFields(entry), "  ", ","));
  }
  lines.push("];");
  return lines;
}
