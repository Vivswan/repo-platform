// The docs' manifest-enumerating prose: the module rosters in README.md,
// docs/new-repo.md, and the skills, and the dependabot label groups the
// settings docs list.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { dependabotLabels } from "../compose/data_anchors.ts";
import { MODULE_ORDER, type ModuleManifest } from "../lib/module_manifests.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

// The docs regions below regenerate hand-written prose. Each region is a
// whole sentence (or sentence run), so the hand prose around it always
// reads on regardless of how the data rewraps.

/** The backticked module roster: `agents`, `bun`, ... */
function moduleRoster(manifests: ModuleManifest[]): string {
  return manifests.map((m) => `\`${m.module}\``).join(", ");
}

/** "bun" / "bun and npm" / "bun, npm, and yarn". */
function proseList(items: string[]): string {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** Modules whose follow-up copier questions have a dedicated docs/ guide;
 *  the new-repo roster sentence links each one. A module with parameters
 *  gets its guide listed here when the guide lands. */
export const MODULE_PARAM_DOCS: Record<string, string> = {
  pages: "pages.md",
  "docs-site": "docs-site.md",
  fuzzer: "fuzzer.md",
  nightly: "nightly.md",
  skills: "skills.md",
};

/** The `[docs/<file>](<file>)` links for MODULE_PARAM_DOCS, in MODULE_ORDER,
 *  each key checked against the module roster and each guide against disk
 *  so a renamed module or doc fails the generator instead of emitting a
 *  dead link. */
function paramDocLinks(): string[] {
  const links: string[] = [];
  for (const module of Object.keys(MODULE_PARAM_DOCS)) {
    if (!MODULE_ORDER.includes(module)) {
      throw new Error(
        `MODULE_PARAM_DOCS names '${module}', which is not in MODULE_ORDER - ` +
          "fix the key in scripts/generate/doc_rosters.ts",
      );
    }
  }
  for (const module of MODULE_ORDER) {
    const doc = MODULE_PARAM_DOCS[module];
    if (doc === undefined) continue;
    if (!existsSync(join(REPO_ROOT, "docs", doc))) {
      throw new Error(
        `MODULE_PARAM_DOCS maps '${module}' to docs/${doc}, which does not exist - ` +
          "fix the mapping in scripts/generate/doc_rosters.ts or restore the guide",
      );
    }
    links.push(`[docs/${doc}](${doc})`);
  }
  return links;
}

/** README.md "Modules": the roster bullet (the BEGIN marker
 *  rides on the section heading, so the span opens with the blank line
 *  separating them). */
export function readmeModuleRoster(manifests: ModuleManifest[]): string[] {
  return [
    "",
    `- Modules (pick any combination): ${moduleRoster(manifests)}. ` +
      "Modules with parameters (like `pages`) ask follow-up questions only when " +
      "selected. After generation, module selection lives in each repo's own " +
      "`.repo-platform.yml`: edit its `modules:` list and the next sync applies " +
      "the change.",
  ];
}

/** docs/new-repo.md: the sentence run from the `modules` multiselect
 *  through "and visibility." (the roster's own sentence). Single-line:
 *  it continues the BEGIN marker's sentence in place. */
export function newRepoModuleRoster(manifests: ModuleManifest[]): string {
  return (
    ` multiselect (any combination of ${moduleRoster(manifests)}), follow-up ` +
    `parameters for modules that have them (see ${proseList(paramDocLinks())}), ` +
    "and visibility."
  );
}

/** skills/repo-platform-add-module/SKILL.md "The module roster": one
 *  table row per module, the manifest description verbatim (the BEGIN
 *  marker ends the table's separator row). */
export function skillModuleRosterRows(manifests: ModuleManifest[]): string[] {
  return manifests.map((m) => `| \`${m.module}\` | ${m.description} |`);
}

/** skills/repo-platform-new-project/references/questions.md "Module
 *  roster": the blank line after the marker's sentence, then one bullet
 *  per module with the manifest description verbatim. */
export function skillModuleRosterBullets(manifests: ModuleManifest[]): string[] {
  return ["", ...manifests.map((m) => `- \`${m.module}\`: ${m.description}`)];
}

export interface DependabotLabelGroup {
  label: string;
  color: string;
  ecosystems: string[];
}

/** The dependabot labels the settings docs enumerate: the composer's
 *  dependabotLabels owns the dedup-by-label grouping (MODULE_ORDER of
 *  first contributor); this only re-shapes each group into the docs'
 *  label/color/ecosystems view, each group listing its contributing
 *  ecosystems once, in manifest order. */
export function dependabotLabelGroups(manifests: ModuleManifest[]): DependabotLabelGroup[] {
  const ecosystemOf = new Map(
    manifests.flatMap((m) => (m.dependabot ? [[m.module, m.dependabot.ecosystem] as const] : [])),
  );
  const groups = dependabotLabels(manifests).map((label) => ({
    label: label.name,
    color: label.color,
    ecosystems: [
      ...new Set(
        label.modules.map((module) => {
          const ecosystem = ecosystemOf.get(module);
          if (ecosystem === undefined) {
            // Unreachable: every module in a label group declared dependabot.
            throw new Error(`no dependabot ecosystem recorded for module '${module}'`);
          }
          return ecosystem;
        }),
      ),
    ],
  }));
  if (groups.length === 0) {
    throw new Error(
      "no manifest declares a dependabot entry, so the docs' per-toolchain " +
        "label lists would be empty - declare dependabot: {ecosystem, label, " +
        "color} in at least one module.yml",
    );
  }
  return groups;
}

/** `javascript` (`168700`) for bun, `python:uv` (`2b67c6`) for uv, ... */
function dependabotLabelList(manifests: ModuleManifest[]): string {
  return dependabotLabelGroups(manifests)
    .map((g) => `\`${g.label}\` (\`${g.color}\`) for ${proseList(g.ecosystems)}`)
    .join(", ");
}

/** docs/new-repo.md and docs/settings.md: the per-toolchain dependabot
 *  labels a settings file must declare. Single-line: it continues the
 *  BEGIN marker's sentence in place. */
export function dependabotLabelsSpan(manifests: ModuleManifest[]): string {
  return ` ${dependabotLabelList(manifests)}.`;
}
