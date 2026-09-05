#!/usr/bin/env bun
// Merges a repository's own .github/settings.yml OVER its computed
// managed settings baseline (render_managed_settings.ts), producing the
// one document github-settings-as-code applies. The single home of the
// layering dialect:
//
// - Deep merge: the repo layer wins; objects merge key by key.
// - An explicit `null` in the repo layer opts that key out entirely: the
//   key is stripped from the merged document, so the apply never touches
//   that section (or nested key) on this repository.
// - `labels` and `rulesets` are NAME-KEYED UNIONS: both sides' other
//   entries are kept. A same-name LABEL is replaced wholesale by the
//   higher layer; a same-name RULESET merges field by field, with its
//   `rules` appended by rule `type` (see appendRules). Plain array-replace
//   would freeze the managed roster (a repo declaring one extra label
//   would nightly-delete every module label the moment the baseline
//   grows); the union keeps repo additions and managed evolution both
//   live. Label names match case-insensitively (GitHub deduplicates
//   label names that way); ruleset names match exactly.
// - Every other array (and every scalar) replaces wholesale.
//
// Layers arrive as the SettingsLayer type, from settings_document.ts's
// parse boundary, and leave as a MergedSettings, which cannot hold a null
// at all (hardenDocument below). The dialect's job is to consume the
// opt-out markers; the type is what checks that it did. The boundary also
// refuses a labels/rulesets section that is not a list of mappings, so
// the unions here never meet a shape they would have to fall back from.
//
// A repository with no .github/settings.yml is NOT-YET-ONBOARDED, never
// "an empty repo layer": applying the managed baseline alone would let
// the action's delete-undeclared label reconciliation wipe every label
// the repository declared for itself. Absence therefore SKIPS the apply
// (loudly, and `skipped=true` on the step) instead of producing a
// document. The settings-sync starter seeds settings.yml on the next
// template sync, and the apply after that picks it up.
//
// CLI:
//   bun .github/scripts/fleet/merge_settings_layers.ts --managed <file>
//     --out <file> (--repo-file <path> | --repo-fetch <owner/name>)
//
// --repo-file reads the repo layer from a local path (the self-apply's
// own checkout); --repo-fetch reads it from the target via gh api (env:
// GH_TOKEN), pinned to --repo-ref, the commit the render read its facts
// at. Exactly one source is required - there is no baseline-only mode,
// because its output is the destructive document above.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail, setOutput, warning } from "../shared/gha.ts";
import { captureNetwork } from "./discovery.ts";
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

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
export const OVERRIDE_PATH = join(REPO_ROOT, ".github/settings-override.yml");

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

/** THE choke-point, now a TYPE rather than a convention: merging works in
 *  layer space, where nulls are legal, and the merged document is the one
 *  thing an apply may be handed. Since MergedValue has no null, the only
 *  way out of the merge is through here - a future merge path that skips
 *  it does not compile, where before it merely produced a document that
 *  looked like every other Record<string, unknown>.
 *
 *  Two invariants, both about what GitHub rejects: a literal null anywhere
 *  fails the apply (the dialect's opt-out means ABSENT), and a ruleset
 *  repeating a rule `type` is rejected wholesale, which leaves a branch
 *  unprotected on a green run. */
function hardenDocument(doc: SettingsLayer): MergedSettings {
  return hardenMapping(doc, false, true);
}

/** `isRulesetEntry` marks THIS value as an element of a `rulesets` array -
 *  it is not a "somewhere below rulesets" flag. Letting it stay true for
 *  every descendant deduplicated any nested key called `rules` as though
 *  it were a rule list, which silently emptied `conditions.rules`. */
