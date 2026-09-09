// Conditional landing: module gate expressions, the plain emitted paths
// the composed tree carries, filename validation, and copier.yml's
// generated _exclude patterns (the conjunction helper allOf is shared with
// the manifest template so selection and exclusion cannot drift apart).

import type { ModuleManifest } from "../lib/module_manifests.ts";
import { landedPathAndGates } from "../ownership/landed_paths.ts";
import { GeneratorValidationError } from "./data_anchors.ts";
import { JINJA_SUFFIX } from "./entries.ts";
import type { ManifestEntry } from "./manifest.ts";

/** A module's gate expression: its manifest override or plain membership.
 *  Exported so build_gitignore's cross-module guards negate the same
 *  expressions the composer gates with. */
export function gateExpression(module: string, manifest: ModuleManifest): string {
  return manifest.gate || `'${module}' in modules`;
}

/** The emitted template path for a source's logical path: any filename
 *  gates stripped (they are the gate DECLARATION, recorded as data), the
 *  .jinja suffix kept. The composed tree carries only plain names - a
 *  `uses:` ref downloads the whole build branch tarball and extraction
 *  dies on jinja-expression path segments. */
export function plainTemplatePath(logical: string): string {
  const jinja = logical.endsWith(JINJA_SUFFIX);
  const rendered = jinja ? logical.slice(0, -JINJA_SUFFIX.length) : logical;
  const { path } = landedPathAndGates(rendered);
  return jinja ? `${path}${JINJA_SUFFIX}` : path;
}

// --- conditional landing (the generated _exclude region) --------------------

/** A landed path as a LITERAL gitwildmatch pattern: glob metacharacters
 *  are backslash-escaped so a path containing one can never widen into a
 *  glob matching siblings, and a leading ! or # cannot negate or comment
 *  the pattern away. */
