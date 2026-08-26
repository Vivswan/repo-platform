#!/usr/bin/env bun
// Assembles the managed settings baseline, computed per repository at
// apply time. No settings VALUES live here: the fleet-generic content is
// .github/settings-baseline.yml (policy block, public-only keys, common
// labels, fleet rulesets, the codeql splice rule), the module-conditional
// content is the module manifests (settings_labels, settings_rulesets,
// dependabot, tracking_label) - this script only assembles them for a
// repo's facts. The settings-sync template's rendered .github/settings.yml
// is a repo-owned STARTER carrying only identity keys and local
// overrides; the baseline is never synced into client repos -
// settings-repos.yml (and the self-apply in reusable-apply-settings.yml)
// assembles it here and merge_settings_layers.ts merges the repo's own
// file over it.
//
// Consumers beyond the apply paths: scripts/generate.ts derives the
// tracking-label validators' reserved-label roster from managedLabelNames,
// scripts/check_ssot.ts anchors its label/ruleset rules here, and the
// sync's settings_layering.ts transition renders each repo's baseline to
// diff the legacy settings.yml against.
//
// Inputs are repo facts: the module selection (the target repo's
// .repo-platform.yml - selecting the settings-sync module there is the
// opt-in), effective visibility (private repositories reject the
// public-only keys and the codeql rule with a 422), and the
// tracking-label answers recorded in .copier-answers.yml (each stream
// repo picks its own label name; the color/description tuples live in
// the module manifests).
//
// CLI (the apply paths):
//   bun .github/scripts/fleet/render_managed_settings.ts --repo owner/name
//     --out managed.yml [--target-dir <checkout> | --operator-answers <file>]
//
// By default the facts come from the target repository's default branch
// via gh api (env: GH_TOKEN); visibility is the DECLARED
// repository.private in its settings.yml, live-probed when undeclared.
// --target-dir reads the facts from a local checkout (no network);
// --operator-answers reads module selection and visibility from the
// operator repository's recorded answers file - repo-platform is the one
// fleet member with no .repo-platform.yml (it is not generated from the
// template), and settings-repos.yml passes the flag for its self target.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { dependabotLabels } from "../../../scripts/compose_template.ts";
import { loadManifests, type ModuleManifest } from "../../../scripts/module_manifests.ts";
import { parseAnswers } from "../../../scripts/render_dogfood.ts";
import { parseFlags } from "../shared/flags.ts";
import { fail } from "../shared/gha.ts";
import { captureNetwork } from "./discovery.ts";

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface RepoFacts {
  /** The target's module selection (its .repo-platform.yml list). */
  modules: string[];
  /** Effective visibility (declared repository.private, else live):
   *  private repos reject the public-only blocks. */
  private: boolean;
  /** Resolved tracking-label answers, one per SELECTED stream module. */
  trackingLabels: { module: string; label: string }[];
}

// --- the baseline document ---------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
export const BASELINE_PATH = join(REPO_ROOT, ".github/settings-baseline.yml");

const labelSchema = z.strictObject({
  name: z.string().min(1),
  color: z.string().regex(/^[0-9A-Fa-f]{6}$/),
  description: z.string().min(1),
});

// No settings VALUES live in this script: the fleet-generic content is
// .github/settings-baseline.yml (validated here), the module-conditional
// content is the module manifests' settings_labels / settings_rulesets /
// dependabot / tracking_label - this script only assembles them.
const baselineSchema = z.strictObject({
  /** The repository policy block every managed repo shares. */
  repository: z.record(z.string(), z.unknown()),
  /** Merged into the repository block for PUBLIC repos only (422 on
   *  private repos without Advanced Security). */
  public_repository: z.record(z.string(), z.unknown()),
  /** The unconditional labels. */
  labels: z.array(labelSchema).min(1),
  /** Appended for PRIVATE repos (the report marker label). */
  private_labels: z.array(labelSchema).min(1),
  /** The fleet-generic rulesets; must include a `main` ruleset with a
   *  required_status_checks rule (asserted below - the codeql splice and
   *  the all-green contract anchor on them). */
  rulesets: z.array(z.looseObject({ name: z.string().min(1) })).min(1),
  /** Spliced into the main ruleset's rules (after required_status_checks)
   *  when CodeQL analyzes the repository. */
  codeql_rule: z.record(z.string(), z.unknown()),
});

export type SettingsBaseline = z.infer<typeof baselineSchema>;

/** Load and validate the baseline document; throws on any shape problem
 *  so a broken baseline fails every consumer loudly. */
