#!/usr/bin/env bun
// The ordered settings layer list for one repository, LOWEST first, in the
// form github-settings-as-code's `mode: merge` takes as its settings-file
// input (docs/settings.md). The action owns the merge; this script owns
// which layers a repository gets and in what order: the fleet baseline, the
// fleet visibility overlay, each selected module's layer and overlay, the
// tracking-labels scratch layer (the one contribution no file can express:
// the label NAME is the repository's own copier answer, the tuple lives in
// the module manifest), the repository's own .github/settings.yml, and the
// fleet override on top. Every path is published as a step output; the two
// scratch files are written under RUNNER_TEMP with fixed neutral names.
//
// Usage (the apply job): bun settings_layers.ts
//   Env: TARGET, GITHUB_REPOSITORY, RUNNER_TEMP, GH_TOKEN, GITHUB_OUTPUT.
//   The operator repository reads its own checkout; every other target is
//   fetched at its default-branch head, which every read pins to.
// Usage (a local checkout): bun settings_layers.ts --target-dir <dir>
//   --scratch-dir <dir>
// Outputs: ref (the pinned commit), skipped, skip_reason, layers (the
// comma-separated list). A target with no .repo-platform.yml at the pin
// left management; one with no settings.yml is not onboarded yet, and
// applying the fleet layers alone would delete every label it declares
// for itself. Both skip, loudly.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  loadManifests,
  type ModuleManifest,
  SETTINGS_LAYER_FILES,
  type SettingsLayerName,
} from "../../../scripts/lib/module_manifests.ts";
import { parseFlags } from "../shared/flags.ts";
import { fail, hideDetails, requireEnv, setOutput, warning } from "../shared/gha.ts";
import {
  factsFromFetch,
  factsFromOperatorAnswers,
  factsFromTargetDir,
  fetchRepoFile,
  isMapping,
  localHeadSha,
  parseLayerText,
  type RepoFacts,
  type RepoFileFetcher,
  resolveTargetRef,
} from "./settings_facts.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export const BASELINE_LAYER = join(REPO_ROOT, ".github/settings-baseline.yml");
export const FLEET_PUBLIC_LAYER = join(REPO_ROOT, ".github/settings-public.yml");
export const FLEET_PRIVATE_LAYER = join(REPO_ROOT, ".github/settings-private.yml");
export const OVERRIDE_PATH = join(REPO_ROOT, ".github/settings-override.yml");
export const OPERATOR_ANSWERS = join(REPO_ROOT, ".repo-platform-answers.yml");

/** The scratch filenames, fixed and neutral: a redacted slug never reaches
 *  a path the public log could print. */
export const SCRATCH_REPO_LAYER = "repository.yml";
export const SCRATCH_TRACKING_LAYER = "tracking-labels.yml";