function hardenValue(value: Declared, isRulesetEntry: boolean): MergedValue {
  if (Array.isArray(value)) {
    // A null ELEMENT is as fatal as a null field, and mapping alone left
    // it in place. Elements do NOT inherit the ruleset-entry flag: it
    // belongs to the direct elements of a `rulesets` ARRAY alone (the
    // explicit arm in hardenMapping), never to arrays nested deeper
    // inside an entry.
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
    // A ruleset entry's rules NEVER silently lose a null element: filtered
    // like every other array, `rules: [null]` becomes `rules: []`, and an
    // empty rules list on `main` upserts the protected branch with NO
    // rules at all - the apply stays green while the protection vanishes.
    // The same hard-error appendRules throws for a type-less rule, one
    // step earlier (the parse boundary already refuses this in a layer
    // FILE; this covers documents assembled in code).
    if (isRulesetEntry && key === "rules" && Array.isArray(child) && child.includes(null)) {
      throw new Error(
        `${rulesetLabel(value) || "a ruleset"}: a rule is null. A null rule cannot be merged ` +
          "or identified, and silently dropping it would emit the ruleset with fewer rules " +
          "than the layers declare - possibly none, which upserts the branch unprotected on " +
          "a green run. Fix the rule in its layer file.",
      );
    }
    // The ruleset-entry flag marks exactly the direct elements of the
    // DOCUMENT'S top-level `rulesets` array (the section the dialect
    // defines). A mapping under the key (rulesets: {rules: ...}) is
    // malformed input, not a ruleset entry, and a NESTED key that merely
    // shares the name (repository.metadata.rulesets) is free-form data -
    // either used to draw entry semantics and a diagnostic naming a
    // ruleset that does not exist.
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
 *  lower layer's rules in order, each replaced in place by a higher-layer
 *  rule of the same type, then the higher layer's new types appended.
 *  This is what lets a module's visibility layer add `code_scanning` to
 *  the `main` ruleset that .github/settings-override.yml declares - the
 *  override sits at the top of the stack, so a whole-entry replace would
 *  drop the module's rule instead. When both layers carry rule arrays,
 *  every distinct rule TYPE survives the merge (and first occurrence
 *  wins within one layer), but a same-type rule in a higher layer
 *  replaces the lower one's parameters wholesale - which can weaken it
 *  as easily as tighten it - and an explicit `rules: null` in a higher
 *  layer strips the inherited list entirely (mergeRulesetEntry). Only
 *  the override's own rules are unbeatable, because no layer merges
 *  above them.
 *
 *  Two signatures for one body because this never invents an element: it
 *  picks from what it was handed, so hardened rules in means hardened
 *  rules out, and the hardening pass can dedup without a cast. */
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
      // Never a drop. Dropping it would let the apply SUCCEED with the
      // policy quietly weakened - if an override rule ever lost its type
      // through some other bug, the fleet's protection would silently
      // shrink and the run would stay green. The pinned action passes a
      // malformed rule through on purpose so GitHub 422s loudly; failing
      // here is the same choice, one step earlier and with a better
      // message.
      if (type === null) {
        throw new Error(
          `${where}: a rule has no string 'type' (${JSON.stringify(rule)}). A rule that cannot ` +
            "be identified cannot be merged or deduplicated, and emitting the ruleset without " +
            "it would apply a weaker policy than the layers declare. Fix the rule in its layer " +
            "file.",
        );
      }
      // First occurrence wins on BOTH sides. Without this, a layer that
      // declares one type twice emits it twice (or emits the higher
      // layer's replacement twice), and GitHub rejects the ruleset -
      // which would stop layer 6 applying at all.
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
 *  the rest of the document uses - nested objects deep-merge, an explicit
 *  null strips the key - except `rules`, which appends (see appendRules).
 *  Doing the fields by hand here is what made a partial `conditions`
 *  replace the whole lower object and a `bypass_actors: null` land in the
 *  document literally, which GitHub rejects. */
export function mergeRulesetEntry(lower: LayerValue, higher: LayerValue): LayerValue {
  if (!isLayerMapping(lower) || !isLayerMapping(higher)) return higher;
  const { rules: lowerRules, ...lowerFields } = lower;
  const { rules: higherRules, ...higherFields } = higher;
  const merged: SettingsLayer = mergeMappings(lowerFields, higherFields, {});
  // PRESENCE, not truthiness: an explicit `rules: null` is the opt-out
  // and must strip the inherited rules; the null rides out to the
  // choke-point, which removes the key. Layer 6 re-adds its own rules
  // afterwards, so the fleet's mandatory ones survive it.
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
 *  order. A higher entry of `null` under a matched name is not a thing
 *  (entries are objects); the null opt-out applies to the section key
 *  itself. */
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
    // taken also collects appended repo-only names, so a repo-layer
    // duplicate rides through once - the same first-wins rule the matched
    // branch applies (duplicateNameWarnings names the duplicate).
    if (!taken.has(fold(name))) {
      merged.push(entry);
      taken.add(fold(name));
    }
  }
  return merged;
}

/** Repo-layer entries sharing a folded name: the union takes the FIRST
 *  and the rest ride through as repo-only extras, so the apply would
 *  fight itself over the label. Returned as warning texts - the repo
 *  layer is repo-owned content the merge must not hard-fail on. */
export function duplicateNameWarnings(repo: SettingsLayer): string[] {
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
          `the repository's settings.yml declares ${section} ${JSON.stringify(prior)} and ` +
            `${JSON.stringify(name)}, which the apply treats as one name - only the first ` +
            "entry takes effect in the merge; remove the duplicate",
        );
      } else {
        seen.set(fold(name), name);
      }
    }
  }
  return warnings;
}

