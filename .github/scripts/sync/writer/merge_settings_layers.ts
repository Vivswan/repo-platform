// The settings layering dialect, stated in docs/settings.md, "The merge
// dialect": deep merge with the higher layer winning, an explicit null as
// the opt-out that strips the lower key, name-keyed label and ruleset
// unions with a ruleset's rules appended by type, wholesale replace for
// everything else. Layers arrive as SettingsLayer from settings_document.ts
// and leave as MergedSettings, which cannot hold a null (hardenDocument):
// the dialect consumes the opt-out markers, and the type checks that it
// did. The override layer's lint (loadOverrideLayer) lives here too, so
// every consumer of the top layer passes through it.

import { readFileSync } from "node:fs";
import {
  isLayerMapping,
  isMapping,
  type LayerValue,
  type MergedSettings,
  type MergedValue,
  parseSettingsDoc,
  rulesetLabel,
  ruleType,
  type SettingsLayer,
} from "./settings_document.ts";

/** The list sections merged as name-keyed unions. `fold` decides when two
 *  entries are the same entry (labels case-insensitive, like GitHub;
 *  rulesets exact). `combine` decides what a same-name collision means:
 *  a label is REPLACED wholesale by the higher layer, while a ruleset is
 *  merged key by key so a lower layer cannot be erased by a higher one
 *  that only wants to add a rule. */
const NAME_KEYED: Record<
  string,
  {
    fold: (name: string) => string;
    combine: (lower: LayerValue, higher: LayerValue) => LayerValue;
  }
> = {
  labels: { fold: (name) => name.toLowerCase(), combine: (_lower, higher) => higher },
  rulesets: { fold: (name) => name, combine: (lower, higher) => mergeRulesetEntry(lower, higher) },
};

/** A layer value that is present: what is left of LayerValue once the
 *  dialect's null opt-out has been consumed. */
type Declared = Exclude<LayerValue, null>;

/** THE choke-point, a TYPE rather than a convention: merging works in layer
 *  space, where nulls are legal, and the merged document is the one thing an
 *  apply may be handed. Since MergedValue has no null, the only way out of
 *  the merge is through here: a merge path that skips it does not compile.
 *  Two invariants, both about what GitHub rejects: a literal null anywhere
 *  fails the apply (the opt-out means ABSENT), and a ruleset repeating a
 *  rule `type` is rejected wholesale, leaving a branch unprotected. */
function hardenDocument(doc: SettingsLayer): MergedSettings {
  return hardenMapping(doc, false, true);
}

/** `isRulesetEntry` marks THIS value as an element of a `rulesets` array,
 *  never a "somewhere below rulesets" flag: inherited by every descendant
 *  it deduplicated any nested key called `rules` as a rule list. */
function hardenValue(value: Declared, isRulesetEntry: boolean): MergedValue {
  if (Array.isArray(value)) {
    // A null ELEMENT is as fatal as a null field. Elements do not inherit
    // the ruleset-entry flag: it belongs to the direct elements of the
    // document's `rulesets` array alone.
    return value
      .filter((item): item is Declared => item !== null)
      .map((item) => hardenValue(item, false));
  }
  if (typeof value !== "object") return value;
  return hardenMapping(value, isRulesetEntry, false);
}

function hardenMapping(
  value: SettingsLayer,
  isRulesetEntry: boolean,
  atRoot: boolean,
): MergedSettings {
  const out: MergedSettings = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null) continue;
    // Filtered like every other array, `rules: [null]` would become
    // `rules: []`, and an empty rules list on `main` upserts the branch
    // with no rules at all while the apply stays green.
    if (isRulesetEntry && key === "rules" && Array.isArray(child) && child.includes(null)) {
      throw new Error(
        `${rulesetLabel(value) || "a ruleset"}: a rule is null. A null rule cannot be merged ` +
          "or identified, and silently dropping it would emit the ruleset with fewer rules " +
          "than the layers declare - possibly none, which upserts the branch unprotected on " +
          "a green run. Fix the rule in its layer file.",
      );
    }
    // Only the document's top-level `rulesets` array holds ruleset entries;
    // a nested key sharing the name is free-form data.
    if (atRoot && key === "rulesets" && Array.isArray(child)) {
      out[key] = child
        .filter((item): item is Declared => item !== null)
        .map((item) => hardenValue(item, true));
      continue;
    }
    out[key] = hardenValue(child, false);
  }
  if (isRulesetEntry && Array.isArray(out.rules)) {
    out.rules = appendRules(out.rules, [], rulesetLabel(out));
  }
  return out;
}

