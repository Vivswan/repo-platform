#!/usr/bin/env bun
// One-time settings.yml transition for the layering model (docs/
// settings.md): repos generated before it carry the full old baseline in
// a settings.yml whose header declares the retired "mergeable" class, and
// under the layering dialect every key there would shadow the centrally
// computed managed layer forever. This step REPLACES such a file with the
// freshly rendered identity starter (the settings-sync template, seeded
// from the old file's own declared description, homepage, topics, and
// visibility - the state the nightly heal enforced - with the post-update
// recorded answers as the fallback, plus everything the apply would
// otherwise DESTROY - the repo-local labels it deletes as undeclared and
// the ruleset rules its whole-payload PUT removes), diffs the OLD
// file's declarations against the computed managed layer, and writes the
// dropped deliberate overrides to $RUNNER_TEMP/settings-layering.md -
// open_pr.ts appends that section and holds the PR for review so wanted
// overrides can be re-added before merging.
//
// One-time by construction: the legacy `# repo-platform:mergeable` marker
// line is the trigger, and the rendered starter does not carry it -
// hand-written settings.yml files (no marker) and already-transitioned
// starters are never touched, and _skip_if_exists keeps copier off the
// file on every later sync. Runs only while the repo selects the
// settings-sync module (the managed layer exists only then).
//
// Invoked by preserve_repo_owned.ts (the sync step that already owns
// settings.yml handling), fail-soft: a failed transition warns and leaves
// the old file in place rather than breaking the sync - the next sync
// retries (the marker is still there).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadManifests } from "../../../scripts/module_manifests.ts";
import { loadOverrideLayer, mergeSettingsLayers } from "../fleet/merge_settings_layers.ts";
import {
  factsFromTargetDir,
  managedSettings,
  modulesFrom,
} from "../fleet/render_managed_settings.ts";
import { parseYamlMapping } from "../fleet/settings_document.ts";
import { hideDetails, notice, warning } from "../shared/gha.ts";
import { hasDuplicateJsonKeys } from "../shared/json.ts";
import { capture } from "../shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const STARTER_TEMPLATE = join(REPO_ROOT, "templates/settings-sync/.github/settings.yml.jinja");

/** The retired mergeable class's declaration line: every settings.yml the
 *  old template rendered carries it, and nothing renders it anymore, so
 *  its presence IS the "legacy baseline file" signal (the constant left
 *  scripts/ownership.ts with the class; this literal is the transition's
 *  own anchor). Matched EXACTLY and at column 0, so an indented mention -
 *  inside a block scalar of a hand-written file, say - never triggers the
 *  replacement. */
export const LEGACY_MERGEABLE_LINE = "# repo-platform:mergeable";
/** The retired class name, as the pre-update manifest spells it. */
export const RETIRED_MERGEABLE_CLASS = "mergeable";
const MANIFEST_PATH = ".github/repo-platform-manifest.json";

/** The PRE-update ownership manifest's class for settings.yml, read from
 *  the target's HEAD because the working tree may already carry this
 *  update's render. Repos were historically allowed to DELETE the
 *  mergeable marker line, so the marker alone is not a complete trigger.
 *  UNREADABLE is its own answer: folded into "no entry", a marker-deleted
 *  legacy file would read as a transitioned starter and auto-merge. */
export type HeadManifestClass =
  | { kind: "read"; class: string | null }
  | { kind: "unreadable"; detail: string };

/** The classes a manifest entry may carry: today's three, plus the
 *  retired one this transition exists to catch. A present entry spelling
 *  anything else is a manifest this code does not understand, and reading
 *  "not mergeable, therefore starter" out of it would be the same silent
 *  misclassification as an unreadable file. */
const KNOWN_CLASSES = new Set(["managed", "split", "starter", RETIRED_MERGEABLE_CLASS]);