export function loadBaseline(path: string = BASELINE_PATH): SettingsBaseline {
  const data = parseMapping(readFileSync(path, "utf-8"), path);
  const result = baselineSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(top level)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${path}: ${details}`);
  }
  const main = result.data.rulesets.find((r) => r.name === "main");
  const mainRules = main !== undefined && Array.isArray(main.rules) ? main.rules : [];
  if (!mainRules.some((rule) => isMapping(rule) && rule.type === "required_status_checks")) {
    throw new Error(
      `${path}: the rulesets must include a 'main' ruleset with a required_status_checks ` +
        "rule - the codeql splice and the all-green contract anchor on it",
    );
  }
  return result.data;
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every label name the assembly can emit for ANY selection, tracking
 *  labels excluded (those render from the very answers the copier
 *  validators check). scripts/generate.ts builds the reserved-label
 *  roster from this, check_ssot.ts its roster rules. */
export function managedLabelNames(
  manifests: ModuleManifest[],
  baseline: SettingsBaseline = loadBaseline(),
): string[] {
  return [
    ...baseline.labels.map((label) => label.name),
    ...baseline.private_labels.map((label) => label.name),
    ...manifests.flatMap((m) => (m.settings_labels ?? []).map((label) => label.name)),
    ...dependabotLabels(manifests).map((label) => label.name),
  ];
}

/** The full label roster a repo's facts require. Order is stable:
 *  baseline labels, per-module dependabot labels, the private-only
 *  labels, the selected modules' own labels (manifest order), tracking
 *  labels - a superset-shaped echo of the retired settings.yml.jinja
 *  render, so existing repos' transition diffs read as byte-equal. */
export function managedLabels(
  facts: RepoFacts,
  manifests: ModuleManifest[],
  baseline: SettingsBaseline = loadBaseline(),
): Label[] {
  const labels: Label[] = [...baseline.labels];
  for (const group of dependabotLabels(manifests)) {
    if (group.modules.some((module) => facts.modules.includes(module))) {
      labels.push({ name: group.name, color: group.color, description: group.description });
    }
  }
  if (facts.private) labels.push(...baseline.private_labels);
  for (const m of manifests) {
    if (m.settings_labels && facts.modules.includes(m.module)) {
      labels.push(...m.settings_labels);
    }
  }
  const byModule = new Map(manifests.map((m) => [m.module, m]));
  for (const { module, label } of facts.trackingLabels) {
    const tracking = byModule.get(module)?.tracking_label;
    if (!tracking) {
      throw new Error(
        `tracking label recorded for '${module}', but templates/${module}/module.yml ` +
          "declares no tracking_label - the facts and the manifests disagree",
      );
    }
    labels.push({ name: label, color: tracking.color, description: tracking.description });
  }
  return labels;
}

/** copier.yml's computed enable_codeql from the same inputs: a public
 *  repository with at least one selected toolchain module. */
export function enableCodeql(facts: RepoFacts, manifests: ModuleManifest[]): boolean {
  return (
    !facts.private &&
    manifests.some((m) => m.toolchain !== undefined && facts.modules.includes(m.module))
  );
}

/** The rulesets for a repo's facts: the baseline's fleet-generic entries
 *  (the codeql rule spliced into `main` after required_status_checks when
 *  CodeQL analyzes the repo - GitHub rejects the rule everywhere else)
 *  plus the selected modules' settings_rulesets in manifest order. */
export function managedRulesets(
  facts: RepoFacts,
  manifests: ModuleManifest[],
  baseline: SettingsBaseline = loadBaseline(),
): Record<string, unknown>[] {
  const rulesets = baseline.rulesets.map((ruleset) => ({ ...ruleset }));
  if (enableCodeql(facts, manifests)) {
    const main = rulesets.find((r) => r.name === "main");
    const rules = main !== undefined && Array.isArray(main.rules) ? [...main.rules] : [];
    const at = rules.findIndex((rule) => isMapping(rule) && rule.type === "required_status_checks");
    // loadBaseline asserted the anchor rule exists; splicing right after
    // it keeps the rule order the fleet's rulesets have always had.
    rules.splice(at + 1, 0, baseline.codeql_rule);
    if (main !== undefined) main.rules = rules;
  }
  for (const m of manifests) {
    if (m.settings_rulesets && facts.modules.includes(m.module)) {
      rulesets.push(...m.settings_rulesets);
    }
  }
  return rulesets;
}

/** The whole managed settings document for a repo's facts: the baseline's
 *  repository policy block (plus its public-only keys), the assembled
 *  label roster, and the rulesets. Identity keys are absent on purpose -
 *  they live in the repo's own settings.yml, which merges OVER this
 *  document. */
export function managedSettings(
  facts: RepoFacts,
  manifests: ModuleManifest[] = loadManifests(),
  baseline: SettingsBaseline = loadBaseline(),
): Record<string, unknown> {
  return {
    repository: {
      ...baseline.repository,
      ...(facts.private ? {} : baseline.public_repository),
    },
    labels: managedLabels(facts, manifests, baseline),
    rulesets: managedRulesets(facts, manifests, baseline),
  };
}

// --- fact resolution --------------------------------------------------------

function parseMapping(text: string, where: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`${where}: YAML parse error: ${detail}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`${where}: not a YAML mapping`);
  }
  return data as Record<string, unknown>;
}