/** Two plain objects merged key by key, repo winning; a repo `null`
 *  strips the key. Layer space in, layer space out: the nulls the higher
 *  layer did not consume (a lower layer's own opt-out markers, a nested
 *  one under a key only one side declares) are still in the result, which
 *  is why the merged type is only reachable through hardenDocument. */
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
    if (repoValue === null) continue; // explicit opt-out: the key is stripped
    if (!(key in managed)) {
      merged[key] = repoValue;
      continue;
    }
    const managedValue = managed[key];
    if (managedValue === null) {
      // The lower layer's own un-consumed opt-out marker: it declares
      // nothing for the higher layer to merge WITH, so the higher value
      // stands alone (same result the wholesale-replace arm produced).
      merged[key] = repoValue;
      continue;
    }
    const section = nameKeyed[key];
    if (section !== undefined) {
      // Unconditionally the union: the parse boundary
      // (settings_document.ts) refused any labels/rulesets that is not a
      // list of mappings, so both declared sides are lists here. The old
      // Array.isArray guards routed a mis-shaped section to wholesale
      // replace, which silently discarded the managed roster - the apply
      // then deleted every managed label, or upserted `main` without the
      // modules' rules, green either way.
      merged[key] = nameKeyedUnion(
        managedValue as LayerValue[],
        repoValue as LayerValue[],
        section.fold,
        section.combine,
      );
    } else if (isLayerMapping(managedValue) && isLayerMapping(repoValue)) {
      // Name-keying applies only at the section level; nested objects
      // merge plainly.
      merged[key] = mergeMappings(managedValue, repoValue, {});
    } else {
      merged[key] = repoValue;
    }
  }
  return merged;
}

/** The merged settings document: `repo` layered over `managed` under the
 *  dialect in the header. */
export function mergeSettingsLayers(managed: SettingsLayer, repo: SettingsLayer): MergedSettings {
  // Merge in layer space, harden the whole result exactly once. Idempotent,
  // so folding many layers re-runs it harmlessly - and no merge path can
  // reach a MergedSettings without passing through it.
  return hardenDocument(mergeMappings(managed, repo, NAME_KEYED));
}

/** The identity keys the merged document should declare (they can only
 *  come from the repo layer - the baseline omits them on purpose). The
 *  apply never touches an undeclared key, so a missing one's out-of-band
 *  drift is never healed; returned for the caller to warn on, never an
 *  error - identity is repo-owned under this model, and a repo choosing
 *  not to declare a key must not lose its baseline heal over it. */
