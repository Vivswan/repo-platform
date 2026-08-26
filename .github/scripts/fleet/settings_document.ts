// The two settings-document types and the YAML parse boundary that
// produces the first of them. Every settings layer enters the fleet's
// scripts through this file, and the types carry what each stage has
// already established, so no later stage has to re-check it.
//
// SettingsLayer is INPUT: one layer file's document, exactly as a human
// wrote it. Nulls are legal there and load bearing - the dialect's
// opt-out marker (merge_settings_layers.ts) - so the type admits them.
// What the type does NOT admit is anything YAML cannot produce, and the
// boundary rejects the one shape that is illegal even in a layer: a
// ruleset rule without a string `type`, which cannot be merged or
// deduplicated and whose silent removal would apply a weaker policy than
// the file declares.
//
// MergedSettings is OUTPUT: the finished document the apply hands to
// GitHub. `null` is ABSENT from MergedValue, so a merged document that
// still carries the opt-out marker is not a runtime failure to detect -
// it does not typecheck. That is the point of the split: the merge
// consumes nulls, and the compiler now checks that every path out of the
// merge really did (a plain `Record<string, unknown>` on both sides made
// the two indistinguishable, so the guarantee lived only in whichever
// runtime pass a future merge path remembered to call).
//
// Both types are structural, deliberately: layer documents are free-form
// settings-as-code, and a nominal brand would only force casts at the
// call sites that build one honestly.

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
 *  repository's own settings.yml, the fleet override). */
export type SettingsLayer = { [key: string]: LayerValue };

/** The same value space MINUS null: what survives the merge. */
export type MergedValue = LayerScalar | MergedValue[] | { [key: string]: MergedValue };

/** The finished document, the one thing an apply may be handed. Only
 *  merge_settings_layers.ts can build one from layers. */
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

/** The one shape a layer may not declare, checked here so the error names
 *  the FILE and the position inside it. appendRules re-checks nothing it
 *  reads from a layer; it throws for rules assembled in code, which never
 *  pass a boundary. */
const settingsLayerSchema: z.ZodType<SettingsLayer> = z
  .record(z.string(), layerValueSchema)
  .superRefine((doc, ctx) => {
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

function asSettingsLayer(data: unknown, where: string): SettingsLayer {
  if (!isMapping(data)) throw new Error(`${where}: not a YAML mapping`);
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
 *  document is an empty LAYER (a repository whose settings.yml declares
 *  nothing still declares that it is onboarded - absence is the skip, and
 *  merge_settings_layers.ts owns that distinction). */
export function parseSettingsDoc(text: string, where: string): SettingsLayer {
  const data = parseYamlText(text, where);
  if (data === null || data === undefined) return {};
  return asSettingsLayer(data, where);
}

/** The same boundary for a fleet or module layer FILE, which the render
 *  selects by existence: a file that exists but declares no mapping is an
 *  authoring accident, not the empty layer that omitting it already
 *  expresses. */
export function parseLayerFile(text: string, where: string): SettingsLayer {
  return asSettingsLayer(parseYamlText(text, where), where);
}

/** A YAML mapping that is NOT a settings document (.repo-platform.yml,
 *  .copier-answers.yml): same location-carrying diagnostics, none of the
 *  layer schema, and the values stay `unknown` because each caller reads
 *  one key and validates it for itself. */
export function parseYamlMapping(text: string, where: string): Record<string, unknown> {
  const data = parseYamlText(text, where);
  if (!isMapping(data)) throw new Error(`${where}: not a YAML mapping`);
  return data;
}