/** Modules from a .repo-platform.yml text; throws on a missing or
 *  malformed top-level list (the baseline cannot be computed from a
 *  guess). */
export function modulesFrom(registrationText: string, where: string): string[] {
  const modules = parseMapping(registrationText, where).modules;
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === "string")) {
    throw new Error(`${where}: no readable top-level modules list`);
  }
  return modules;
}

/** The selected stream modules' tracking-label answers from a
 *  .copier-answers.yml text. A tracking label is the module's issue-stream
 *  identity: guessing a default could pass while the repo's real label
 *  loops on delete/recreate, so an unreadable answer for a SELECTED
 *  stream module throws, never falls back. */
export function trackingLabelsFrom(
  answersText: string,
  modules: string[],
  manifests: ModuleManifest[],
  where: string,
): { module: string; label: string }[] {
  const streams = manifests.filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  if (streams.length === 0) return [];
  const answers = parseMapping(answersText, where);
  return streams.map((m) => {
    const tracking = m.tracking_label;
    if (tracking === undefined) throw new Error("unreachable: filtered on tracking_label");
    const value = answers[tracking.answer];
    if (typeof value !== "string" || value === "") {
      throw new Error(
        `${where}: the ${m.module} module is selected but no ${tracking.answer} answer ` +
          "is readable - the tracking label cannot be resolved; fix the answers file",
      );
    }
    return { module: m.module, label: value };
  });
}

