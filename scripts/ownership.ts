#!/usr/bin/env bun
// The single owner of template-file OWNERSHIP truth: how each file the
// template lands in a generated repository relates to sync.
//
// Three classes (the ownership manifest's vocabulary):
// - managed: sync overwrites the whole file; local edits are replaced.
// - split: sync owns one half (a marker line separates it from the
//   repo-owned half); local content lives in the other half.
// - starter: rendered once, repo-owned from then on (_skip_if_exists,
//   plus the policy-listed repo-owned renders in
//   KNOWN_UNDECLARED_MODULE_FILES).
//
// Consumers, all reading the same classifier so ownership can never fork:
// - scripts/generate.ts derives validate-template's MODULE_OWNERSHIP
//   record (moduleOwnershipFiles below) and enforces that every module
//   template declares its ownership.
// - scripts/compose_template.ts emits the ownership manifest
//   (.repo-platform-manifest.json) into the composed template tree.
//
// generate.ts re-exports everything here, so importers keyed on the
// generator keep resolving.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ModuleManifest } from "./module_manifests.ts";

/** The managed ownership header in template sources, anchored on the C1
 *  line's canonical trailing period with no repo-name character (GitHub
 *  allows [A-Za-z0-9._-]) after it, so neither a negated look-alike ("is
 *  not managed by") nor a longer repo name ("/repo-platform_fork",
 *  "/repo-platform.fork") counts; validate_generated_files.ts applies the
 *  same anchoring to rendered files. */
export const MANAGED_HEADER_RE =
  /This file is managed by \{\{ github_username \}\}\/repo-platform\.(?![A-Za-z0-9._-])/;

export const LOCAL_SECTION_MARKER = "repo-platform:local-section";
export const LOCAL_SECTION_LINES = new Set([
  `# ${LOCAL_SECTION_MARKER}`,
  `<!-- ${LOCAL_SECTION_MARKER} -->`,
]);

/** How many opening lines may hold the managed header: template sources
 *  keep it at the top, at most below a short jinja preamble that rendering
 *  collapses. The validator's rendered-file check uses the same window. */
export const HEADER_WINDOW = 10;

/** Module template files that declare no ownership today, tolerated without
 *  enrolment so the undeclared-file throw below stays fail-closed for
 *  everything new. An entry whose file gains a declaration (or disappears)
 *  throws as stale, so the list can only shrink. The ownership manifest
 *  lists these as starters: they are repo-owned after the first render
 *  (settings.yml is the three-way-merged file the sync never deletes), so
 *  sync makes no byte-parity promise about their content. */
export const KNOWN_UNDECLARED_MODULE_FILES = new Set([
  // States which operator applies the settings but not that sync owns the
  // file; enrols by opening with the managed header.
  "settings-sync/.github/settings.yml.jinja",
]);

/** Split base files whose marker grammar predates the local-section
 *  sentinel. .gitignore's REPOSITORY LOCAL section sits ABOVE its managed
 *  section (last-match-wins makes managed patterns non-overridable), so
 *  its managed half runs from the BEGIN marker line to end of file. */
const BASE_SPLIT_FILES: Record<string, { marker: string; managed: "above" | "below" }> = {
  ".gitignore": { marker: "# BEGIN REPO-PLATFORM MANAGED", managed: "below" },
};

/** copier.yml's _skip_if_exists globs as path matchers reproducing
 *  copier's gitignore-style semantics (pathspec gitwildmatch): a pattern
 *  containing "/" is anchored to the render root, a bare filename matches
 *  at any depth, and `*` stays within one component. Only that subset is
 *  implemented; a pattern using more (`**`, `?`, character classes,
 *  negation, edge slashes, and gitwildmatch's comment/whitespace line
 *  forms) throws rather than guessing what copier does. */
export function skipIfExistsMatchers(copierYamlText: string): RegExp[] {
  const skip = (parseYaml(copierYamlText) as { _skip_if_exists?: unknown } | null)?._skip_if_exists;
  if (!Array.isArray(skip) || skip.length === 0 || !skip.every((p) => typeof p === "string")) {
    throw new Error(
      "copier.yml: _skip_if_exists is missing or not a list of strings - the " +
        "module-ownership scan needs it to keep repo-owned starters exempt",
    );
  }
  return skip.map((pattern) => {
    if (
      /[?[\]\\!]/.test(pattern) ||
      pattern.includes("**") ||
      pattern.startsWith("/") ||
      pattern.endsWith("/") ||
      pattern.startsWith("#") ||
      pattern.trim() !== pattern ||
      pattern === ""
    ) {
      throw new Error(
        `copier.yml: _skip_if_exists pattern '${pattern}' uses gitwildmatch ` +
          "features beyond the implemented subset (bare names, root-anchored " +
          "paths, single *) - extend skipIfExistsMatchers alongside it",
      );
    }
    const body = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*");
    // A gitwildmatch pattern that matches a directory also covers every
    // descendant, hence the optional /... tail.
    const tail = "(?:/.*)?$";
    return new RegExp(pattern.includes("/") ? `^${body}${tail}` : `(?:^|/)${body}${tail}`);
  });
}

const FILENAME_GATE_RE = /^\{% if (.+?) %\}(.*)\{% endif %\}$/;

/** The path a render lands, with any filename gates stripped and their
 *  conditions collected (in path order). Input is the rendered path (the
 *  .jinja suffix already removed). */
export function landedPathAndGates(renderedPath: string): { path: string; gates: string[] } {
  const gates: string[] = [];
  const path = renderedPath
    .split("/")
    .map((segment) => {
      const match = FILENAME_GATE_RE.exec(segment);
      if (!match) return segment;
      gates.push(match[1]);
      return match[2];
    })
    .join("/");
  return { path, gates };
}