export function headManifestClass(
  targetDir: string,
  path = ".github/settings.yml",
): HeadManifestClass {
  const proc = capture(["git", "-C", targetDir, "show", `HEAD:${MANIFEST_PATH}`]);
  if (proc.exitCode !== 0) {
    return { kind: "unreadable", detail: `git show HEAD:${MANIFEST_PATH} failed` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch {
    return { kind: "unreadable", detail: `HEAD:${MANIFEST_PATH} is not readable JSON` };
  }
  // Valid JSON is not a valid manifest. `{"files": []}` or a missing
  // files map yields no entry for the path, and reading that as "never
  // rendered from the template" would skip the transition on a
  // marker-deleted legacy baseline - the exact silent case this exists to
  // catch. Only a well-formed manifest may answer.
  const isMapping = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const unreadable = (why: string): HeadManifestClass => ({
    kind: "unreadable",
    detail: `HEAD:${MANIFEST_PATH} ${why}`,
  });
  if (!isMapping(parsed)) return unreadable("is not a JSON object");
  // Last-wins duplicates could read a mergeable-then-starter settings.yml
  // entry as already transitioned and skip the transition unseen;
  // unreadable holds the PR unless the marker still proves the shape.
  if (hasDuplicateJsonKeys(proc.stdout)) {
    return unreadable("declares the same key twice (JSON.parse keeps only the last duplicate)");
  }
  if (!isMapping(parsed.files)) return unreadable("has no files map");
  const entry = parsed.files[path];
  // No entry is an answer: the file was not rendered from the template at
  // HEAD, so it is not a legacy baseline. A malformed one is not.
  if (entry === undefined) return { kind: "read", class: null };
  if (!isMapping(entry)) return unreadable(`entry for ${path} is not an object`);
  if (typeof entry.class !== "string" || !KNOWN_CLASSES.has(entry.class)) {
    return unreadable(
      `classes ${path} as ${JSON.stringify(entry.class)}, which is not an ownership class this sync knows`,
    );
  }
  return { kind: "read", class: entry.class };
}

/** Whether a settings.yml text is the legacy rendered baseline. Scans the
 *  WHOLE file: a repo that kept its own header comments above the
 *  rendered ones pushes the marker past any fixed window, and a legacy
 *  file mistaken for a starter is the silent failure - the transition
 *  skips, the file keeps shadowing the fleet layers, and the sync PR
 *  auto-merges because nothing held it. Column 0 is what keeps the exact
 *  match honest, not proximity to the top. */
export function isLegacyBaseline(text: string, headClass: string | null = null): boolean {
  if (headClass === RETIRED_MERGEABLE_CLASS) return true;
  return text.split("\n").some((line) => line === LEGACY_MERGEABLE_LINE);
}

/** A file with no marker AND no readable manifest cannot be classified.
 *  Guessing "starter" is the silent failure; the caller holds the PR. */
export function classificationUncertain(text: string, head: HeadManifestClass): boolean {
  if (head.kind === "read") return false;
  return !text.split("\n").some((line) => line === LEGACY_MERGEABLE_LINE);
}

// Each identity value has three states, and they mean different things:
// a VALUE seeds the key, undefined OMITS it (nothing ever managed it, so
// declaring "" would declare-and-clear a live value), and null RENDERS as
// null (the old file explicitly opted out of managing that field, and the
// null opt-out in the merge dialect is how that intent survives).
export interface IdentitySeed {
  description?: string | null;
  /** GitHub serves topics as a string in the old renders but tolerates a
   *  string list; a hand-edited list must survive the transition. */
  topics?: string | string[] | null;
  homepage?: string | null;
  private?: boolean | null;
  /** The owner named in the starter's header comment. */
  githubUsername: string;
}

/** Render the settings-sync starter template with an identity seed. The
 *  starter's jinja surface is validated FIRST - the template stripped of
 *  the known identity expressions must carry no jinja at all - so a
 *  template that grew a construct this renderer does not know throws
 *  before anything is substituted. An undefined optional value drops its
 *  whole line. Dropping ALL FOUR is meaningful, not degenerate: the
 *  block then renders as bare `repository:`, which YAML reads as null -
 *  exactly the "do not manage this section" the legacy file declared.
 *
 *  Substitution is a single pass over the template so a seed VALUE can
 *  never be re-read as a template expression, and a template line
 *  carrying two identity expressions is rejected rather than trusted. */
export function renderStarter(templateText: string, seed: IdentitySeed): string {
  const identityRe = /\{\{ (description|homepage|topics|private) \| tojson \}\}/g;
  const stripped = templateText.replace(identityRe, "").replaceAll("{{ github_username }}", "");
  if (stripped.includes("{{") || stripped.includes("{%") || stripped.includes("{#")) {
    throw new Error(
      "the settings-sync starter template carries jinja beyond the identity " +
        "expressions - teach settings_layering.ts's renderStarter the new construct",
    );
  }
  const values: Record<string, string | string[] | boolean | null | undefined> = {
    description: seed.description,
    homepage: seed.homepage,
    topics: seed.topics,
    private: seed.private,
  };
  // Enforced, not just documented: an undefined value drops its whole
  // LINE, so two identity expressions on one line would make one key's
  // absence delete the other key's declaration.
  const lines = templateText.split("\n");
  for (const line of lines) {
    const names = [...line.matchAll(identityRe)];
    if (names.length > 1) {
      throw new Error(
        "the settings-sync starter template puts two identity expressions on one line " +
          `(${names.map((m) => m[1]).join(", ")}) - renderStarter drops an undefined value ` +
          "by line, so they must each have their own",
      );
    }
  }
  const kept = lines.filter((line) => {
    const match = /\{\{ (description|homepage|topics|private) \| tojson \}\}/.exec(line);
    return match === null || values[match[1]] !== undefined;
  });
  // ONE pass over the template text, identity expressions and the owner
  // name together: String.replace never rescans what it substituted, so a
  // seed VALUE that happens to look like another expression is emitted
  // verbatim instead of being re-interpreted by a later pass.
  const allRe =
    /\{\{ (description|homepage|topics|private) \| tojson \}\}|\{\{ github_username \}\}/g;
  return kept.join("\n").replace(allRe, (_match, name?: string) =>
    // JSON is valid YAML for a list too, so an array seed round-trips.
    name === undefined ? seed.githubUsername : JSON.stringify(values[name]),
  );
}

/** JSON with recursively sorted object keys, for order-insensitive
 *  deep equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IDENTITY_KEYS = new Set(["description", "homepage", "topics", "private"]);

/** A ruleset entry's rules keyed by type, first occurrence winning - the
 *  same identity the merge dialect appends by. */
function rulesByType(entry: unknown): Map<string, unknown> {
  const byType = new Map<string, unknown>();
  if (isMapping(entry) && Array.isArray(entry.rules)) {
    for (const rule of entry.rules) {
      if (isMapping(rule) && typeof rule.type === "string" && !byType.has(rule.type)) {
        byType.set(rule.type, rule);
      }
    }
  }
  return byType;
}

function entriesByName(section: unknown, fold: (name: string) => string): Map<string, unknown> {
  const byName = new Map<string, unknown>();
  for (const entry of Array.isArray(section) ? section : []) {
    if (isMapping(entry) && typeof entry.name === "string" && !byName.has(fold(entry.name))) {
      byName.set(fold(entry.name), entry);
    }
  }
  return byName;
}

/** Every explicit `null` the old file declares in a section the STARTER
 *  does not itself emit, as a document declaring only those nulls. A null
 *  is the dialect's "do not manage this" and the apply had been honouring
 *  it, so dropping one re-arms management over whatever is live there -
 *  `labels: null` re-arms delete-undeclared, `rulesets: null` starts
 *  declaring the module layers' rulesets. Walking for them beats
 *  enumerating the sections that happen to have one today.
 *
 *  `repository` is excluded because the starter renders that block
 *  itself: a carried copy would emit a SECOND top-level `repository:`
 *  key. Its identity nulls already ride through the seed (renderStarter),
 *  and its other opt-outs are reported as drops, marked as opt-outs so
 *  the reviewer re-adds the ones that were deliberate.
 *
 *  Entries of the name-keyed sections keep their `name`, so the null
 *  lands back on the entry it came from. */
function nullOptOuts(value: unknown): Record<string, unknown> | undefined {
  if (!isMapping(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "repository") continue;
    if (child === null) {
      out[key] = null;
      continue;
    }
    if (key === "labels" || key === "rulesets") {
      if (!Array.isArray(child)) continue;
      const entries: Record<string, unknown>[] = [];
      for (const entry of child) {
        const inner = nullOptOuts(entry);
        if (inner === undefined) continue;
        if (!isMapping(entry) || typeof entry.name !== "string") continue;
        entries.push({ name: entry.name, ...inner });
      }
      if (entries.length > 0) out[key] = entries;
      continue;
    }
    const inner = nullOptOuts(child);
    if (inner !== undefined) out[key] = inner;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** What the replacement takes WITH it, as opposed to what it reports.
 *  The line is drawn at live-state change the repo did not ask for: a
 *  declaration whose absence from the new file makes the next apply
 *  delete, narrow, or start managing something live is carried, and
 *  everything else is reported for the reviewer to re-add deliberately.
 *
 *  - `optOuts`: every explicit null, at any depth (see nullOptOuts).
 *  - `labels`: names no fleet layer supplies, which delete-undeclared
 *    removes. A name the fleet DOES supply is never carried - the fleet
 *    entry keeps that label alive, and a copy would only shadow it - so
 *    a restyle of a fleet label stays a reported drop.
 *  - `rulesets`: for a ruleset the fleet also declares, the rule TYPES
 *    the old file added. The apply PUTs a declared ruleset whole, so a
 *    type the merged document omits leaves the live ruleset. A type the
 *    fleet already supplies is not carried (same reasoning as a label
 *    name), and a repo-only RULESET is not carried at all: the apply
 *    never deletes an undeclared ruleset, so its live protection
 *    survives.
 *
 *  ONE computation, read by the writer AND by droppedOverrides, so the
 *  file and the report can never disagree about which is which. */
export interface StarterCarry {
  optOuts: Record<string, unknown>;
  labels: Record<string, unknown>[];
  rulesets: Record<string, unknown>[];
}

const foldLabel = (name: string) => name.toLowerCase();
const foldRuleset = (name: string) => name;

export function starterCarry(
  old: Record<string, unknown>,
  fleet: Record<string, unknown>,
  override: Record<string, unknown> = {},
): StarterCarry {
  const carry: StarterCarry = { optOuts: nullOptOuts(old) ?? {}, labels: [], rulesets: [] };

  const suppliedLabels = entriesByName(fleet.labels, foldLabel);
  const takenLabels = new Set<string>();
  for (const entry of Array.isArray(old.labels) ? old.labels : []) {
    if (!isMapping(entry) || typeof entry.name !== "string") continue;
    const folded = foldLabel(entry.name);
    if (suppliedLabels.has(folded) || takenLabels.has(folded)) continue;
    takenLabels.add(folded);
    carry.labels.push(entry);
  }

  const fleetRulesets = entriesByName(fleet.rulesets, foldRuleset);
  const overrideRulesets = entriesByName(override.rulesets, foldRuleset);
  const takenRulesets = new Set<string>();
  for (const entry of Array.isArray(old.rulesets) ? old.rulesets : []) {
    if (!isMapping(entry) || typeof entry.name !== "string") continue;
    const name = entry.name;
    const fleetEntry = fleetRulesets.get(name);
    if (fleetEntry === undefined || takenRulesets.has(name)) continue;
    takenRulesets.add(name);
    const supplied = rulesByType(fleetEntry);
    const unbeatable = rulesByType(overrideRulesets.get(name));
    const rules = [...rulesByType(entry)]
      .filter(([type]) => !supplied.has(type) && !unbeatable.has(type))
      .map(([, rule]) => rule);
    if (rules.length > 0) carry.rulesets.push({ name, rules });
  }
  return carry;
}

/** The carry as one settings document: the opt-out skeleton with the
 *  carried entries folded into its name-keyed sections. An opt-out at
 *  section level (`labels: null`) stands alone - there is nothing to
 *  carry under a section the repo took out of management. */
export function carryDocument(carry: StarterCarry): Record<string, unknown> {
  const document: Record<string, unknown> = { ...carry.optOuts };
  const fold = (section: "labels" | "rulesets", entries: Record<string, unknown>[]) => {
    if (document[section] === null || entries.length === 0) return;
    const key = section === "labels" ? foldLabel : foldRuleset;
    const skeleton = entriesByName(document[section], key);
    const merged = entries.map((entry) => {
      const inner = skeleton.get(key(String(entry.name)));
      skeleton.delete(key(String(entry.name)));
      return isMapping(inner) ? { ...inner, ...entry } : entry;
    });
    document[section] = [...skeleton.values(), ...merged];
  };
  fold("labels", carry.labels);
  fold("rulesets", carry.rulesets);
  return document;
}

/** The rendered starter with the carried declarations appended as real
 *  sections - the template ships only commented examples. APPENDED
 *  rather than spliced into those examples: top-level key order carries
 *  no meaning in YAML, and an anchor in the template would be one more
 *  pair to keep in sync. */
export function withCarriedDeclarations(starter: string, carry: StarterCarry): string {
  const document = carryDocument(carry);
  if (Object.keys(document).length === 0) return starter;
  return (
    `${starter.replace(/\n*$/, "\n")}\n` +
    "# Carried from this repository's own previous settings.yml: what the\n" +
    "# apply would otherwise change under it - it deletes undeclared labels\n" +
    "# and PUTs a declared ruleset whole, and a null is this repo's own\n" +
    "# opt-out from managing that key.\n" +
    stringifyYaml(document)
  );
}

/** The old file's declarations the replacement DROPS: everything that is
 *  neither carried into the new starter (the repository identity keys)
 *  nor byte-equal to the computed managed layer (the baseline supplies
 *  those). What remains is deliberate overrides and repo-only content -
 *  the list the reviewer re-adds from. Labels and rulesets compare per
 *  same-name entry (labels fold case, like the merge dialect). */
export function droppedOverrides(
  old: Record<string, unknown>,
  managed: Record<string, unknown>,
  override: Record<string, unknown> = {},
): string[] {
  const dropped: string[] = [];
  const classify = (key: string, oldValue: unknown, managedValue: unknown) => {
    if (managedValue === undefined || canonical(oldValue) !== canonical(managedValue)) {
      dropped.push(key);
    }
  };
  // Anything the OVERRIDE layer declares is unbeatable from a repo file,
  // whatever the old file said about it. Listing it would tell the
  // reviewer to re-add fleet law as config that cannot take effect, so it
  // is skipped outright rather than compared.
  const overrideDeclaresChild = (key: string, child: string) => {
    const section = override[key];
    return isMapping(section) && child in section;
  };
  const overrideEntry = (key: string, name: string, fold: (n: string) => string) => {
    const section = override[key];
    if (!Array.isArray(section)) return undefined;
    return section.find(
      (entry) =>
        isMapping(entry) && typeof entry.name === "string" && fold(entry.name) === fold(name),
    );
  };
  // The carry decides what is NOT a drop: read here rather than
  // re-derived, so the report and the written file cannot disagree.
  const carry = starterCarry(old, managed, override);
  const carriedLabelNames = new Set(carry.labels.map((entry) => foldLabel(String(entry.name))));
  const carriedRuleTypes = new Map(
    carry.rulesets.map((entry) => [String(entry.name), new Set(rulesByType(entry).keys())]),
  );
  for (const [key, oldValue] of Object.entries(old)) {
    const managedValue = managed[key];
    // A null section is the dialect's opt-out and rides into the starter
    // verbatim (starterCarry's optOuts), so it is never a drop.
    if (oldValue === null && key !== "repository") continue;
    // A mis-shaped labels/rulesets section (a mapping or scalar where the
    // dialect wants a list) is a LEGACY-file reality this report must
    // describe, never skip: legacy files are exactly where mis-shapes
    // live, and the per-entry comparison below - and the `key in override`
    // fleet-law skip after it - both assume the list shape, so falling
    // through would silently omit the section from the very list the
    // reviewer re-adds overrides from. Reported as-is with a shape
    // warning; the go-forward parse boundary refuses new mis-shapes.
    if ((key === "labels" || key === "rulesets") && !Array.isArray(oldValue)) {
      const shape = oldValue === null ? "null" : typeof oldValue;
      const rendered = canonical(oldValue);
      const excerpt = rendered.length > 200 ? `${rendered.slice(0, 200)}...` : rendered;
      dropped.push(
        `${key} (mis-shaped: a ${shape} where the settings dialect wants a list, so nothing ` +
          `could be compared or carried - re-add valid entries by hand): ${excerpt}`,
      );
      continue;
    }
    if (isMapping(oldValue) && isMapping(managedValue)) {
      for (const [child, childValue] of Object.entries(oldValue)) {
        if (key === "repository" && IDENTITY_KEYS.has(child)) continue; // carried by the seed
        if (overrideDeclaresChild(key, child)) continue; // fleet law
        // The starter renders the whole `repository` block, so an opt-out
        // there cannot be carried without emitting a second one. Reported
        // AS an opt-out, so the reviewer re-adds the deliberate ones.
        if (childValue === null) {
          dropped.push(`${key}.${child}: null (an opt-out from managing this key)`);
          continue;
        }
        classify(`${key}.${child}`, childValue, managedValue[child]);
      }
      continue;
    }
    if ((key === "labels" || key === "rulesets") && Array.isArray(oldValue)) {
      const fold = key === "labels" ? foldLabel : foldRuleset;
      const managedByName = entriesByName(managedValue, fold);
      for (const entry of oldValue) {
        const name = isMapping(entry) && typeof entry.name === "string" ? entry.name : null;
        if (name === null) {
          dropped.push(`${key} (a nameless entry)`);
          continue;
        }
        if (key === "labels" && carriedLabelNames.has(fold(name))) continue; // carried
        const fleetEntry = managedByName.get(fold(name));
        // A ruleset the fleet also declares: its RULES are settled by the
        // carry (a type the fleet does not supply rides into the starter,
        // because the apply's whole-payload PUT would drop it from the
        // live ruleset), so the only rules left to REPORT are the types
        // the fleet supplies with different parameters - the repo's
        // version loses to fleet policy, and re-adding it is the
        // reviewer's deliberate call. A type the override declares is
        // silent either way: no repo file can beat it.
        if (key === "rulesets" && fleetEntry !== undefined) {
          const carriedTypes = carriedRuleTypes.get(name) ?? new Set<string>();
          const unbeatable = new Set(rulesByType(overrideEntry(key, name, fold)).keys());
          const fleetRules = rulesByType(fleetEntry);
          for (const [type, rule] of rulesByType(entry)) {
            if (unbeatable.has(type) || carriedTypes.has(type)) continue;
            const supplied = fleetRules.get(type);
            if (supplied !== undefined && canonical(supplied) === canonical(rule)) continue;
            dropped.push(
              `${key} ${JSON.stringify(name)}: rule ${JSON.stringify(type)} (the fleet supplies ` +
                "this rule type with different parameters, and the fleet layers win)",
            );
          }
          // The entry itself: fleet law when the override declares it, so
          // listing it would tell the reviewer to re-add config that
          // cannot take effect. Otherwise its remaining fields compare
          // ONE BY ONE over what the OLD file declared, like the
          // repository arm - a whole-entry compare would report every
          // field the fleet adds and the old file never had.
          if (overrideEntry(key, name, fold) === undefined) {
            for (const [field, value] of Object.entries(entry)) {
              // name identifies the entry; rules and the entry's null
              // opt-outs are already carried.
              if (field === "name" || field === "rules" || value === null) continue;
              classify(
                `${key} ${JSON.stringify(name)}: ${field}`,
                value,
                (fleetEntry as Record<string, unknown>)[field],
              );
            }
          }
          continue;
        }
        // Anything the OVERRIDE declares by name is fleet law and cannot
        // be re-added from a repo file.
        if (overrideEntry(key, name, fold) !== undefined) continue;
        classify(`${key} ${JSON.stringify(name)}`, entry, fleetEntry);
      }
      continue;
    }
    if (key in override) continue; // fleet law
    classify(key, oldValue, managedValue);
  }
  return dropped;
}

/** The carry document as reviewer-readable paths, one per thing that
 *  moved: `labels: null`, `labels "provider"`, `rulesets "main": rule
 *  "required_signatures"`. Derived from the document the file is written
 *  from, so the PR body can never name something the file does not carry. */
export function carriedPaths(document: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(document)) {
    if (value === null) {
      paths.push(`${key}: null`);
      continue;
    }
    if ((key === "labels" || key === "rulesets") && Array.isArray(value)) {
      for (const entry of value) {
        if (!isMapping(entry)) continue;
        const where = `${key} ${JSON.stringify(String(entry.name))}`;
        const nulls = Object.entries(entry).filter(([, field]) => field === null);
        // A ruleset rides as its RULE TYPES (the whole entry is never
        // carried - the fleet declares it); a label rides whole.
        const types = [...rulesByType(entry).keys()];
        for (const type of types) paths.push(`${where}: rule ${JSON.stringify(type)}`);
        for (const [field] of nulls) paths.push(`${where}: ${field}: null`);
        if (types.length === 0 && nulls.length === 0) paths.push(where);
      }
      continue;
    }
    if (isMapping(value)) {
      for (const [child, childValue] of Object.entries(value)) {
        paths.push(childValue === null ? `${key}.${child}: null` : `${key}.${child}`);
      }
      continue;
    }
    paths.push(key);
  }
  return paths;
}

/** The PR-body section: empty when the replacement dropped nothing (a
 *  lossless transition needs no review). `carried` names what the starter
 *  took with it, so the reviewer sees what moved and not only what went. */
export function layeringSummary(dropped: string[], carried: string[] = []): string {
  const carriedLine =
    carried.length === 0
      ? ""
      : `\nCARRIED into the new file, because the apply would otherwise destroy them: ${carried.map((name) => `\`${name}\``).join(", ")}.\n`;
  if (dropped.length === 0) {
    return `### settings.yml layering transition

This update REPLACED \`.github/settings.yml\` with the identity starter: the fleet's own settings are merged centrally per repository now and this file layers over them (see repo-platform's docs/settings.md), so the old baseline copy had to go. Nothing was dropped - every declaration in the old file was either carried over or something the fleet layers already supply.
${carriedLine}
The file changed owner, which is why this PR is held for review rather than merging itself: check that the new starter says what you want before merging.
`;
  }
  return `### settings.yml layering transition

This update REPLACED \`.github/settings.yml\` with the identity starter: the managed settings baseline (policy block, module labels, fleet rulesets) is now computed centrally per repository and this file merges OVER it (see repo-platform's docs/settings.md), so the old baseline copy had to go. The identity keys and the repo-local labels were carried over, and baseline-equal declarations are supplied by the managed layer - but these old declarations DIFFER from the baseline and were dropped:

${dropped.map((key) => `- ${key}`).join("\n")}
${carriedLine}
Re-add any of them that are deliberate overrides to the new settings.yml on this branch before merging (the old file is on the base branch); leave dropped anything that was just a stale baseline copy.
`;
}