function fetchRepoFile(repo: string, path: string): string | null {
  const proc = captureNetwork([
    "gh",
    "api",
    `repos/${repo}/contents/${path}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return proc.stdout;
  if (proc.stderr.includes("HTTP 404")) return null;
  throw new Error(`${repo}/${path}: fetch failed (${proc.stderr.trim().split("\n")[0]})`);
}

/** Live visibility, failing closed like every other probe: only an
 *  explicit "false" proves the repo public. A probe failure throws - a
 *  wrong visibility would apply the public-only blocks to a private repo
 *  (422) or silently drop them from a public one. */
function fetchRepoIsPrivate(repo: string): boolean {
  const proc = captureNetwork(["gh", "api", `repos/${repo}`, "--jq", ".private"]);
  if (proc.exitCode !== 0) {
    throw new Error(`${repo}: visibility probe failed (${proc.stderr.trim().split("\n")[0]})`);
  }
  return proc.stdout.trim() !== "false";
}

/** The DECLARED visibility in a settings.yml text: the repo layer's
 *  `repository.private` boolean, or null when the file, the key, or the
 *  boolean shape is absent. */
export function declaredPrivate(settingsText: string | null): boolean | null {
  if (settingsText === null) return null;
  let data: unknown;
  try {
    data = parseYaml(settingsText);
  } catch {
    return null;
  }
  const repository =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).repository
      : null;
  const value =
    typeof repository === "object" && repository !== null && !Array.isArray(repository)
      ? (repository as Record<string, unknown>).private
      : null;
  return typeof value === "boolean" ? value : null;
}

/** Facts for the operator repository itself: it is not generated from the
 *  template (no .repo-platform.yml, no .copier-answers.yml), so its module
 *  selection and visibility come from the recorded operator answers file -
 *  the same answers the dogfood render uses (render_dogfood.ts pins its
 *  private answer to the in-repo settings.yml declaration). */
export function factsFromOperatorAnswers(answersPath: string): RepoFacts {
  const answers = parseAnswers(readFileSync(answersPath, "utf-8"), answersPath);
  const modules = [...answers.modules];
  const streams = loadManifests().filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  if (streams.length > 0) {
    // The dogfood answers schema records no tracking-label answers today;
    // selecting a stream module here means teaching that schema (and this
    // resolver) the answer first.
    throw new Error(
      `${answersPath}: selects the tracking-stream module(s) ` +
        `${streams.map((m) => m.module).join(", ")} but records no tracking-label answers - ` +
        "extend the answers schema before selecting a stream module",
    );
  }
  return { modules, private: answers.private, trackingLabels: [] };
}

/** Facts fetched from the target repository's default branch (gh api).
 *  Visibility is the DECLARED repository.private in the repo's
 *  settings.yml when it is a boolean, the live probe otherwise: the apply
 *  flips visibility to the declared value (repository section first), so
 *  the baseline's visibility-gated blocks must match the POST-apply state
 *  - deriving them from live visibility would 422 the very apply that
 *  performs a deliberate flip. */
export function factsFromFetch(repo: string, manifests: ModuleManifest[]): RepoFacts {
  const registration = fetchRepoFile(repo, ".repo-platform.yml");
  if (registration === null) {
    throw new Error(
      `${repo}: no .repo-platform.yml on the default branch - the repo is not adopted, ` +
        "so there is no module selection to compute a settings baseline from",
    );
  }
  const modules = modulesFrom(registration, `${repo}/.repo-platform.yml`);
  const isPrivate =
    declaredPrivate(fetchRepoFile(repo, ".github/settings.yml")) ?? fetchRepoIsPrivate(repo);
  const streams = manifests.filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  let trackingLabels: { module: string; label: string }[] = [];
  if (streams.length > 0) {
    const answers = fetchRepoFile(repo, ".copier-answers.yml");
    if (answers === null) {
      throw new Error(
        `${repo}: selects tracking-stream module(s) but has no .copier-answers.yml - ` +
          "the tracking labels cannot be resolved",
      );
    }
    trackingLabels = trackingLabelsFrom(answers, modules, manifests, `${repo}/.copier-answers.yml`);
  }
  return { modules, private: isPrivate, trackingLabels };
}

/** Facts read from a local checkout: the sync's transition path. The
 *  private fact prefers the checkout's DECLARED repository.private (the
 *  same precedence as the fetch path), falling back to the recorded
 *  answer - post-update the sync has already re-recorded the live value
 *  there. */
export function factsFromTargetDir(dir: string, manifests: ModuleManifest[]): RepoFacts {
  const where = (name: string) => `${join(dir, name)}`;
  const modules = modulesFrom(
    readFileSync(join(dir, ".repo-platform.yml"), "utf-8"),
    where(".repo-platform.yml"),
  );
  const answersText = readFileSync(join(dir, ".copier-answers.yml"), "utf-8");
  const settingsPath = join(dir, ".github/settings.yml");
  const declared = declaredPrivate(
    existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null,
  );
  const recorded = parseMapping(answersText, where(".copier-answers.yml")).private;
  if (declared === null && typeof recorded !== "boolean") {
    throw new Error(
      `${where(".copier-answers.yml")}: records no boolean private answer - ` +
        "the baseline's visibility-gated blocks cannot be computed",
    );
  }
  return {
    modules,
    private: declared ?? recorded === true,
    trackingLabels: trackingLabelsFrom(
      answersText,
      modules,
      manifests,
      where(".copier-answers.yml"),
    ),
  };
}

/** The managed document as YAML bytes, with a header naming the generator
 *  so a stray scratch file self-identifies. */
export function renderManagedYaml(facts: RepoFacts, manifests?: ModuleManifest[]): string {
  return `# Managed settings baseline, computed by repo-platform's\n# .github/scripts/fleet/render_managed_settings.ts - scratch output, never committed.\n${stringifyYaml(
    managedSettings(facts, manifests),
  )}`;
}

function main(args: string[]): void {
  const flags = parseFlags(
    args,
    ["--repo", "--out"] as const,
    ["--target-dir", "--operator-answers"] as const,
  );
  if (flags["--target-dir"] !== undefined && flags["--operator-answers"] !== undefined) {
    fail("--target-dir and --operator-answers are mutually exclusive - pass one fact source");
  }
  const repo = flags["--repo"];
  let facts: RepoFacts;
  try {
    const manifests = loadManifests();
    facts =
      flags["--target-dir"] !== undefined
        ? factsFromTargetDir(flags["--target-dir"], manifests)
        : flags["--operator-answers"] !== undefined
          ? factsFromOperatorAnswers(flags["--operator-answers"])
          : factsFromFetch(repo, manifests);
    writeFileSync(flags["--out"], renderManagedYaml(facts, manifests));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(
    `rendered the managed settings baseline for ${facts.modules.length} module(s) into ${flags["--out"]}`,
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
