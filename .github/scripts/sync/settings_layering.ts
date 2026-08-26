#!/usr/bin/env bun
// One-time settings.yml transition for the layering model (docs/
// settings.md): repos generated before it carry the full old baseline in
// a settings.yml whose header declares the retired "mergeable" class, and
// under the layering dialect every key there would shadow the centrally
// computed managed layer forever. This step REPLACES such a file with the
// freshly rendered identity starter (the settings-sync template, seeded
// from the old file's own declared description, homepage, topics, and
// visibility - the state the nightly heal enforced - with the post-update
// recorded answers as the fallback), diffs the OLD file's declarations
// against the computed managed layer, and writes the dropped deliberate
// overrides to $RUNNER_TEMP/settings-layering.md - open_pr.ts appends
// that section and holds the PR for review so wanted overrides can be
// re-added before merging.
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
import { loadManifests } from "../../../scripts/module_manifests.ts";
import { parseSettingsDoc } from "../fleet/merge_settings_layers.ts";
import {
  factsFromTargetDir,
  managedSettings,
  modulesFrom,
} from "../fleet/render_managed_settings.ts";
import { hideDetails, notice, warning } from "../shared/gha.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const STARTER_TEMPLATE = join(REPO_ROOT, "templates/settings-sync/.github/settings.yml.jinja");

/** The retired mergeable class's declaration line: every settings.yml the
 *  old template rendered carries it, and nothing renders it anymore, so
 *  its presence IS the "legacy baseline file" signal (the constant left
 *  scripts/ownership.ts with the class; this literal is the transition's
 *  own anchor). Matched exactly, column 0, inside the header window the
 *  old class's classifier used - an indented mention (say, inside a block
 *  scalar of a hand-written file) must never trigger the replacement. */
export const LEGACY_MERGEABLE_LINE = "# repo-platform:mergeable";
const LEGACY_HEADER_WINDOW = 10;

/** Whether a settings.yml text is the legacy rendered baseline. */
export function isLegacyBaseline(text: string): boolean {
  return text.split("\n", LEGACY_HEADER_WINDOW).some((line) => line === LEGACY_MERGEABLE_LINE);
}

export interface IdentitySeed {
  /** undefined OMITS the key, like homepage/topics below: declaring ""
   *  would declare-and-clear a live description neither the old file nor
   *  the recorded answers ever managed. */
  description?: string;
  /** GitHub serves topics as a string in the old renders but tolerates a
   *  string list; a hand-edited list must survive the transition.
   *  undefined OMITS the key from the starter - declaring "" would
   *  declare-and-clear a live value neither the old file nor the recorded
   *  answers ever managed. Same for homepage. */
  topics?: string | string[];
  homepage?: string;
  private: boolean;
  /** The owner named in the starter's header comment. */
  githubUsername: string;
}

/** Render the settings-sync starter template with an identity seed. The
 *  starter's jinja surface is validated FIRST - the template stripped of
 *  the known identity expressions must carry no jinja at all - so a
 *  template that grew a construct this renderer does not know throws
 *  before anything is substituted. An undefined optional value drops its
 *  whole line; `private` is always defined, so the `repository:` block
 *  can never render empty however many optional keys are dropped.
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
  const values: Record<string, string | string[] | boolean | undefined> = {
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

/** The old file's declarations the replacement DROPS: everything that is
 *  neither carried into the new starter (the repository identity keys)
 *  nor byte-equal to the computed managed layer (the baseline supplies
 *  those). What remains is deliberate overrides and repo-only content -
 *  the list the reviewer re-adds from. Labels and rulesets compare per
 *  same-name entry (labels fold case, like the merge dialect). */
export function droppedOverrides(
  old: Record<string, unknown>,
  managed: Record<string, unknown>,
): string[] {
  const dropped: string[] = [];
  const classify = (key: string, oldValue: unknown, managedValue: unknown) => {
    if (managedValue === undefined || canonical(oldValue) !== canonical(managedValue)) {
      dropped.push(key);
    }
  };
  for (const [key, oldValue] of Object.entries(old)) {
    const managedValue = managed[key];
    if (isMapping(oldValue) && isMapping(managedValue)) {
      for (const [child, childValue] of Object.entries(oldValue)) {
        if (key === "repository" && IDENTITY_KEYS.has(child)) continue; // carried
        classify(`${key}.${child}`, childValue, managedValue[child]);
      }
      continue;
    }
    if ((key === "labels" || key === "rulesets") && Array.isArray(oldValue)) {
      const fold = (name: string) => (key === "labels" ? name.toLowerCase() : name);
      const managedByName = new Map<string, unknown>();
      for (const entry of Array.isArray(managedValue) ? managedValue : []) {
        if (isMapping(entry) && typeof entry.name === "string") {
          managedByName.set(fold(entry.name), entry);
        }
      }
      for (const entry of oldValue) {
        const name = isMapping(entry) && typeof entry.name === "string" ? entry.name : null;
        if (name === null) {
          dropped.push(`${key} (a nameless entry)`);
          continue;
        }
        classify(`${key} ${JSON.stringify(name)}`, entry, managedByName.get(fold(name)));
      }
      continue;
    }
    classify(key, oldValue, managedValue);
  }
  return dropped;
}

