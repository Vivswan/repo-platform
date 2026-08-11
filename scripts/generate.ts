#!/usr/bin/env bun
// Umbrella generator for the marker-fenced GENERATED regions derived from
// the module manifests (templates/<module>/module.yml, loaded by
// scripts/module_manifests.ts):
//
// - copier.yml: the modules question's choices block, the has_toolchain
//   default expression, the pages_setup default + validator, and the
//   pages_install_command / pages_build_command default chains.
// - actions/validate-template/validate_generated_files.ts: the
//   KNOWN_MODULES set literal (the action stays self-contained for
//   client-side execution; only the constant's authorship is generated).
//
// The .gitignore outputs are NOT owned here: scripts/build_gitignore.ts
// has its own upstream-lock fetch/check cycle (bun run gitignore:check).
//
// A region is the lines strictly between its BEGIN/END marker comments;
// the markers themselves are hand-placed once and never rewritten. Editing
// a region by hand is drift: --check fails CI until it is regenerated.
// Every target's output is computed before anything is written, so a
// broken marker in one file never leaves another half-updated.
//
// Usage:
//   bun scripts/generate.ts           # rewrite every generated region
//   bun scripts/generate.ts --check   # exit 1 if any region is stale

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadManifests, type ModuleManifest } from "./module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The BEGIN/END marker comment lines fencing a generated region. */
export function markerLines(name: string, comment: string): { begin: string; end: string } {
  return {
    begin: `${comment} BEGIN GENERATED: ${name} (scripts/generate.ts - edit module.yml manifests, not this block)`,
    end: `${comment} END GENERATED: ${name}`,
  };
}

/** Replace the lines strictly between a region's markers with `body`.
 *  Markers are matched by trimmed content (they may be indented) and kept
 *  verbatim; a missing, duplicated, or misordered marker throws. */
export function spliceRegion(
  text: string,
  file: string,
  name: string,
  comment: string,
  body: string[],
): string {
  const { begin, end } = markerLines(name, comment);
  const lines = text.split("\n");
  const at = (marker: string) =>
    lines.flatMap((line, index) => (line.trim() === marker ? [index] : []));
  const begins = at(begin);
  const ends = at(end);
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `${file}: region '${name}' needs exactly one BEGIN and one END marker, ` +
        `found ${begins.length} and ${ends.length} - restore the marker pair`,
    );
  }
  if (ends[0] < begins[0]) {
    throw new Error(`${file}: region '${name}' has its END marker before BEGIN - swap them`);
  }
  return [...lines.slice(0, begins[0] + 1), ...body, ...lines.slice(ends[0])].join("\n");
}

// --- region bodies ----------------------------------------------------------
// Each returns full lines, indentation included, matching the target file's
// surrounding layout.

/** copier.yml `modules` question: the choices block. */
export function moduleChoices(manifests: ModuleManifest[]): string[] {
  return ["  choices:", ...manifests.map((m) => `    ${m.module} - ${m.description}: ${m.module}`)];
}

/** copier.yml `has_toolchain`: or-chain over the toolchain manifests. */
export function hasToolchainDefault(manifests: ModuleManifest[]): string[] {
  const chain = manifests
    .filter((m) => m.toolchain !== undefined)
    .map((m) => `'${m.module}' in modules`)
    .join(" or ");
  if (chain === "") {
    throw new Error(
      "no manifest declares a toolchain, so copier.yml's has_toolchain " +
        "default would be empty - declare toolchain: {codeql_language: ...} " +
        "in at least one module.yml",
    );
  }
  return [`  default: "{{ ${chain} }}"`];
}

export type PagesManifest = ModuleManifest & { pages: NonNullable<ModuleManifest["pages"]> };

/** The manifests declaring Pages commands, filtered once for the three
 *  pages_* region builders. */
export function pagesManifests(manifests: ModuleManifest[]): PagesManifest[] {
  const withPages = manifests.filter((m): m is PagesManifest => m.pages !== undefined);
  if (withPages.length === 0) {
    throw new Error(
      "no manifest declares pages commands, so copier.yml's pages_setup and " +
        "pages_*_command defaults would offer no toolchains - declare " +
        "pages: {install, build} in at least one module.yml",
    );
  }
  return withPages;
}

