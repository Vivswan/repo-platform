// The ownership manifest: every landed path with its declared class and
// render gates (manifestEntries) and the jinja template that renders it
// (manifestTemplate).

import { entryLine, MANIFEST_NAME as MANIFEST_LANDED_PATH } from "../../actions/shared/manifest.ts";
import {
  declarationTextErrors,
  declaredMarkerTexts,
  landedPathAndGates,
  type ManifestOwnership,
  type OwnershipDeclaration,
  ownershipOf,
} from "../ownership.ts";
import { JINJA_SUFFIX, type SourcedEntry } from "./entries.ts";
import { allOf } from "./exclude.ts";
import { sortedByKey, sourceName } from "./splice.ts";

/** The manifest's emitted template name in the composed tree
 *  (MANIFEST_LANDED_PATH, aliased from the shared module's MANIFEST_NAME,
 *  is where it lands in generated repositories). */
export const MANIFEST_TEMPLATE_PATH = `${MANIFEST_LANDED_PATH}${JINJA_SUFFIX}`;

export interface ManifestEntry {
  path: string;
  /** Jinja conditions gating the render (the module gate and/or filename
   *  gates); the entry appears in a rendered manifest only while all hold. */
  gates: string[];
  ownership: ManifestOwnership;
}

/** Where a path's ownership is declared: templates/base/ownership.yml for
 *  base files, the module.yml `ownership:` list for module files. */
export interface DeclarationSources {
  base: OwnershipDeclaration[];
  /** module -> declarations, in MODULE_ORDER. */
  modules: Map<string, OwnershipDeclaration[]>;
}

/** The full ownership map for the composed tree: every landed path with
 *  its DECLARED class and its render gates, plus the manifest's own
 *  self-entry, sorted by path. Errors on: a landed file with no
 *  declaration, a declaration whose path never lands, same-path
 *  declarations disagreeing across sources, dead _skip_if_exists patterns,
 *  starter/skip disagreement, symlinks declared anything but managed
 *  (sync re-renders links whole), and source text contradicting the
 *  declared class (declarationTextErrors). Called after
 *  spliceContributions, so the decoration checks read the final template
 *  text, fragments included. */
export function manifestEntries(
  files: Map<string, SourcedEntry>,
  skipPatterns: { pattern: string; matcher: RegExp }[],
  declarations: DeclarationSources,
): { entries: ManifestEntry[]; errors: string[] } {
  const errors: string[] = [];
  interface Home {
    name: string;
    tree: string;
    lookup: Map<string, OwnershipDeclaration>;
    used: Set<string>;
  }
  const homes = new Map<string, Home>();
  const declaredBy = new Map<string, { name: string; ownership: ManifestOwnership }[]>();
  const register = (key: string, name: string, tree: string, list: OwnershipDeclaration[]) => {
    homes.set(key, { name, tree, lookup: new Map(list.map((d) => [d.path, d])), used: new Set() });
    for (const declaration of list) {
      const prior = declaredBy.get(declaration.path) ?? [];
      prior.push({ name, ownership: ownershipOf(declaration) });
      declaredBy.set(declaration.path, prior);
    }
  };
  register("base", "templates/base/ownership.yml", "templates/base/", declarations.base);
  for (const [module, list] of declarations.modules) {
    register(module, `templates/${module}/module.yml`, `templates/${module}/`, list);
  }
  // The managed/starter contradiction scan checks against EVERY declared
  // grammar's markers, base and module declarations alike.
  // declarationTextErrors unions the shipped constants in, so the scan
  // survives a tree whose only split declaration flips to managed -
  // deriving from current declarations alone would empty the set on
  // exactly that flip and disarm the check.
  const allDeclarations = [...declarations.base, ...[...declarations.modules.values()].flat()];
  const declaredMarkers = declaredMarkerTexts(allDeclarations);
  for (const [path, list] of declaredBy) {
    const first = JSON.stringify(list[0].ownership);
    const dissenter = list.find(({ ownership }) => JSON.stringify(ownership) !== first);
    if (dissenter) {
      errors.push(
        `ownership: ${list[0].name} and ${dissenter.name} both declare '${path}' ` +
          "but disagree on its ownership - one path has one class; reconcile the declarations",
      );
    }
  }

  const byPath = new Map<string, ManifestEntry & { source: string }>();
  const add = (entry: ManifestEntry, source: string) => {
    const existing = byPath.get(entry.path);
    if (existing) {
      errors.push(
        `manifest: ${existing.source} and ${source} both land at ${entry.path} ` +
          "under disjoint gates - a co-selected render would emit duplicate " +
          "manifest keys; consolidate the sources",
      );
      return;
    }
    byPath.set(entry.path, { ...entry, source });
  };
  for (const [logical, sourced] of sortedByKey(files)) {
    const source = `templates/${sourceName(sourced)}/${logical}`;
    const rendered = logical.endsWith(JINJA_SUFFIX)
      ? logical.slice(0, -JINJA_SUFFIX.length)
      : logical;
    const { path, gates: nameGates } = landedPathAndGates(rendered);
    const gates = sourced.origin === "module" ? [sourced.gate, ...nameGates] : nameGates;
    const home = homes.get(sourced.origin === "base" ? "base" : sourced.module);
    const declaration = home?.lookup.get(path);
    if (home === undefined || declaration === undefined) {
      errors.push(
        `${source}: lands at ${path} with no ownership declaration - add the ` +
          `entry to ${home?.name ?? `templates/${sourceName(sourced)}/module.yml`}`,
      );
      continue;
    }
    home.used.add(path);
    const skipMatched = skipPatterns.some(({ matcher }) => matcher.test(path));
    if (sourced.entry.kind === "symlink") {
      if (declaration.class !== "managed") {
        errors.push(
          `${source}: is a symlink declared ${declaration.class} in ${home.name} - ` +
            "sync re-renders symlinks whole (parity hashes the link target), so " +
            "they are managed",
        );
      } else if (skipMatched) {
        errors.push(
          `${source}: is a managed symlink but copier.yml's _skip_if_exists ` +
            `matches '${path}' - declare it a starter or drop the skip entry`,
        );
      }
    } else {
      errors.push(
        ...declarationTextErrors(
          declaration,
          sourced.entry.data.toString("utf-8"),
          skipMatched,
          declaredMarkers,
          source,
        ),
      );
    }
    add({ path, gates, ownership: ownershipOf(declaration) }, source);
  }
  for (const home of homes.values()) {
    for (const path of home.lookup.keys()) {
      if (!home.used.has(path)) {
        errors.push(
          `${home.name}: ownership declares '${path}', but no ${home.tree} file ` +
            "lands there - fix the path or delete the entry",
        );
      }
    }
  }
  // Dead skip patterns: every _skip_if_exists entry must exempt at least
  // one landed path, or it is a leftover (or a typo for a moved starter).
  const landedPaths = [...byPath.keys()];
  for (const { pattern, matcher } of skipPatterns) {
    if (!landedPaths.some((path) => matcher.test(path))) {
      errors.push(
        `copier.yml: _skip_if_exists pattern '${pattern}' matches no landed ` +
          "template path - a dead entry keeps promising a starter that no " +
          "longer exists; remove or fix it",
      );
    }
  }
  // The manifest lists itself: it is a managed render like any other. Its
  // hash entry stays null forever - the content includes every other hash,
  // so a self-hash would be circular (stamping would change the very bytes
  // being hashed); parity of the other entries is what verifies sync state.
  add(
    { path: MANIFEST_LANDED_PATH, gates: [], ownership: { class: "managed" } },
    "the generated manifest itself",
  );
  const entries = [...byPath.values()]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map(({ source: _source, ...entry }) => entry);
  return { entries, errors };
}