/** The PR-body section when settings.yml cannot be classified: no marker
 *  and no readable pre-update manifest. Non-empty so open_pr.ts holds the
 *  PR - guessing wrong here is silent and permanent. */
export function uncertainSummary(detail: string): string {
  return `### settings.yml could not be classified

This repository's \`.github/settings.yml\` carries no \`# repo-platform:mergeable\` marker, and the pre-update ownership manifest could not be read (${detail}), so this sync cannot tell whether the file is a legacy full baseline awaiting the one-time transition or an identity starter that has already been through it.

Nothing was changed. This PR is held for review: if the file is still the old full baseline, it is shadowing the centrally merged settings layers and the transition needs to run; if it is already a starter, this PR is safe to merge as-is.
`;
}

/** The PR-body section for a transition that threw. Non-empty on
 *  purpose: a failed transition leaves the legacy baseline file in place,
 *  still shadowing the managed layer, and open_pr.ts arms auto-merge
 *  whenever every review-forcing section is empty. Reporting the failure
 *  here is what keeps an un-transitioned repository from merging its sync
 *  PR unseen. */
export function failureSummary(detail: string): string {
  return `### settings.yml layering transition FAILED

The one-time replacement of \`.github/settings.yml\` with the identity starter did not run (${detail}), so this repository still carries the legacy baseline copy. Under the layering model every key in that file shadows the centrally computed managed layer (see repo-platform's docs/settings.md), so the repository does not receive baseline updates until the transition succeeds.

This PR is held for review because of that. Merging it is safe - it changes nothing about settings.yml - but the next sync retries the transition, and a transition that keeps failing needs a human to look at the sync run's warning.
`;
}