export const SKIP_REASONS = ["left-management", "not-onboarded"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type Label = { name: string; color: string; description: string };

function moduleLayerPath(module: string, name: SettingsLayerName): string {
  return join(REPO_ROOT, "templates", module, name);
}

/** The fleet layer files are unconditional; a missing one is a hard error
 *  before any layer is read. Module layer files need no check here: the
 *  manifest loader holds each declaration against the tree. */
export function assertFleetLayerFiles(exists: (path: string) => boolean = existsSync): void {
  for (const path of [BASELINE_LAYER, FLEET_PUBLIC_LAYER, FLEET_PRIVATE_LAYER, OVERRIDE_PATH]) {
    if (!exists(path)) {
      throw new Error(
        `${path}: fleet settings layer is missing - every repository's stack is built on it, ` +
          "so merging without it would apply a fleet-wide document missing its defaults",
      );
    }
  }
}

/** The checked-in layers a repository's facts select, LOW to HIGH: the
 *  fleet baseline, the fleet visibility overlay, each selected module's own
 *  layer, then each module's visibility overlay. Which module files exist
 *  is DECLARED (each manifest's settings_layers), never discovered: a
 *  deleted layer file must fail, not shrink the stack. */
export function selectedLayerPaths(
  facts: RepoFacts,
  manifests: ModuleManifest[],
  exists: (path: string) => boolean = existsSync,
): string[] {
  assertFleetLayerFiles(exists);
  const visibility = facts.private ? SETTINGS_LAYER_FILES.private : SETTINGS_LAYER_FILES.public;
  const selected = manifests.filter((m) => facts.modules.includes(m.module));
  const declares = (m: ModuleManifest, name: SettingsLayerName) =>
    (m.settings_layers ?? []).includes(name);
  // pr-title's layer activates a required check, so it waits for the
  // managed workflow to exist at the pinned revision (RepoFacts has the race).
  const activatable = (m: ModuleManifest) =>
    m.module !== "pr-title" || facts.prTitleWorkflowPresent;
  return [
    BASELINE_LAYER,
    facts.private ? FLEET_PRIVATE_LAYER : FLEET_PUBLIC_LAYER,
    ...selected
      .filter((m) => declares(m, SETTINGS_LAYER_FILES.module) && activatable(m))
      .map((m) => moduleLayerPath(m.module, SETTINGS_LAYER_FILES.module)),
    ...selected
      .filter((m) => declares(m, visibility))
      .map((m) => moduleLayerPath(m.module, visibility)),
  ];
}

/** The repository's tracking labels: the NAME is the copier answer, the
 *  color and description are the module manifest's. */
export function trackingLabels(facts: RepoFacts, manifests: ModuleManifest[]): Label[] {
  const byModule = new Map(manifests.map((m) => [m.module, m]));
  return facts.trackingLabels.map(({ module, label }) => {
    const tracking = byModule.get(module)?.tracking_label;
    if (!tracking) {
      throw new Error(
        `tracking label recorded for '${module}', but templates/${module}/module.yml ` +
          "declares no tracking_label - the facts and the manifests disagree",
      );
    }
    return { name: label, color: tracking.color, description: tracking.description };
  });
}

/** One layer of the stack: a file on disk, or the tracking labels the
 *  caller materializes (a scratch file for the action, a document for the
 *  sync's roster check). */
export type LayerSource = { kind: "file"; path: string } | { kind: "tracking"; labels: Label[] };

/** The whole stack, low to high. The tracking layer sits with the module
 *  layers, below the repository's own file, so a repository's redeclaration
 *  of its tracking label wins the way it wins over any module label. */
export function layerStack(
  facts: RepoFacts,
  manifests: ModuleManifest[],
  repoLayerPath: string,
): LayerSource[] {
  const labels = trackingLabels(facts, manifests);
  return [
    ...selectedLayerPaths(facts, manifests).map((path) => ({ kind: "file", path }) as const),
    ...(labels.length === 0 ? [] : [{ kind: "tracking", labels } as const]),
    { kind: "file", path: repoLayerPath },
    { kind: "file", path: OVERRIDE_PATH },
  ];
}

export function trackingLayerYaml(labels: Label[]): string {
  return (
    "# Tracking labels for this repository (its recorded copier answers with the module\n" +
    "# manifests' tuples), written by repo-platform's settings_layers.ts - scratch output.\n" +
    stringifyYaml({ labels })
  );
}

/** One layer FILE as a mapping (parseLayerText: an empty file is an empty layer). */
export function loadLayer(path: string): Record<string, unknown> {
  return parseLayerText(readFileSync(path, "utf-8"), path);
}

/** The label entries of a `labels` section in either of the action's
 *  forms: the plain list, or the `{_undeclared, entries}` wrapper the
 *  merged document carries. */
export function labelEntries(section: unknown): unknown[] {
  if (Array.isArray(section)) return section;
  if (isMapping(section) && Array.isArray(section.entries)) return section.entries;
  return [];
}

/** The POST-APPLY label names a stack of documents declares, folded the
 *  way the action's merge folds `labels` (union by case-folded name, a
 *  higher `null` dropping what lower layers declared), or null when no
 *  layer leaves a labels key for the apply to reconcile. The sync's
 *  referenced-label warning reads this; the apply side reads the action's
 *  own merged document instead. */
export function layerLabelNames(docs: readonly unknown[]): string[] | null {
  let roster: Map<string, string> | null = null;
  for (const doc of docs) {
    if (!isMapping(doc) || !Object.hasOwn(doc, "labels")) continue;
    if (doc.labels === null) {
      roster = null;
      continue;
    }
    roster ??= new Map();
    for (const entry of labelEntries(doc.labels)) {
      if (!isMapping(entry) || typeof entry.name !== "string") continue;
      const final = typeof entry.new_name === "string" ? entry.new_name : entry.name;
      roster.set(entry.name.toLowerCase(), final);
    }
  }
  return roster === null ? null : [...new Set(roster.values())];
}

/** Every label tuple any layer can emit, for ANY selection and either
 *  visibility, tracking labels excluded: the roster the copier validators
 *  and check_ssot key on. Reads exactly the declared layer files. */
export function allLayerLabels(manifests: ModuleManifest[] = loadManifests()): Label[] {
  assertFleetLayerFiles();
  const paths = [BASELINE_LAYER, FLEET_PUBLIC_LAYER, FLEET_PRIVATE_LAYER];
  for (const m of manifests) {
    for (const name of m.settings_layers ?? []) paths.push(moduleLayerPath(m.module, name));
  }
  const labels: Label[] = [];
  for (const path of paths) {
    for (const label of labelEntries(loadLayer(path).labels)) {
      if (!isMapping(label) || typeof label.name !== "string") continue;
      if (labels.some((seen) => seen.name === label.name)) continue;
      labels.push({
        name: label.name,
        color: String(label.color ?? ""),
        description: String(label.description ?? ""),
      });
    }
  }
  return labels;
}

export function managedLabelNames(manifests: ModuleManifest[] = loadManifests()): string[] {
  return allLayerLabels(manifests).map((label) => label.name);
}

/** The check the fleet's ci.yml all-green job carries: the main ruleset's
 *  ONE required context. */
export const ALL_GREEN_CONTEXT = "all-green";

/** GitHub Actions' app id: the required-check entry pins it, or any app or
 *  plain commit status could satisfy the context by name. */
export const GITHUB_ACTIONS_APP_ID = 15368;

/** The fleet override, the top layer no repository can beat, validated on
 *  every read against the mistakes that un-gate the whole fleet: the main
 *  ruleset must require ALL_GREEN_CONTEXT, and every required-check entry
 *  must pin integration_id to GitHub Actions. */
export function loadOverrideLayer(path: string = OVERRIDE_PATH): Record<string, unknown> {
  const data = loadLayer(path);
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

/** What one run resolved: the pinned commit plus either the layer list or
 *  the skip. */
export type LayersOutcome =
  | { ref: string; kind: "layers"; layers: string[] }
  | { ref: string; kind: "skip"; reason: SkipReason };

/** The action's settings-file input: comma-separated, so no path may carry
 *  its separators. */
export function layersInput(layers: string[]): string {
  for (const path of layers) {
    if (/[,\n]/.test(path)) {
      throw new Error(`${path}: a layer path cannot contain a comma or a newline`);
    }
  }
  return layers.join(",");
}

/** Materializes the stack: the tracking layer becomes a scratch file, and
 *  a path under the working directory (the checkout root in the apply job)
 *  is published relative to it; scratch and target paths stay absolute.
 *  For a hide-details target every layer is instead COPIED into the scratch
 *  directory under a numbered name: the published list is the merge step's
 *  settings-file input, which the runner prints in the public log, and a
 *  module layer's path (templates/uv/settings.yml) would name the target's
 *  module selection there. The layer count still shows. */
export function materialize(stack: LayerSource[], scratchDir: string, neutral = false): string[] {
  mkdirSync(scratchDir, { recursive: true });
  return stack.map((source, index) => {
    if (neutral) {
      const path = join(scratchDir, `layer-${String(index + 1).padStart(2, "0")}.yml`);
      if (source.kind === "file") copyFileSync(source.path, path);
      else writeFileSync(path, trackingLayerYaml(source.labels));
      return path;
    }
    if (source.kind === "file") {
      const inside = relative(process.cwd(), source.path);
      return inside === "" || inside.startsWith("..") ? source.path : inside;
    }
    const path = join(scratchDir, SCRATCH_TRACKING_LAYER);
    writeFileSync(path, trackingLayerYaml(source.labels));
    return path;
  });
}

/** A fetched repo layer lands in scratch only once it parses as YAML: the
 *  fetch runs behind the hidden-output boundary, so a syntax error in a
 *  private repository's file is reported there and never reaches the
 *  action's public diagnostics. */
function writeRepoLayer(text: string, where: string, scratchDir: string): string {
  parseLayerText(text, where);
  mkdirSync(scratchDir, { recursive: true });
  const path = join(scratchDir, SCRATCH_REPO_LAYER);
  writeFileSync(path, text);
  return path;
}

function fetchedOutcome(target: string, scratchDir: string): LayersOutcome {
  const manifests = loadManifests();
  const ref = resolveTargetRef(target);
  // The repo layer is read once at the pin: the facts peek at its declared
  // visibility, and the same bytes become the scratch layer.
  const text = fetchRepoFile(target, ".github/settings.yml", ref);
  const fetch: RepoFileFetcher = (repo, path, at) =>
    path === ".github/settings.yml" ? text : fetchRepoFile(repo, path, at);
  const facts = factsFromFetch(target, manifests, ref, fetch);
  if (facts === null) return { ref, kind: "skip", reason: "left-management" };
  if (text === null) return { ref, kind: "skip", reason: "not-onboarded" };
  const repoLayer = writeRepoLayer(text, `${target}/.github/settings.yml@${ref}`, scratchDir);
  return {
    ref,
    kind: "layers",
    layers: materialize(layerStack(facts, manifests, repoLayer), scratchDir, hideDetails()),
  };
}

function localOutcome(dir: string, scratchDir: string, operator: boolean): LayersOutcome {
  const manifests = loadManifests();
  const ref = localHeadSha(dir);
  const facts = operator
    ? factsFromOperatorAnswers(OPERATOR_ANSWERS, manifests)
    : factsFromTargetDir(dir, manifests);
  if (facts === null) return { ref, kind: "skip", reason: "left-management" };
  const repoLayer = join(dir, ".github/settings.yml");
  if (!existsSync(repoLayer)) return { ref, kind: "skip", reason: "not-onboarded" };
  return {
    ref,
    kind: "layers",
    layers: materialize(layerStack(facts, manifests, repoLayer), scratchDir),
  };
}

/** The skip a target earns; the wording is fixed so a hidden target's
 *  public notice (report_skipped_target.ts) can name the category alone. */
export function skipWarning(reason: SkipReason): string {
  return reason === "left-management"
    ? "no .repo-platform.yml at the revision these facts were read from - the repository left " +
        "management, so this apply is SKIPPED. Applying anyway would reconcile - and delete - " +
        "labels on a repository that is no longer managed."
    : "no .github/settings.yml at the pinned revision - the repository is managed but not " +
        "onboarded yet, so this apply is SKIPPED. Applying the fleet layers alone would delete " +
        "every label the repository declares for itself. The settings starter seeds the file " +
        "on the next template sync.";
}

function publish(outcome: LayersOutcome): void {
  setOutput("ref", outcome.ref);
  if (outcome.kind === "skip") {
    warning(skipWarning(outcome.reason));
    setOutput("skipped", "true");
    setOutput("skip_reason", outcome.reason);
    setOutput("layers", "");
    console.log(`skipped: ${outcome.reason}`);
    return;
  }
  // The override lint: every run re-reads the top layer, so a weakened
  // override fails the apply instead of un-gating the fleet quietly.
  loadOverrideLayer();
  setOutput("skipped", "false");
  setOutput("skip_reason", "");
  setOutput("layers", layersInput(outcome.layers));
  console.log(`settings layers (low to high):\n${outcome.layers.map((p) => `  ${p}`).join("\n")}`);
}

function main(args: string[]): void {
  const flags = parseFlags(args, [] as const, ["--target-dir", "--scratch-dir"] as const);
  try {
    if (flags["--target-dir"] !== undefined || flags["--scratch-dir"] !== undefined) {
      if (flags["--target-dir"] === undefined || flags["--scratch-dir"] === undefined) {
        throw new Error("--target-dir and --scratch-dir go together");
      }
      publish(localOutcome(flags["--target-dir"], flags["--scratch-dir"], false));
      return;
    }
    const target = requireEnv("TARGET");
    const scratchDir = join(requireEnv("RUNNER_TEMP"), "settings-layers");
    publish(
      target === requireEnv("GITHUB_REPOSITORY")
        ? localOutcome(REPO_ROOT, scratchDir, true)
        : fetchedOutcome(target, scratchDir),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
