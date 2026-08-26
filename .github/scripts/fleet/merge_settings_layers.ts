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
// own checkout); --repo-fetch reads it from the target's default branch
// via gh api (env: GH_TOKEN). Exactly one is required - there is no
// baseline-only mode, because its output is the destructive document
// above.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseFlags } from "../shared/flags.ts";
import { fail, setOutput, warning } from "../shared/gha.ts";
import { captureNetwork } from "./discovery.ts";

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
    combine: (lower: unknown, higher: unknown) => unknown;
    /** Applied to EVERY emitted entry, not just merged ones: an entry
     *  contributed by one side alone never passes through the merge, so
     *  without this its nulls would reach the document literally. */
    normalize?: (entry: unknown) => unknown;
  }
> = {
  labels: { fold: (name) => name.toLowerCase(), combine: (_lower, higher) => higher },
  rulesets: {
    fold: (name) => name,
    combine: (lower, higher) => mergeRulesetEntry(lower, higher),
    normalize: stripNulls,
  },
};

/** The null opt-out, applied inside a list entry: a null-valued key is
 *  removed rather than emitted. GitHub rejects a ruleset carrying a
 *  literal null, so an entry that never met a merge partner still has to
 *  obey the dialect. */
export function stripNulls(entry: unknown): unknown {
  if (Array.isArray(entry)) return entry.map(stripNulls);
  if (!isMapping(entry)) return entry;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value === null) continue;
    out[key] = stripNulls(value);
  }
  return out;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ruleType(rule: unknown): string | null {
  if (!isMapping(rule)) return null;
  return typeof rule.type === "string" ? rule.type : null;
}

/** A ruleset's `rules` list APPENDS across layers, keyed by `type`: the
 *  lower layer's rules in order, each replaced in place by a higher-layer
 *  rule of the same type, then the higher layer's new types appended.
 *  This is what lets a module's visibility layer add `code_scanning` to
 *  the `main` ruleset that .github/settings-override.yml declares - the
 *  override sits at the top of the stack, so a whole-entry replace would
 *  drop the module's rule instead. Adding a rule can only tighten the
 *  ruleset; nothing here can remove one a higher layer declared. */