/** A ruleset's `rules` list APPENDS across layers, keyed by `type`: the
 *  lower layer's rules in order, each replaced in place by a same-type
 *  higher rule, then the higher layer's new types. First occurrence wins
 *  within one layer. Two signatures for one body because this never
 *  invents an element, so hardened rules in means hardened rules out. */
export function appendRules(
  lower: readonly MergedValue[],
  higher: readonly MergedValue[],
  where?: string,
): MergedValue[];
export function appendRules(
  lower: readonly LayerValue[],
  higher: readonly LayerValue[],
  where?: string,
): LayerValue[];
export function appendRules(
  lower: readonly LayerValue[],
  higher: readonly LayerValue[],
  where = "a ruleset",
): LayerValue[] {
  const higherByType = new Map<string, LayerValue>();
  for (const rule of higher) {
    const type = ruleType(rule);
    if (type !== null && !higherByType.has(type)) higherByType.set(type, rule);
  }
  const taken = new Set<string>();
  const merged: LayerValue[] = [];
  const take = (rules: readonly LayerValue[]) => {
    for (const rule of rules) {
      const type = ruleType(rule);
      // Never a drop: a rule that lost its type would otherwise leave the
      // fleet's protection quietly smaller on a green run.
      if (type === null) {
        throw new Error(
          `${where}: a rule has no string 'type' (${JSON.stringify(rule)}). A rule that cannot ` +
            "be identified cannot be merged or deduplicated, and emitting the ruleset without " +
            "it would apply a weaker policy than the layers declare. Fix the rule in its layer " +
            "file.",
        );
      }
      // GitHub rejects a ruleset carrying one type twice.
      if (taken.has(type)) continue;
      merged.push(higherByType.get(type) ?? rule);
      taken.add(type);
    }
  };
  take(lower);
  take(higher);
  return merged;
}

/** Two same-name ruleset entries: every field merged by the SAME dialect
 *  the rest of the document uses (nested objects deep-merge, an explicit
 *  null strips the key) except `rules`, which appends. */
export function mergeRulesetEntry(lower: LayerValue, higher: LayerValue): LayerValue {
  if (!isLayerMapping(lower) || !isLayerMapping(higher)) return higher;
  const { rules: lowerRules, ...lowerFields } = lower;
  const { rules: higherRules, ...higherFields } = higher;
  const merged: SettingsLayer = mergeMappings(lowerFields, higherFields, {});
  // PRESENCE, not truthiness: an explicit `rules: null` is the opt-out and
  // strips the inherited rules; the null rides out to the choke-point.
  const rules =
    Array.isArray(lowerRules) && Array.isArray(higherRules)
      ? appendRules(lowerRules, higherRules, rulesetLabel(higher) || rulesetLabel(lower))
      : "rules" in higher
        ? higherRules
        : lowerRules;
  if (rules !== undefined) merged.rules = rules;
  return merged;
}

function entryName(entry: unknown): string | null {
  if (!isMapping(entry)) return null;
  return typeof entry.name === "string" ? entry.name : null;
}

/** Lower-layer entries in order, each combined with the same-name
 *  higher-layer entry when one exists; higher-only entries (and nameless
 *  ones, which the apply will reject on its own terms) appended in higher
 *  order. */