/** The manifest's jinja template: gated `entries.append(...)` statements
 *  (the gitleaks-locks pattern) building one JSON entry line per selected
 *  path (the shared entryLine emitter - actions/shared/manifest.ts owns
 *  the line layout the stamper and every parser read back), joined with
 *  ',\n' so the render is valid JSON with no trailing comma. Every hash
 *  renders null; the post-render stamp hook (stamp_manifest.ts, wired in
 *  copier.yml's _tasks and _migrations) fills them in. */
export function manifestTemplate(entries: ManifestEntry[]): Buffer {
  const lines = ["{%- set entries = [] -%}"];
  for (const entry of entries) {
    const line = entryLine(entry.path, entry.ownership);
    if (line.includes("'")) {
      // The line rides inside a single-quoted jinja string literal.
      throw new Error(
        `manifest entry for ${entry.path} contains a single quote - it cannot ` +
          "be embedded in the manifest template's jinja string literals",
      );
    }
    const append = `{%- set _ = entries.append('${line}') -%}`;
    if (entry.gates.length === 0) {
      lines.push(append);
    } else {
      // allOf: the same conjunction the generated _exclude negates, so an
      // entry is listed exactly when its file lands.
      lines.push(`{%- if ${allOf(entry.gates)} -%}`, append, `{%- endif -%}`);
    }
  }
  const comment =
    "Generated by {{ github_username }}/repo-platform - do not edit. Every " +
    "template-landed path with its ownership class: managed (sync overwrites " +
    "the whole file; hash is sha256 of the last stamped content, or of the " +
    "symlink target), split (sync owns the BEGIN/END-bounded managed region " +
    "named by the entry's begin/end marker lines; the repository owns " +
    "everything outside it, above and below, and the hash covers the region " +
    "from the BEGIN line through the END line), starter (rendered once, " +
    "repo-owned; no hash). Hashes - and, on this file's own entry, the " +
    "render's _commit provenance - are stamped after each render by the " +
    "template's stamp_manifest.ts hook; this file's own hash stays null " +
    "because its content includes every other hash, so a self-hash would " +
    "be circular.";
  lines.push(
    "{",
    `  "$comment": ${JSON.stringify(comment)},`,
    '  "files": {',
    "{{ entries | join(',\\n') }}",
    "  }",
    "}",
    "",
  );
  return Buffer.from(lines.join("\n"));
}
