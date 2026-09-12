// The two settings-document types and the YAML parse boundary that produces
// the first. Every settings layer enters the writer here, and the types
// carry what each stage has established, so no later stage re-checks.
//
// SettingsLayer is INPUT: one layer file's document as a human wrote it.
// Nulls are legal and load bearing (the dialect's opt-out marker), so the
// type admits them. The boundary rejects only the shapes illegal even in a
// layer: a ruleset rule without a string `type` (unmergeable, and its
// silent removal would apply a weaker policy than the file declares), and a
// `labels` or `rulesets` section that is not a list of mappings (the merge
// unions those by name; any other shape would fall into wholesale replace
// and silently discard the managed roster - the apply then deletes every
// undeclared label, green either way), and an alias that names its own
// ancestor (the merge walks the document and would never end). A layer
// FILE is also refused for naming one label or ruleset twice; an overlay
// doing the same is the render's hold.
//
// MergedSettings is OUTPUT: the finished document the apply hands to GitHub.
// `null` is ABSENT from MergedValue, so a merged document still carrying the
// opt-out marker does not typecheck: the merge consumes nulls, and the
// compiler checks that every path out of it did. Both types are structural
// on purpose: layer documents are free-form settings-as-code, and a nominal
// brand would only force casts at the sites that build one honestly.

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** A YAML leaf. Not `z.number()`-shaped on purpose: `.inf` and `.nan` are
 *  legal YAML scalars that zod's number schema rejects, and a layer file
 *  is allowed to contain any scalar the apply will later reject on its
 *  own terms. */
export type LayerScalar = string | number | boolean;

/** Anything a settings layer may hold, null included: the dialect reads
 *  an explicit null as "strip this key", so it is legal input. */
export type LayerValue = LayerScalar | null | LayerValue[] | { [key: string]: LayerValue };

/** One layer document as authored (a fleet layer, a module layer, a
 *  repository's own overlay, the fleet override). */
export type SettingsLayer = { [key: string]: LayerValue };

/** The same value space MINUS null: what survives the merge. */
export type MergedValue = LayerScalar | MergedValue[] | { [key: string]: MergedValue };

/** The finished document, the one thing an apply may be handed; only
 *  merge_settings_layers.ts's hardenDocument builds one, as a FRESH
 *  structure with nulls dropped. The guard is ONE-DIRECTIONAL on purpose:
 *  MergedValue is LayerValue minus null, so a MergedSettings is also a valid
 *  SettingsLayer, and passing one back in is the fold (mergeLayers reduces
 *  with the accumulated document as the next `below`) - a brand would force
 *  casts at exactly those honest sites. Re-entry is safe because a merged
 *  document fed in as a layer is hardened again, idempotently, on the way out. */
export type MergedSettings = { [key: string]: MergedValue };

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same test inside layer space, where it narrows to the mapping arm
 *  of LayerValue instead of widening back to `unknown` values. */