/** The PR-body section: empty when the replacement dropped nothing (a
 *  lossless transition needs no review). */
export function layeringSummary(dropped: string[]): string {
  if (dropped.length === 0) return "";
  return `### settings.yml layering transition

This update REPLACED \`.github/settings.yml\` with the identity starter: the managed settings baseline (policy block, module labels, fleet rulesets) is now computed centrally per repository and this file merges OVER it (see repo-platform's docs/settings.md), so the old baseline copy had to go. The identity keys were carried over, and baseline-equal declarations are supplied by the managed layer - but these old declarations DIFFER from the baseline and were dropped:

${dropped.map((key) => `- ${key}`).join("\n")}

Re-add any of them that are deliberate overrides to the new settings.yml on this branch before merging (the old file is on the base branch); leave dropped anything that was just a stale baseline copy.
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
      const modules = isLegacyBaseline(oldText)
        ? modulesFrom(readFileSync(registrationPath, "utf-8"), registrationPath)
        : [];
      if (modules.includes("settings-sync")) {
        const manifests = loadManifests();
        const facts = factsFromTargetDir(targetDir, manifests);
        const old = parseSettingsDoc(oldText, settingsPath);
        const oldRepository = isMapping(old.repository) ? old.repository : {};
        // description/homepage/topics: the old file's own declarations,
        // the state the nightly heal enforced, with the post-update
        // recorded answers as the fallback. private: facts.private, the
        // same declared-over-recorded precedence the apply paths use
        // (factsFromTargetDir reads the old file's declaration first).
        const answers = parseSettingsDoc(
          readFileSync(join(targetDir, ".copier-answers.yml"), "utf-8"),
          join(targetDir, ".copier-answers.yml"),
        );
        const str = (value: unknown, fallback: unknown) =>
          typeof value === "string" ? value : typeof fallback === "string" ? fallback : undefined;
        const isTopics = (value: unknown): value is string | string[] =>
          typeof value === "string" ||
          (Array.isArray(value) && value.every((t) => typeof t === "string"));
        // The header comment names the owner; shape-checked like the
        // license re-seed's owner pin (a malformed value would render a
        // wrong owner into a repo-owned file).
        const username = answers.github_username;
        if (typeof username !== "string" || !/^[A-Za-z0-9-]+$/.test(username)) {
          throw new Error(
            ".copier-answers.yml records no github_username - the starter's header cannot be seeded",
          );
        }
        const seed: IdentitySeed = {
          // Declared wins, recorded answer only when undeclared - the
          // same precedence as homepage/topics/private below. Seeding
          // from the live answer instead would silently drop a declared
          // description, and droppedOverrides never reports it (the
          // identity keys are exempt there as "carried"). Undefined when
          // NEITHER source declares one: the starter then omits the key
          // rather than declare-and-clear a live description nothing ever
          // managed.
          description: str(oldRepository.description, answers.description),
          // undefined when neither source declares the key: the starter
          // then omits it rather than declare-and-clear a live value
          // nothing ever managed.
          homepage: str(oldRepository.homepage, answers.homepage),
          topics: isTopics(oldRepository.topics)
            ? oldRepository.topics
            : str(answers.topics, undefined),
          private: facts.private,
          githubUsername: username,
        };
        // Everything is computed BEFORE the replacement is written: a
        // throw anywhere above leaves the old file (marker included)
        // untouched, so the fail-soft retry contract holds.
        const starter = renderStarter(readFileSync(starterTemplatePath, "utf-8"), seed);
        section = layeringSummary(droppedOverrides(old, managedSettings(facts, manifests)));
        writeFileSync(settingsPath, starter);
        notice(
          `${label}: replaced the legacy baseline .github/settings.yml with the identity starter ` +
            `(the managed baseline is computed centrally now)${
              section === ""
                ? "; nothing differed from the baseline, so nothing was dropped"
                : "; the PR body lists the dropped overrides"
            }.`,
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