export function nameKeyedUnion(
  managed: readonly LayerValue[],
  repo: readonly LayerValue[],
  fold: (name: string) => string,
  combine: (lower: LayerValue, higher: LayerValue) => LayerValue = (_lower, higher) => higher,
): LayerValue[] {
  const repoByName = new Map<string, LayerValue>();
  for (const entry of repo) {
    const name = entryName(entry);
    if (name !== null && !repoByName.has(fold(name))) repoByName.set(fold(name), entry);
  }
  const taken = new Set<string>();
  const merged: LayerValue[] = [];
  for (const entry of managed) {
    const name = entryName(entry);
    if (name === null) {
      merged.push(entry);
      continue;
    }
    const key = fold(name);
    const override = repoByName.get(key);
    if (override !== undefined) {
      merged.push(combine(entry, override));
      taken.add(key);
    } else {
      merged.push(entry);
    }
  }
  for (const entry of repo) {
    const name = entryName(entry);
    if (name === null) {
      merged.push(entry);
      continue;
    }
    // A higher-layer duplicate rides through once, first wins
    // (duplicateNameWarnings names the duplicate).
    if (!taken.has(fold(name))) {
      merged.push(entry);
      taken.add(fold(name));
    }
  }
  return merged;
}

/** Overlay entries sharing a folded name: the union takes the FIRST and
 *  the rest ride through as extras, so the apply would fight itself over
 *  the label. Returned as texts for the render to hold on. */
export function duplicateNameWarnings(repo: SettingsLayer, where: string): string[] {
  const warnings: string[] = [];
  for (const [section, { fold }] of Object.entries(NAME_KEYED)) {
    const declared = repo[section];
    // Undeclared, or the dialect's null opt-out; anything else the parse
    // boundary guarantees is a list of mappings.
    if (declared === undefined || declared === null) continue;
    const entries = declared as LayerValue[];
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const name = entryName(entry);
      if (name === null) continue;
      const prior = seen.get(fold(name));
      if (prior !== undefined) {
        warnings.push(
          `${where} declares ${section} ${JSON.stringify(prior)} and ${JSON.stringify(name)}, ` +
            "which the apply treats as one name - only the first entry takes effect in the " +
            "merge; remove the duplicate",
        );
      } else {
        seen.set(fold(name), name);
      }
    }
  }
  return warnings;
}

/** Two plain objects merged key by key, the higher winning; a higher
 *  `null` strips the key. Layer space in, layer space out: the nulls the
 *  higher layer did not consume are still in the result, which is why the
 *  merged type is only reachable through hardenDocument. */
function mergeMappings(
  managed: SettingsLayer,
  repo: SettingsLayer,
  nameKeyed: typeof NAME_KEYED,
): SettingsLayer {
  const merged: SettingsLayer = {};
  for (const key of [...Object.keys(managed), ...Object.keys(repo)]) {
    if (key in merged) continue;
    if (!(key in repo)) {
      merged[key] = managed[key];
      continue;
    }
    const repoValue = repo[key];
    if (repoValue === null) continue;
    if (!(key in managed)) {
      merged[key] = repoValue;
      continue;
    }
    const managedValue = managed[key];
    if (managedValue === null) {
      // The lower layer's own un-consumed opt-out declares nothing to
      // merge with, so the higher value stands alone.
      merged[key] = repoValue;
      continue;
    }
    const section = nameKeyed[key];
    if (section !== undefined) {
      // Unconditionally the union: the parse boundary refused any labels
      // or rulesets that is not a list of mappings.
      merged[key] = nameKeyedUnion(
        managedValue as LayerValue[],
        repoValue as LayerValue[],
        section.fold,
        section.combine,
      );
    } else if (isLayerMapping(managedValue) && isLayerMapping(repoValue)) {
      // Name-keying applies at the section level only.
      merged[key] = mergeMappings(managedValue, repoValue, {});
    } else {
      merged[key] = repoValue;
    }
  }
  return merged;
}

/** The merged settings document: `repo` layered over `managed` under the
 *  dialect in the header. Idempotent, so folding many layers re-runs it
 *  harmlessly, and no merge path reaches a MergedSettings around it. */
export function mergeSettingsLayers(managed: SettingsLayer, repo: SettingsLayer): MergedSettings {
  return hardenDocument(mergeMappings(managed, repo, NAME_KEYED));
}

/** Every layer folded low to high under the dialect above. */
export function mergeLayers(layers: SettingsLayer[]): MergedSettings {
  return layers.reduce<MergedSettings>((below, layer) => mergeSettingsLayers(below, layer), {});
}

