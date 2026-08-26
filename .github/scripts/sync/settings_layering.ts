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
import {
  loadOverrideLayer,
  mergeSettingsLayers,
  parseSettingsDoc,
} from "../fleet/merge_settings_layers.ts";
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
 *  own anchor). Matched EXACTLY and at column 0, so an indented mention -
 *  inside a block scalar of a hand-written file, say - never triggers the
 *  replacement. */
export const LEGACY_MERGEABLE_LINE = "# repo-platform:mergeable";

/** Whether a settings.yml text is the legacy rendered baseline. Scans the
 *  WHOLE file: a repo that kept its own header comments above the
 *  rendered ones pushes the marker past any fixed window, and a legacy
 *  file mistaken for a starter is the silent failure - the transition
 *  skips, the file keeps shadowing the fleet layers, and the sync PR
 *  auto-merges because nothing held it. Column 0 is what keeps the exact
 *  match honest, not proximity to the top. */
export function isLegacyBaseline(text: string): boolean {
  return text.split("\n").some((line) => line === LEGACY_MERGEABLE_LINE);
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
  private: boolean | null;
  /** The owner named in the starter's header comment. */
  githubUsername: string;
}

/** Render the settings-sync starter template with an identity seed. The
 *  starter's jinja surface is validated FIRST - the template stripped of
 *  the known identity expressions must carry no jinja at all - so a
 *  template that grew a construct this renderer does not know throws
 *  before anything is substituted. An undefined optional value drops its
 *  whole line; `private` is always present (a value or an explicit
 *  null), so the `repository:` block can never render empty however many
 *  optional keys are dropped.
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
  const rulesByType = (entry: unknown): Map<string, unknown> => {
    const byType = new Map<string, unknown>();
    if (isMapping(entry) && Array.isArray(entry.rules)) {
      for (const rule of entry.rules) {
        if (isMapping(rule) && typeof rule.type === "string" && !byType.has(rule.type)) {
          byType.set(rule.type, rule);
        }
      }
    }
    return byType;
  };
  for (const [key, oldValue] of Object.entries(old)) {
    const managedValue = managed[key];
    if (isMapping(oldValue) && isMapping(managedValue)) {
      for (const [child, childValue] of Object.entries(oldValue)) {
        if (key === "repository" && IDENTITY_KEYS.has(child)) continue; // carried
        if (overrideDeclaresChild(key, child)) continue; // fleet law
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
        const fleetEntry = overrideEntry(key, name, fold);
        if (fleetEntry !== undefined) {
          // The entry itself is fleet law and cannot be re-added. Its
          // RULES are a different matter: a same-name ruleset appends
          // rules by type, so a type the old file carried that the fleet
          // does not already supply is a genuine repo addition the
          // reviewer can put back. Two things are NOT that: a type the
          // override declares (unbeatable from a repo file), and a type
          // the MERGED fleet entry already supplies identically - the
          // module visibility layers add code_scanning to `main` on every
          // public toolchain repo, and a legacy file carries it too.
          if (key === "rulesets") {
            const overrideTypes = new Set(rulesByType(fleetEntry).keys());
            const fleetRules = rulesByType(managedByName.get(fold(name)));
            for (const [type, rule] of rulesByType(entry)) {
              if (overrideTypes.has(type)) continue;
              const supplied = fleetRules.get(type);
              if (supplied !== undefined && canonical(supplied) === canonical(rule)) continue;
              dropped.push(
                `${key} ${JSON.stringify(name)}: rule ${JSON.stringify(type)} (the ruleset is ` +
                  "fleet-owned, but re-declaring just this rule in the new settings.yml appends it)",
              );
            }
          }
          continue;
        }
        classify(`${key} ${JSON.stringify(name)}`, entry, managedByName.get(fold(name)));
      }
      continue;
    }
    if (key in override) continue; // fleet law
    classify(key, oldValue, managedValue);
  }
  return dropped;
}

/** The PR-body section: empty when the replacement dropped nothing (a
 *  lossless transition needs no review). */
export function layeringSummary(dropped: string[]): string {
  if (dropped.length === 0) {
    return `### settings.yml layering transition

This update REPLACED \`.github/settings.yml\` with the identity starter: the fleet's own settings are merged centrally per repository now and this file layers over them (see repo-platform's docs/settings.md), so the old baseline copy had to go. Nothing was dropped - every declaration in the old file was either an identity key (carried over) or something the fleet layers already supply.

The file changed owner, which is why this PR is held for review rather than merging itself: check that the new starter says what you want before merging.
`;
  }
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
        const seed: IdentitySeed = {
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
        section = layeringSummary(dropped);
        writeFileSync(settingsPath, starter);
        notice(
          `${label}: replaced the legacy baseline .github/settings.yml with the identity starter ` +
            `(the fleet layers are merged centrally now)${
              dropped.length === 0
                ? "; nothing differed from the fleet layers, so nothing was dropped"
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