/** copier.yml `pages_setup`: default expression + validator token list. */
export function pagesSetup(withPages: PagesManifest[]): string[] {
  const defaultExpr = withPages
    .map((m) => `(['${m.module}'] if '${m.module}' in modules else [])`)
    .join(" + ");
  const names = withPages.map((m) => m.module);
  const tokenList = [...names, "none"].map((t) => `'${t}'`).join(", ");
  const tokenProse = names.length === 1 ? `${names[0]} or none` : `${names.join(", ")}, or none`;
  return [
    `  default: "{{ (${defaultExpr}) | join(',') or 'none' }}"`,
    `  validator: "{% set ts = pages_setup.split(',') %}{% if '' in ts or ts | map('trim') | list != ts %}pages_setup must be comma-separated with no spaces or empty tokens{% elif ts | reject('in', [${tokenList}]) | list %}pages_setup tokens must be ${tokenProse}{% elif ts | unique | list | length != ts | length %}pages_setup tokens must be unique{% elif 'none' in ts and ts | length > 1 %}pages_setup 'none' cannot be combined with toolchains{% endif %}"`,
  ];
}

/** The nested `'<cmd>' if '<module>' in pages_setup.split(',') else (...)`
 *  chain for a per-toolchain pages command, ending in ''. */
function pagesCommandChain(
  withPages: PagesManifest[],
  command: (pages: PagesManifest["pages"]) => string,
): string[] {
  let chain = "''";
  for (const m of [...withPages].reverse()) {
    const alternative = chain === "''" ? "''" : `(${chain})`;
    chain = `'${command(m.pages)}' if '${m.module}' in pages_setup.split(',') else ${alternative}`;
  }
  return [`  default: "{{ ${chain} }}"`];
}

/** copier.yml `pages_install_command` default chain. */
export function pagesInstallCommand(withPages: PagesManifest[]): string[] {
  return pagesCommandChain(withPages, (pages) => pages.install);
}

/** copier.yml `pages_build_command` default chain. */
export function pagesBuildCommand(withPages: PagesManifest[]): string[] {
  return pagesCommandChain(withPages, (pages) => pages.build);
}

/** validate_generated_files.ts KNOWN_MODULES set literal. */
export function knownModules(manifests: ModuleManifest[]): string[] {
  return ["const KNOWN_MODULES = new Set([", ...manifests.map((m) => `  "${m.module}",`), "]);"];
}

// --- targets ------------------------------------------------------------------

interface RegionInputs {
  manifests: ModuleManifest[];
  pages: PagesManifest[];
}

interface Target {
  file: string;
  comment: string;
  regions: [name: string, body: (inputs: RegionInputs) => string[]][];
}

const TARGETS: Target[] = [
  {
    file: "copier.yml",
    comment: "#",
    regions: [
      ["module-choices", ({ manifests }) => moduleChoices(manifests)],
      ["has-toolchain-default", ({ manifests }) => hasToolchainDefault(manifests)],
      ["pages-setup", ({ pages }) => pagesSetup(pages)],
      ["pages-install-command", ({ pages }) => pagesInstallCommand(pages)],
      ["pages-build-command", ({ pages }) => pagesBuildCommand(pages)],
    ],
  },
  {
    file: "actions/validate-template/validate_generated_files.ts",
    comment: "//",
    regions: [["known-modules", ({ manifests }) => knownModules(manifests)]],
  },
];

function main(): number {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length > 0) {
    console.error(`error: unrecognized argument(s): ${unknown.join(" ")}`);
    return 2;
  }

  // Compute every output before writing anything: a bad manifest or a
  // broken marker aborts cleanly instead of leaving a target half-updated.
  let changed: { path: string; file: string; next: string }[];
  try {
    const manifests = loadManifests();
    const inputs: RegionInputs = { manifests, pages: pagesManifests(manifests) };
    changed = TARGETS.flatMap((target) => {
      const path = join(REPO_ROOT, target.file);
      const current = readFileSync(path, "utf-8");
      let next = current;
      for (const [name, body] of target.regions) {
        next = spliceRegion(next, target.file, name, target.comment, body(inputs));
      }
      return next === current ? [] : [{ path, file: target.file, next }];
    });
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (check) {
    for (const { file } of changed) {
      console.log(
        `${file} is stale: its generated region(s) do not match the module ` +
          "manifests; run bun run generate to rewrite them",
      );
    }
    if (changed.length > 0) return 1;
    console.log("generated regions are up to date");
    return 0;
  }
  for (const { path, file, next } of changed) {
    writeFileSync(path, next);
    console.log(`rewrote ${file}'s generated region(s) from the module manifests`);
  }
  if (changed.length === 0) {
    console.log("generated regions already match the module manifests; nothing to write");
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