/** Run the one-time transition for a synced target; writes the PR-body
 *  section (empty only when no transition was needed and nothing was
 *  dropped). Fail-soft by contract (see the header). */
export function transitionSettingsStarter(
  targetDir: string,
  outPath: string,
  label: string,
  starterTemplatePath: string = STARTER_TEMPLATE,
): void {
  let section = "";
  try {
    const settingsPath = join(targetDir, ".github/settings.yml");
    const registrationPath = join(targetDir, ".repo-platform.yml");
    if (existsSync(settingsPath) && existsSync(registrationPath)) {
      const oldText = readFileSync(settingsPath, "utf-8");
      const head = headManifestClass(targetDir);
      if (classificationUncertain(oldText, head)) {
        // Cannot tell a legacy baseline from a transitioned starter, and
        // the wrong guess leaves a stale file shadowing the fleet layers
        // with nothing to notice. Hold the PR and say so. The detail can
        // embed target-controlled manifest content (headManifestClass
        // quotes an unknown class value), so a hidden target's WARNING -
        // which lands in the public sync log - keeps only the fact; the
        // full detail still reaches the PR body below, which lives in the
        // private repo (the same guard as the catch at the end of this
        // function).
        const detail = head.kind === "unreadable" ? head.detail : "unknown";
        warning(
          `${label}: settings.yml could not be classified (${
            hideDetails() ? "detail hidden: private repository" : detail
          }); the PR is held for review.`,
        );
        section = uncertainSummary(detail);
        writeFileSync(outPath, section);
        return;
      }
      const modules = isLegacyBaseline(oldText, head.kind === "read" ? head.class : null)
        ? modulesFrom(readFileSync(registrationPath, "utf-8"), registrationPath)
        : [];
      if (modules.includes("settings-sync")) {
        const manifests = loadManifests();
        const facts = factsFromTargetDir(targetDir, manifests);
        // The OLD file is read LENIENTLY, never through the settings parse
        // boundary (settings_document.ts's parseSettingsDoc): describing
        // legacy files is this transition's whole job, and legacy files
        // are exactly where mis-shaped sections live - a schema refusal
        // here would loop the fail-soft retry forever while the mis-shaped
        // section never reached the dropped-overrides list the reviewer
        // works from. droppedOverrides validates shapes itself and REPORTS
        // a mis-shaped labels/rulesets section with a shape warning. An
        // empty or comment-only document declares nothing; unreadable YAML
        // still fails soft via the outer catch. logLevel error: default
        // warnings print source lines to stderr past the hide-details
        // handling.
        const parsedOld = parseYaml(oldText, { logLevel: "error" }) as unknown;
        if (parsedOld !== null && parsedOld !== undefined && !isMapping(parsedOld)) {
          throw new Error(`${settingsPath}: not a YAML mapping`);
        }
        const old = (parsedOld ?? {}) as Record<string, unknown>;
        // A section-level null is a declaration, not an absence: the repo
        // took its whole identity block out of management and the heal
        // was honouring that. Seeding from the recorded answers here
        // would silently start managing every one of those fields again.
        const repositoryOptedOut = "repository" in old && old.repository === null;
        const oldRepository = isMapping(old.repository) ? old.repository : {};
        // description/homepage/topics: the old file's own declarations,
        // the state the nightly heal enforced, with the post-update
        // recorded answers as the fallback. private: facts.private, the
        // same declared-over-recorded precedence the apply paths use
        // (factsFromTargetDir reads the old file's declaration first).
        // The answers file is a plain YAML MAPPING, not a settings
        // document - parseYamlMapping carries the same diagnostics
        // without imposing the layer schema on copier's answer keys.
        const answers = parseYamlMapping(
          readFileSync(join(targetDir, ".copier-answers.yml"), "utf-8"),
          join(targetDir, ".copier-answers.yml"),
        );
        const isTopics = (value: unknown): value is string | string[] =>
          typeof value === "string" ||
          (Array.isArray(value) && value.every((t) => typeof t === "string"));
        // Presence, not just type: a key the old file DECLARED as null is
        // a deliberate opt-out ("do not manage this"), and the nightly
        // heal had been honouring it. Falling back to the recorded answer
        // there would quietly start managing a field the repo had taken
        // out of management, so the null declaration is carried into the
        // starter as-is. Only an ABSENT key falls back.
        const seedKey = <T>(key: string, accept: (v: unknown) => v is T): T | null | undefined => {
          if (key in oldRepository) {
            const declared = oldRepository[key];
            if (declared === null) return null;
            if (accept(declared)) return declared;
          }
          const recorded = answers[key];
          return accept(recorded) ? recorded : undefined;
        };
        const isString = (value: unknown): value is string => typeof value === "string";
        // The header comment names the owner; shape-checked like the
        // license re-seed's owner pin (a malformed value would render a
        // wrong owner into a repo-owned file).
        const username = answers.github_username;
        if (typeof username !== "string" || !/^[A-Za-z0-9-]+$/.test(username)) {
          throw new Error(
            ".copier-answers.yml records no github_username - the starter's header cannot be seeded",
          );
        }
        const seed: IdentitySeed = repositoryOptedOut
          ? { githubUsername: username }
          : {
              // Declared wins, recorded answer only when undeclared - the
              // same precedence as homepage/topics/private below. Seeding
              // from the live answer instead would silently drop a declared
              // description, and droppedOverrides never reports it (the
              // identity keys are exempt there as "carried"). Undefined when
              // NEITHER source declares one: the starter then omits the key
              // rather than declare-and-clear a live description nothing ever
              // managed.
              description: seedKey("description", isString),
              // undefined when neither source declares the key: the starter
              // then omits it rather than declare-and-clear a live value
              // nothing ever managed.
              homepage: seedKey("homepage", isString),
              topics: seedKey("topics", isTopics),
              // Same rule for visibility: a declared null means the repo took
              // visibility out of management, so facts.private (which falls
              // back to the recorded answer) must not overwrite it.
              private: oldRepository.private === null ? null : facts.private,
              githubUsername: username,
            };
        // Everything is computed BEFORE the replacement is written: a
        // throw anywhere above leaves the old file (marker included)
        // untouched, so the fail-soft retry contract holds.
        const starter = renderStarter(readFileSync(starterTemplatePath, "utf-8"), seed);
        // The basis is EVERY fleet layer, override included: the merge
        // policy and the main/non-bypassable rulesets live in layer 6
        // now, and a legacy file declares all of them. Diffing against
        // layers 1-4 alone would report the whole of fleet law as
        // "dropped overrides" on every legacy repo, telling reviewers to
        // paste it back into a file that cannot win over it anyway.
        const override = loadOverrideLayer();
        const fleet = mergeSettingsLayers(managedSettings(facts, manifests), override);
        const dropped = droppedOverrides(old, fleet, override);
        const carry = starterCarry(old, fleet, override);
        const carriedNames = carriedPaths(carryDocument(carry));
        section = layeringSummary(dropped, carriedNames);
        writeFileSync(settingsPath, withCarriedDeclarations(starter, carry));
        notice(
          `${label}: replaced the legacy baseline .github/settings.yml with the identity starter ` +
            `(the fleet layers are merged centrally now)${
              carriedNames.length === 0 ? "" : `; carried ${carriedNames.length} declaration(s)`
            }${
              dropped.length === 0
                ? "; nothing else differed from the fleet layers, so nothing was dropped"
                : `; the PR body lists the ${dropped.length} dropped declaration(s)`
            }. The PR is held for review either way: the file changed owner.`,
        );
      }
    }
  } catch (error) {
    // The detail can quote target-repo content; a hidden target's warning
    // keeps only the error class.
    const detail = hideDetails()
      ? `${error instanceof Error ? error.constructor.name : "error"}; detail hidden: private repository`
      : error instanceof Error
        ? error.message.split("\n")[0]
        : String(error);
    warning(
      `${label}: the settings.yml layering transition failed (${detail}); the old file is left in place and the next sync retries.`,
    );
    section = failureSummary(detail);
  }
  writeFileSync(outPath, section);
}