export function missingIdentityKeys(merged: MergedSettings): string[] {
  const repository = merged.repository;
  const declared = isMapping(repository) ? repository : {};
  return ["description", "homepage", "topics", "private"].filter((key) => !(key in declared));
}

export interface IdentityIssue {
  key: string;
  expected: string;
  got: string;
}

/** Shape hygiene for the identity keys a repo layer declares (the
 *  settings-sync starter seeds all four; the apply never touches an
 *  undeclared key, so drift in a missing one is never healed).
 *  check_ssot.ts applies this to repo-platform's own .github/settings.yml;
 *  missingIdentityKeys above is the merge path's presence warning. */
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

/** The repo layer AT THE REF the facts were read at. Without the pin this
 *  read happens later than the fact reads, so a push in between pairs an
 *  old module selection with a new repo layer and the apply deletes the
 *  labels of a module the repo had just selected. */
function fetchRepoLayer(repo: string, ref: string): { text: string; where: string } | null {
  const where = `${repo}/.github/settings.yml@${ref}`;
  const proc = captureNetwork([
    "gh",
    "api",
    `repos/${repo}/contents/.github/settings.yml?ref=${ref}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return { text: proc.stdout, where };
  if (proc.stderr.includes("HTTP 404")) return null;
  throw new Error(`${where}: fetch failed (${proc.stderr.trim().split("\n")[0]})`);
}

/** Every layer folded low to high under the dialect above. */
export function mergeLayers(layers: SettingsLayer[]): MergedSettings {
  return layers.reduce<MergedSettings>((below, layer) => mergeSettingsLayers(below, layer), {});
}

/** The check the fleet's ci.yml all-green job carries (its own job
 *  check run - the job needs every gating job and fails unless each
 *  result is success or skipped with at least one success). The main
 *  ruleset's ONE required context; the retired direct
 *  copilot-pull-request-reviewer context was the pre-cutover belt. */
export const ALL_GREEN_CONTEXT = "all-green";

/** GitHub Actions' app id. The verdict's check run is created by an
 *  Actions workflow run, so the required-check entry pins this
 *  integration_id - without the pin, ANY app or plain commit status
 *  could satisfy the required context just by matching its name. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The fleet-mandatory top layer: merged ABOVE the repository's own
 *  settings.yml, so no repository can weaken what it declares - including
 *  by nulling the key out, since the null opt-out only strips keys from
 *  the layers BELOW this one.
 *
 *  Validated here, the one place every consumer goes through, against the
 *  required-check mistakes that weaken the whole fleet: the main ruleset
 *  must require ALL_GREEN_CONTEXT, and every required-check entry must
 *  pin integration_id to GitHub Actions (see GITHUB_ACTIONS_APP_ID). */
export function loadOverrideLayer(path: string = OVERRIDE_PATH): SettingsLayer {
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

export interface RepoLayer {
  text: string;
  where: string;
}

/** What a run does with a resolved repo layer. A null layer is the
 *  not-yet-onboarded skip (see the header): the merged document exists
 *  only when the repository declared a settings.yml, so the apply can
 *  never receive a baseline-only document. */
export type MergeOutcome =
  | { kind: "skip"; message: string }
  | { kind: "merged"; document: MergedSettings; warnings: string[] };

export function mergeOutcome(
  managed: SettingsLayer,
  repoLayer: RepoLayer | null,
  source: string,
  override: SettingsLayer = loadOverrideLayer(),
): MergeOutcome {
  if (repoLayer === null) {
    return {
      kind: "skip",
      message:
        `no repository settings layer at ${source} - the repository selected settings-sync ` +
        "but is not onboarded yet, so this apply is SKIPPED. Applying the managed baseline " +
        "alone would delete every label the repository declares for itself, because the " +
        "apply deletes undeclared labels. The settings-sync starter seeds the file on the " +
        "next template sync and the apply after that picks it up.",
    };
  }
  const repo = parseSettingsDoc(repoLayer.text, repoLayer.where);
  const warnings = [...duplicateNameWarnings(repo)];
  // The repo layer over everything below it, then the fleet override on
  // top - the one layer the repository cannot beat.
  const merged = mergeSettingsLayers(mergeSettingsLayers(managed, repo), override);
  const missing = missingIdentityKeys(merged);
  if (missing.length > 0) {
    warnings.push(
      `the merged settings document declares no ${missing.join(", ")} - the apply never ` +
        "touches an undeclared key, so out-of-band drift in " +
        `${missing.length === 1 ? "it" : "them"} is never healed; ` +
        "declare the identity keys in the repository's .github/settings.yml",
    );
  }
  return { kind: "merged", document: merged, warnings };
}

/** Where the repo layer comes from. A UNION rather than three loose
 *  flags: a fetched layer must name the commit the facts were read at, so
 *  the pin cannot degrade to a moving-branch read because someone dropped
 *  a step id, misspelled an output, or forgot the flag. A local path has
 *  no ref: the checkout is already one coherent revision. */
export type RepoSource =
  | { kind: "file"; path: string }
  | { kind: "fetch"; repo: string; ref: string };

export function repoSourceFrom(
  file: string | undefined,
  fetch: string | undefined,
  ref: string | undefined,
): RepoSource {
  if (file !== undefined && fetch !== undefined) {
    throw new Error("--repo-file and --repo-fetch are mutually exclusive - pass one source");
  }
  if (file !== undefined) {
    if (ref !== undefined && ref !== "") {
      throw new Error("--repo-ref belongs to --repo-fetch; a local path is already one revision");
    }
    return { kind: "file", path: file };
  }
  if (fetch !== undefined) {
    if (ref === undefined || !/^[0-9a-f]{40}$/.test(ref)) {
      throw new Error(
        `--repo-fetch needs --repo-ref <40-hex commit sha> (got ${JSON.stringify(ref ?? "")}). ` +
          "The repo layer must be read at the same commit the facts were, or a push between " +
          "the two reads pairs an old module selection with a new layer and the apply deletes " +
          "the labels of a module the repo just selected.",
      );
    }
    return { kind: "fetch", repo: fetch, ref };
  }
  throw new Error("pass a repo-layer source: --repo-file <path> or --repo-fetch <owner/name>");
}

function main(args: string[]): void {
  const flags = parseFlags(
    args,
    ["--managed", "--out"] as const,
    ["--repo-file", "--repo-fetch", "--repo-ref"] as const,
  );
  let source: RepoSource;
  try {
    source = repoSourceFrom(flags["--repo-file"], flags["--repo-fetch"], flags["--repo-ref"]);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  try {
    const managed = parseSettingsDoc(readFileSync(flags["--managed"], "utf-8"), flags["--managed"]);
    const repoLayer =
      source.kind === "file"
        ? existsSync(source.path)
          ? { text: readFileSync(source.path, "utf-8"), where: source.path }
          : null
        : fetchRepoLayer(source.repo, source.ref);
    const outcome = mergeOutcome(
      managed,
      repoLayer,
      source.kind === "file" ? source.path : source.repo,
    );
    if (outcome.kind === "skip") {
      warning(outcome.message);
      setOutput("skipped", "true");
      console.log("skipped: the repository has no settings.yml to layer over the baseline");
      return;
    }
    for (const message of outcome.warnings) warning(message);
    writeFileSync(
      flags["--out"],
      `# Merged settings document (managed baseline + the repository's own settings.yml),\n# built by repo-platform's .github/scripts/fleet/merge_settings_layers.ts - scratch output.\n${stringifyYaml(outcome.document)}`,
    );
    setOutput("skipped", "false");
    console.log(`merged the repo layer over the baseline into ${flags["--out"]}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