export function gitwildmatchLiteral(path: string): string {
  let out = path.replace(/[*?[\]\\]/g, (ch) => `\\${ch}`);
  if (/^[!#]/.test(out)) out = `\\${out}`;
  return out;
}

/** One gate expression for an entry's gate list: the single gate verbatim,
 *  several gates parenthesized and and-chained (a file renders only while
 *  ALL its gates hold). The one constructor for both consumers - the
 *  manifest template's entry gates and the generated _exclude conditions -
 *  so selection and exclusion can never drift apart. */
export function allOf(gates: string[]): string {
  return gates.length === 1 ? gates[0] : gates.map((gate) => `(${gate})`).join(" and ");
}

/** Fail-closed filename validation for a source's logical path, after the
 *  recognized `{% if %}NAME{% endif %}` gates are stripped. Leftover jinja
 *  syntax would ship verbatim on the build branch while copier renders a
 *  DIFFERENT destination than the manifest records; a gate's inner name
 *  ending in .jinja would land suffix-stripped, diverging the same way; and
 *  a LANDED segment with edge whitespace could never be excluded literally,
 *  since pathspec strips trailing whitespace from gitwildmatch patterns. */
export function templatePathErrors(logical: string): string[] {
  const errors: string[] = [];
  const emitted = plainTemplatePath(logical);
  for (const delimiter of ["{%", "{{", "{#", "%}", "}}", "#}"]) {
    if (emitted.includes(delimiter)) {
      errors.push(
        `'${logical}' carries jinja syntax ('${delimiter}') the composer cannot ` +
          "strip - only {% if <gate> %}NAME{% endif %} filename gates are " +
          "recognized; rename the file",
      );
      break;
    }
  }
  const rendered = logical.endsWith(JINJA_SUFFIX)
    ? logical.slice(0, -JINJA_SUFFIX.length)
    : logical;
  for (const segment of rendered.split("/")) {
    const match = /^\{% if .+? %\}(.*)\{% endif %\}$/.exec(segment);
    if (match?.[1].endsWith(JINJA_SUFFIX)) {
      errors.push(
        `'${logical}' wraps a ${JINJA_SUFFIX} suffix inside its filename gate - ` +
          "the suffix goes OUTSIDE the gate ({% if ... %}NAME{% endif %}" +
          `${JINJA_SUFFIX}), or copier would land the emitted plain name ` +
          "suffix-stripped while the manifest records it with the suffix",
      );
    }
  }
  // Checked on the LANDED name (suffix stripped): 'foo .jinja' has clean
  // emitted segments but lands as 'foo ', which pathspec's trailing-
  // whitespace stripping could never match literally.
  const landed = emitted.endsWith(JINJA_SUFFIX) ? emitted.slice(0, -JINJA_SUFFIX.length) : emitted;
  for (const segment of landed.split("/")) {
    if (segment !== segment.trim()) {
      errors.push(
        `'${logical}' lands with a path segment carrying leading or trailing ` +
          "whitespace - pathspec strips trailing whitespace from gitwildmatch " +
          "patterns, so the generated _exclude could never match it literally; " +
          "rename the file",
      );
      break;
    }
  }
  return errors;
}

/** A pattern anchored to the render root: gitwildmatch treats a pattern
 *  containing a slash as root-anchored, so single-segment paths get a
 *  leading slash - an unanchored "AGENTS.md" would match at any depth. */
function anchored(pattern: string): string {
  return pattern.includes("/") ? pattern : `/${pattern}`;
}

/** The copier.yml _exclude patterns realizing conditional landing over the
 *  plain-named composed tree, from the same entries the ownership manifest
 *  is generated from: per gated FILE a pattern rendering to the literal
 *  landed path exactly when its gates do not hold, and per DIRECTORY whose
 *  every landed file is gated a pattern for the directory itself (copier
 *  would otherwise render it empty; a gitwildmatch directory pattern also
 *  covers descendants, so the per-file ones underneath are belt and braces).
 *  scripts/generate.ts writes these into copier.yml; build() refuses a stale region. */
export function excludePatterns(entries: ManifestEntry[]): string[] {
  const patterns: string[] = [];
  for (const entry of entries) {
    if (entry.gates.length === 0) continue;
    for (const [what, bad] of [
      ["a double quote", '"'],
      ["a backslash", "\\"],
      ["a jinja expression delimiter", "{{"],
      ["a jinja statement delimiter", "{%"],
    ] as const) {
      if (entry.path.includes(bad)) {
        throw new GeneratorValidationError(
          `landed path '${entry.path}' contains ${what} - it cannot ride inside ` +
            "the generated _exclude patterns' jinja-in-YAML wrapper; rename the file",
        );
      }
    }
    patterns.push(
      `{% if not (${allOf(entry.gates)}) %}${anchored(gitwildmatchLiteral(entry.path))}{% endif %}`,
    );
  }
  // Directory patterns: for every directory all of whose landed files are
  // gated, exclude the directory itself unless SOME selection under it
  // holds - otherwise an all-unselected render leaves an empty directory
  // behind (the retired filename gates collapsed the dirname instead).
  const dirs = new Map<string, { all: boolean; conditions: string[] }>();
  for (const entry of entries) {
    const segments = entry.path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const dir = segments.slice(0, depth).join("/");
      const state = dirs.get(dir) ?? { all: true, conditions: [] };
      if (entry.gates.length === 0) state.all = false;
      else {
        const condition = allOf(entry.gates);
        if (!state.conditions.includes(condition)) state.conditions.push(condition);
      }
      dirs.set(dir, state);
    }
  }
  for (const [dir, state] of [...dirs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!state.all) continue;
    const anySelected =
      state.conditions.length === 1
        ? state.conditions[0]
        : state.conditions.map((condition) => `(${condition})`).join(" or ");
    patterns.push(`{% if not (${anySelected}) %}${anchored(gitwildmatchLiteral(dir))}{% endif %}`);
  }
  return patterns;
}

/** The gate a module's fragment for `anchor` renders under: the module gate
 *  alone, or, when the manifest's fragment_conditions names the anchor, the
 *  module gate AND that condition - narrowing by construction, so a
 *  fragment can never render where its module does not. */
export function fragmentGateExpression(
  anchor: string,
  module: string,
  manifest: ModuleManifest,
): string {
  const gate = gateExpression(module, manifest);
  const condition = manifest.fragment_conditions?.[anchor];
  return condition === undefined ? gate : `(${gate}) and (${condition})`;
}

/** The manifest's fragment_conditions against the fragments the module
 *  ships: every key must name a shipped fragment that the composer splices
 *  under a gate. A stale key would be a condition nothing renders under;
 *  a key naming one of `ungated` (a fragment a generator consumes or the
 *  composer prepends, both spliced without wrapFragment) would be a
 *  condition silently ignored. */
export function fragmentConditionErrors(
  module: string,
  manifest: ModuleManifest,
  shippedAnchors: Iterable<string>,
  ungated: Iterable<string>,
): string[] {
  const shipped = new Set(shippedAnchors);
  const bypassing = new Set(ungated);
  const where = `templates/${module}/module.yml: fragment_conditions names`;
  const errors: string[] = [];
  for (const anchor of Object.keys(manifest.fragment_conditions ?? {})) {
    if (!shipped.has(anchor)) {
      errors.push(
        `${where} '${anchor}' but the module ships no fragments/${anchor}${JINJA_SUFFIX}; ` +
          "add the fragment or drop the entry",
      );
    } else if (bypassing.has(anchor)) {
      errors.push(
        `${where} '${anchor}', a fragment the composer never splices under a gate (a generator ` +
          "consumes it or it is prepended to other fragments), so the condition would be ignored; " +
          "drop the entry and gate the content inside the fragment",
      );
    }
  }
  return errors;
}