export function isLayerMapping(value: LayerValue): value is { [key: string]: LayerValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A rule's `type`, or null when it has none - the shape that cannot be
 *  merged, deduplicated, or safely dropped. */
export function ruleType(rule: unknown): string | null {
  if (!isMapping(rule)) return null;
  return typeof rule.type === "string" ? rule.type : null;
}

export function rulesetLabel(entry: unknown): string {
  return isMapping(entry) && typeof entry.name === "string"
    ? `ruleset ${JSON.stringify(entry.name)}`
    : "";
}

/** A name-keyed entry's name, null for a nameless one, which the apply
 *  rejects on its own terms and no name judgment here touches. */
export function entryName(entry: unknown): string | null {
  if (!isMapping(entry)) return null;
  return typeof entry.name === "string" ? entry.name : null;
}

/** The name-keyed sections and when two names are one name: labels
 *  case-insensitively, as GitHub deduplicates them; rulesets exactly. The
 *  merge unions by these folds. */
export const NAME_FOLDS: Record<"labels" | "rulesets", (name: string) => string> = {
  labels: (name) => name.toLowerCase(),
  rulesets: (name) => name,
};

export interface NameCollision {
  section: keyof typeof NAME_FOLDS;
  /** The first entry's name, then the later one that folds to the same. */
  prior: string;
  name: string;
}

/** Every pair of one section's entries that are one name to the merge,
 *  in document order; nameless entries pass. */
export function duplicateNames(doc: SettingsLayer): NameCollision[] {
  const collisions: NameCollision[] = [];
  for (const [section, fold] of Object.entries(NAME_FOLDS) as [
    NameCollision["section"],
    (name: string) => string,
  ][]) {
    const declared = doc[section];
    if (!Array.isArray(declared)) continue;
    const seen = new Map<string, string>();
    for (const entry of declared) {
      const name = entryName(entry);
      if (name === null) continue;
      const prior = seen.get(fold(name));
      if (prior === undefined) seen.set(fold(name), name);
      else collisions.push({ section, prior, name });
    }
  }
  return collisions;
}

const layerScalarSchema = z.custom<LayerScalar>(
  (value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean",
  { message: "expected a scalar, a list or a mapping" },
);

const layerValueSchema: z.ZodType<LayerValue> = z.lazy(() =>
  z.union([
    layerScalarSchema,
    z.null(),
    z.array(layerValueSchema),
    z.record(z.string(), layerValueSchema),
  ]),
);

/** How a diagnostic names a value it refused: its shape, plus the value
 *  itself when it is a scalar small enough to quote usefully. */
function shapeName(value: LayerValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isLayerMapping(value)) return "a mapping";
  return `a scalar (${JSON.stringify(value)})`;
}

/** The shapes a layer may not declare, checked here so the error names
 *  the FILE and the position inside it. The consumers re-check nothing
 *  they read from a layer: mergeMappings takes the name-keyed union
 *  unconditionally because this boundary already refused a `labels` or
 *  `rulesets` that is not a list of mappings, and appendRules throws only
 *  for rules assembled in code, which never pass a boundary. */
const settingsLayerSchema: z.ZodType<SettingsLayer> = z
  .record(z.string(), layerValueSchema)
  .superRefine((doc, ctx) => {
    // The name-keyed sections. A mapping or scalar here would skip the
    // union and REPLACE the managed roster wholesale - for labels that
    // hands the apply a roster missing every managed label (which it then
    // deletes), for rulesets a document missing the modules' protection
    // rules - and the apply succeeds green with less than the layers
    // declare. `null` stays legal: it is the dialect's opt-out marker.
    for (const section of ["labels", "rulesets"] as const) {
      const declared = doc[section];
      if (declared === undefined || declared === null) continue;
      if (!Array.isArray(declared)) {
        ctx.addIssue({
          code: "custom",
          path: [section],
          message:
            `${section} must be a list of mappings, got ${shapeName(declared)}. The merge ` +
            `unions ${section} by name; any other shape would replace the managed ` +
            `${section} wholesale, and the apply would silently enforce less than the ` +
            "layers declare. Declare each entry as a '- name: ...' list item.",
        });
        continue;
      }
      declared.forEach((entry, index) => {
        if (isLayerMapping(entry)) return;
        ctx.addIssue({
          code: "custom",
          path: [section, index],
          message:
            `every ${section} entry must be a mapping, got ${shapeName(entry)} - the merge ` +
            "keys entries by their 'name', and a shapeless entry cannot be merged or " +
            "reconciled by the apply.",
        });
      });
    }
    const rulesets = Array.isArray(doc.rulesets) ? doc.rulesets : [];
    rulesets.forEach((entry, index) => {
      if (!isMapping(entry) || !Array.isArray(entry.rules)) return;
      entry.rules.forEach((rule, position) => {
        if (ruleType(rule) !== null) return;
        ctx.addIssue({
          code: "custom",
          path: ["rulesets", index, "rules", position],
          message:
            `${rulesetLabel(entry) || "a ruleset"} has a rule with no string 'type' ` +
            `(${JSON.stringify(rule)}) - it cannot be merged, and dropping it would apply a ` +
            "weaker policy than this file declares",
        });
      });
    });
  });

/** `rulesets[0].rules[1]`: the path an issue sits at, so a diagnostic
 *  points into the document instead of describing it. */
function issuePath(path: readonly PropertyKey[]): string {
  return path
    .map((step) => (typeof step === "number" ? `[${step}]` : `.${String(step)}`))
    .join("")
    .replace(/^\./, "");
}

function parseYamlText(text: string, where: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
}

/** The path of the first value that is one of its own ancestors, or null.
 *  The yaml parser resolves `&r {self: *r}` into a structure that contains
 *  itself; a subtree merely shared between two keys leaves the ancestor
 *  set on the way back up and is legal. */
function cyclePath(
  value: unknown,
  ancestors: Set<object>,
  path: PropertyKey[],
): PropertyKey[] | null {
  if (typeof value !== "object" || value === null) return null;
  if (ancestors.has(value)) return path;
  ancestors.add(value);
  for (const [step, child] of Object.entries(value)) {
    const found = cyclePath(child, ancestors, [
      ...path,
      Array.isArray(value) ? Number(step) : step,
    ]);
    if (found !== null) return found;
  }
  ancestors.delete(value);
  return null;
}

function asSettingsLayer(data: unknown, where: string): SettingsLayer {
  if (!isMapping(data)) throw new Error(`${where}: not a YAML mapping`);
  const cycle = cyclePath(data, new Set(), []);
  if (cycle !== null) {
    throw new Error(
      `${where}: a cyclic alias at ${issuePath(cycle)} - the document contains itself and cannot be merged`,
    );
  }
  const result = settingsLayerSchema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const at = issue === undefined ? "" : issuePath(issue.path);
  throw new Error(
    `${where}: ${at === "" ? "" : `${at}: `}${issue?.message ?? "not a settings document"}`,
  );
}

/** THE parse boundary for a settings document: YAML text in, a typed
 *  layer out, or a throw naming `where` and the path inside it. An empty
 *  document is an empty LAYER (a repository whose overlay declares nothing
 *  still has one; its absence is the render's hold). */
export function parseSettingsDoc(text: string, where: string): SettingsLayer {
  const data = parseYamlText(text, where);
  if (data === null || data === undefined) return {};
  return asSettingsLayer(data, where);
}

/** The same boundary for a fleet or module layer FILE, which the render
 *  selects from its declared roster: a file that exists but declares no
 *  mapping is an authoring accident, not the empty layer that retiring it
 *  from the roster already expresses, and a name declared twice is
 *  refused here, once, as operator data (an overlay's duplicate is the
 *  render's hold instead). */
export function parseLayerFile(text: string, where: string): SettingsLayer {
  const layer = asSettingsLayer(parseYamlText(text, where), where);
  const [collision] = duplicateNames(layer);
  if (collision !== undefined) {
    throw new Error(
      `${where}: ${collision.section} ${JSON.stringify(collision.prior)} and ` +
        `${JSON.stringify(collision.name)} are one name to the merge; a layer declares each name once`,
    );
  }
  return layer;
}