export interface IdentityIssue {
  key: string;
  expected: string;
  got: string;
}

/** Shape hygiene for the identity keys an overlay declares (the starter
 *  seeds all four; the apply never touches an undeclared key, so drift in
 *  a missing one is never healed). */
export function identityKeyIssues(repository: Record<string, unknown>): IdentityIssue[] {
  const issues: IdentityIssue[] = [];
  const got = (value: unknown) => (value === undefined ? "missing" : JSON.stringify(value));
  if (typeof repository.description !== "string" || repository.description === "") {
    issues.push({
      key: "description",
      expected: "a non-empty description string",
      got: got(repository.description),
    });
  }
  if (typeof repository.homepage !== "string") {
    issues.push({
      key: "homepage",
      expected: 'a homepage string ("" declares-and-clears)',
      got: got(repository.homepage),
    });
  }
  const topics = repository.topics;
  if (
    typeof topics !== "string" &&
    !(Array.isArray(topics) && topics.every((t) => typeof t === "string"))
  ) {
    issues.push({
      key: "topics",
      expected: "a declared topics value (string or string list)",
      got: got(topics),
    });
  }
  if (typeof repository.private !== "boolean") {
    issues.push({
      key: "private",
      expected: "an explicit boolean, so the apply manages visibility",
      got: got(repository.private),
    });
  }
  return issues;
}

/** The check the fleet's ci.yml all-green job carries: the main ruleset's
 *  ONE required context. */
export const ALL_GREEN_CONTEXT = "all-green";

/** GitHub Actions' app id. The verdict's check run is created by an
 *  Actions workflow run, so the required-check entry pins this
 *  integration_id; without the pin, any app or plain commit status could
 *  satisfy the required context by matching its name. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The fleet-mandatory top layer, merged ABOVE every repository's overlay
 *  so no repository can weaken what it declares. Validated here against
 *  the required-check mistakes that weaken the whole fleet: the main
 *  ruleset must require ALL_GREEN_CONTEXT, and every required-check entry
 *  must pin integration_id to GitHub Actions. */
export function loadOverrideLayer(path: string): SettingsLayer {
  const data = parseSettingsDoc(readFileSync(path, "utf-8"), path);
  const rulesets = Array.isArray(data.rulesets) ? data.rulesets : [];
  const main = rulesets.find((entry) => isMapping(entry) && entry.name === "main");
  const mainRules: unknown[] = isMapping(main) && Array.isArray(main.rules) ? main.rules : [];
  const checksRule = mainRules.find(
    (rule): rule is Record<string, unknown> =>
      isMapping(rule) && rule.type === "required_status_checks",
  );
  const checksParams =
    checksRule !== undefined && isMapping(checksRule.parameters) ? checksRule.parameters : {};
  const rawEntries = Array.isArray(checksParams.required_status_checks)
    ? checksParams.required_status_checks
    : [];
  const entries = rawEntries.map((entry, index) => {
    if (!isMapping(entry)) {
      throw new Error(
        `${path}: required_status_checks[${index}] is not a mapping - every entry must be ` +
          "a { context, integration_id } object, and a malformed one must never reach the apply.",
      );
    }
    return entry;
  });
  if (!entries.some((entry) => entry.context === ALL_GREEN_CONTEXT)) {
    throw new Error(
      `${path}: the 'main' ruleset must require the ${ALL_GREEN_CONTEXT} status check - it is ` +
        "the fleet's ONE merge gate (ci.yml's all-green job judging every gating job's " +
        "result), and dropping it from the override un-gates every managed " +
        "repository at once.",
    );
  }
  for (const entry of entries) {
    if (entry.integration_id !== GITHUB_ACTIONS_APP_ID) {
      throw new Error(
        `${path}: required status check '${String(entry.context)}' must pin ` +
          `integration_id: ${GITHUB_ACTIONS_APP_ID} (the GitHub Actions app) - without the ` +
          "pin, any app or plain commit status satisfies the context just by matching its " +
          "name, which spoofs the merge gate.",
      );
    }
  }
  return data;
}