export function appendRules(lower: unknown[], higher: unknown[]): unknown[] {
  const higherByType = new Map<string, unknown>();
  for (const rule of higher) {
    const type = ruleType(rule);
    if (type !== null && !higherByType.has(type)) higherByType.set(type, rule);
  }
  const taken = new Set<string>();
  const merged: unknown[] = [];
  const take = (rules: unknown[]) => {
    for (const rule of rules) {
      const type = ruleType(rule);
      // A rule with no usable `type` cannot be deduplicated, and GitHub
      // rejects it anyway; dropping it here keeps one malformed entry
      // from being emitted twice (once per side) and turning a rejected
      // ruleset into a silently unapplied one.
      if (type === null) {
        warning(
          `a ruleset rule without a string 'type' was dropped from the merge: ${JSON.stringify(rule)}`,
        );
        continue;
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
export function mergeRulesetEntry(lower: unknown, higher: unknown): unknown {
  if (!isMapping(lower) || !isMapping(higher)) return higher;
  const { rules: lowerRules, ...lowerFields } = lower;
  const { rules: higherRules, ...higherFields } = higher;
  const merged: Record<string, unknown> = mergeMappings(lowerFields, higherFields, {});
  const rules =
    Array.isArray(lowerRules) && Array.isArray(higherRules)
      ? appendRules(lowerRules, higherRules)
      : (higherRules ?? lowerRules);
  // A null on either side is left for stripNulls, which removes the key.
  if (rules !== undefined) merged.rules = rules;
  return stripNulls(merged);
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
  managed: unknown[],
  repo: unknown[],
  fold: (name: string) => string,
  combine: (lower: unknown, higher: unknown) => unknown = (_lower, higher) => higher,
  normalize: (entry: unknown) => unknown = (entry) => entry,
): unknown[] {
  const repoByName = new Map<string, unknown>();
  for (const entry of repo) {
    const name = entryName(entry);
    if (name !== null && !repoByName.has(fold(name))) repoByName.set(fold(name), entry);
  }
  const taken = new Set<string>();
  const merged: unknown[] = [];
  for (const entry of managed) {
    const name = entryName(entry);
    if (name === null) {
      merged.push(normalize(entry));
      continue;
    }
    const key = fold(name);
    const override = repoByName.get(key);
    if (override !== undefined) {
      merged.push(normalize(combine(entry, override)));
      taken.add(key);
    } else {
      merged.push(normalize(entry));
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
      merged.push(normalize(entry));
      taken.add(fold(name));
    }
  }
  return merged;
}

/** Repo-layer entries sharing a folded name: the union takes the FIRST
 *  and the rest ride through as repo-only extras, so the apply would
 *  fight itself over the label. Returned as warning texts - the repo
 *  layer is repo-owned content the merge must not hard-fail on. */
export function duplicateNameWarnings(repo: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  for (const [section, { fold }] of Object.entries(NAME_KEYED)) {
    const entries = repo[section];
    if (!Array.isArray(entries)) continue;
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
 *  strips the key. */
function mergeMappings(
  managed: Record<string, unknown>,
  repo: Record<string, unknown>,
  nameKeyed: typeof NAME_KEYED,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
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
    const section = nameKeyed[key];
    if (section !== undefined && Array.isArray(managedValue) && Array.isArray(repoValue)) {
      merged[key] = nameKeyedUnion(
        managedValue,
        repoValue,
        section.fold,
        section.combine,
        section.normalize,
      );
    } else if (isMapping(managedValue) && isMapping(repoValue)) {
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
export function mergeSettingsLayers(
  managed: Record<string, unknown>,
  repo: Record<string, unknown>,
): Record<string, unknown> {
  return mergeMappings(managed, repo, NAME_KEYED);
}

/** The identity keys the merged document should declare (they can only
 *  come from the repo layer - the baseline omits them on purpose). The
 *  apply never touches an undeclared key, so a missing one's out-of-band
 *  drift is never healed; returned for the caller to warn on, never an
 *  error - identity is repo-owned under this model, and a repo choosing
 *  not to declare a key must not lose its baseline heal over it. */
export function missingIdentityKeys(merged: Record<string, unknown>): string[] {
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

export function parseSettingsDoc(text: string, where: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
  if (data === null || data === undefined) return {};
  if (!isMapping(data)) throw new Error(`${where}: not a YAML mapping`);
  return data;
}

function fetchRepoLayer(repo: string): { text: string; where: string } | null {
  const proc = captureNetwork([
    "gh",
    "api",
    `repos/${repo}/contents/.github/settings.yml`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return { text: proc.stdout, where: `${repo}/.github/settings.yml` };
  if (proc.stderr.includes("HTTP 404")) return null;
  throw new Error(
    `${repo}/.github/settings.yml: fetch failed (${proc.stderr.trim().split("\n")[0]})`,
  );
}

/** Every layer folded low to high under the dialect above. */
export function mergeLayers(layers: Record<string, unknown>[]): Record<string, unknown> {
  return layers.reduce<Record<string, unknown>>(
    (below, layer) => mergeSettingsLayers(below, layer),
    {},
  );
}

/** The status check GitHub's Copilot code review reports. It must NEVER
 *  be a required status check: the check suite never appears in a pull
 *  request's merge-box rollup, so requiring the context leaves every PR
 *  permanently unmergeable. Kept here as the name loadOverrideLayer
 *  refuses, so the fleet cannot re-adopt it by accident. */
export const COPILOT_REVIEW_CONTEXT = "copilot-pull-request-reviewer";

/** The fleet-mandatory top layer: merged ABOVE the repository's own
 *  settings.yml, so no repository can weaken what it declares - including
 *  by nulling the key out, since the null opt-out only strips keys from
 *  the layers BELOW this one.
 *
 *  Validated here, the one place every consumer goes through, against the
 *  one required-check mistake that bricks the whole fleet (see
 *  COPILOT_REVIEW_CONTEXT). */
export function loadOverrideLayer(path: string = OVERRIDE_PATH): Record<string, unknown> {
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
  const contexts = Array.isArray(checksParams.required_status_checks)
    ? checksParams.required_status_checks.map((entry) =>
        isMapping(entry) ? entry.context : undefined,
      )
    : [];
  if (contexts.includes(COPILOT_REVIEW_CONTEXT)) {
    throw new Error(
      `${path}: the 'main' ruleset must not require the ${COPILOT_REVIEW_CONTEXT} status ` +
        "check - Copilot's check suite never reaches a pull request's merge-box rollup, so " +
        "the context is never reported and every pull request stays unmergeable. Wait for " +
        "Copilot's review with a bridge job inside the all-green gate instead.",
    );
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
  | { kind: "merged"; document: Record<string, unknown>; warnings: string[] };

export function mergeOutcome(
  managed: Record<string, unknown>,
  repoLayer: RepoLayer | null,
  source: string,
  override: Record<string, unknown> = loadOverrideLayer(),
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

function main(args: string[]): void {
  const flags = parseFlags(
    args,
    ["--managed", "--out"] as const,
    ["--repo-file", "--repo-fetch"] as const,
  );
  const fileSource = flags["--repo-file"];
  const fetchSource = flags["--repo-fetch"];
  if (fileSource !== undefined && fetchSource !== undefined) {
    fail("--repo-file and --repo-fetch are mutually exclusive - pass one repo-layer source");
  }
  if (fileSource === undefined && fetchSource === undefined) {
    fail("pass a repo-layer source: --repo-file <path> or --repo-fetch <owner/name>");
  }
  try {
    const managed = parseSettingsDoc(readFileSync(flags["--managed"], "utf-8"), flags["--managed"]);
    const repoLayer =
      fileSource !== undefined
        ? existsSync(fileSource)
          ? { text: readFileSync(fileSource, "utf-8"), where: fileSource }
          : null
        : fetchRepoLayer(fetchSource as string);
    const outcome = mergeOutcome(managed, repoLayer, fileSource ?? (fetchSource as string));
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