export type ManifestOwnership =
  | { class: "managed" }
  | { class: "starter" }
  | { class: "split"; marker: string; managed: "above" | "below" };

/** Classify one template source file by landed path and source text:
 *  starter (exempt via _skip_if_exists; carrying the managed header there
 *  throws, the two promises contradict), split (a marker line separates
 *  the sync-owned half from the repo-owned half - the local-section
 *  sentinel, or a BASE_SPLIT_FILES grammar), or managed (everything else:
 *  sync overwrites the whole file whether or not it can carry the header).
 *  `where` names the source file in errors. */
export function classifyTemplateSource(
  landedPath: string,
  source: string,
  skipIfExists: RegExp[],
  where: string,
): { ownership: ManifestOwnership; hasHeader: boolean } {
  const hasHeader = MANAGED_HEADER_RE.test(source.split("\n", HEADER_WINDOW).join("\n"));
  if (skipIfExists.some((matcher) => matcher.test(landedPath))) {
    if (hasHeader) {
      throw new Error(
        `${where}: opens with the managed header but ` +
          "renders a _skip_if_exists starter - the header promises sync " +
          "overwrites the file, the skip list promises it never does; drop one",
      );
    }
    return { ownership: { class: "starter" }, hasHeader };
  }
  const baseSplit = BASE_SPLIT_FILES[landedPath];
  if (baseSplit) {
    if (!source.split("\n").some((line) => line.trim() === baseSplit.marker)) {
      throw new Error(
        `${where}: lands at ${landedPath}, whose split grammar expects the ` +
          `'${baseSplit.marker}' line, but the source does not carry it - ` +
          "restore the marker or update BASE_SPLIT_FILES (scripts/ownership.ts)",
      );
    }
    return { ownership: { class: "split", ...baseSplit }, hasHeader };
  }
  const markerLine = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => LOCAL_SECTION_LINES.has(line));
  if (markerLine !== undefined) {
    return { ownership: { class: "split", marker: markerLine, managed: "above" }, hasHeader };
  }
  return { ownership: { class: "managed" }, hasHeader };
}

export interface OwnershipEntry {
  path: string;
  kind: "header" | "marker";
}

/** The rendered paths, per module, whose ownership declaration the
 *  validator enforces while the module is selected. Every module template
 *  file (fragments and symlinks aside) is classified via
 *  classifyTemplateSource - starter, split ("marker"), header-opening
 *  ("header"), or comment-free (the manifest's pin dotfile, JSON) - and a
 *  file fitting no class throws, so nothing lands silently undeclared.
 *  Filename-gated files only declare: module selection alone does not
 *  render them. */
export function moduleOwnershipFiles(
  manifests: ModuleManifest[],
  templatesDir: string,
  skipIfExists: RegExp[],
  knownUndeclared: ReadonlySet<string> = KNOWN_UNDECLARED_MODULE_FILES,
): Record<string, OwnershipEntry[]> {
  const result: Record<string, OwnershipEntry[]> = {};
  const unusedSilences = new Set(knownUndeclared);
  for (const m of manifests) {
    const moduleDir = join(templatesDir, m.module);
    const entries: OwnershipEntry[] = [];
    const visit = (rel: string) => {
      for (const name of readdirSync(join(moduleDir, rel)).sort()) {
        const childRel = rel ? `${rel}/${name}` : name;
        if (childRel === "fragments" || childRel === "module.yml") continue;
        const stat = lstatSync(join(moduleDir, childRel));
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          visit(childRel);
          continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const renderedPath = childRel.replace(/\.jinja$/, "");
        const { path: landedPath } = landedPathAndGates(renderedPath);
        const ungated = landedPath === renderedPath;
        const source = readFileSync(join(moduleDir, childRel), "utf-8");
        const { ownership, hasHeader } = classifyTemplateSource(
          landedPath,
          source,
          skipIfExists,
          `templates/${m.module}/${childRel}`,
        );
        if (ownership.class === "starter") continue;
        if (ownership.class === "split") {
          if (ungated) entries.push({ path: landedPath, kind: "marker" });
          continue;
        }
        if (hasHeader) {
          if (ungated) entries.push({ path: landedPath, kind: "header" });
          continue;
        }
        if (landedPath === m.toolchain?.pin?.file || landedPath.endsWith(".json")) continue;
        if (unusedSilences.delete(`${m.module}/${childRel}`)) continue;
        throw new Error(
          `templates/${m.module}/${childRel}: declares no ownership - open it with ` +
            "the managed header, split it with the local-section marker line, list " +
            "its rendered path in _skip_if_exists, or record the silence in " +
            "KNOWN_UNDECLARED_MODULE_FILES (scripts/ownership.ts)",
        );
      }
    };
    visit("");
    if (entries.length > 0) result[m.module] = entries;
  }
  if (unusedSilences.size > 0) {
    throw new Error(
      `KNOWN_UNDECLARED_MODULE_FILES entr${unusedSilences.size === 1 ? "y" : "ies"} ` +
        `${[...unusedSilences].join(", ")} matched no undeclared file - the file ` +
        "gained a declaration or moved; remove the stale entry",
    );
  }
  if (Object.keys(result).length === 0) {
    throw new Error(
      "no module template declares ownership, so the validator's " +
        "MODULE_OWNERSHIP record would be empty - the managed module " +
        "workflows are expected to carry the header",
    );
  }
  return result;
}
