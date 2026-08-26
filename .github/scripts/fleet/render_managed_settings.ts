#!/usr/bin/env bun
// Selects and merges settings LAYERS 1 to 4 for a repository (the full
// six-layer model is docs/settings.md). No settings VALUES live here:
// every layer is a plain settings-as-code document - the fleet baseline
// and its visibility overlay under .github/, each selected module's own
// settings.yml and visibility overlay next to its module.yml - and this
// script only picks the ones a repo's facts select and merges them.
// merge_settings_layers.ts owns the dialect and adds the repo's own
// .github/settings.yml and the fleet override on top. No layer file is
// ever synced into a client repo; the settings-sync template renders the
// repo's own settings.yml ONCE as a repo-owned identity starter.
//
// Consumers beyond the apply paths: scripts/generate.ts derives the
// tracking-label validators' reserved-label roster from managedLabelNames,
// scripts/check_ssot.ts anchors its label/ruleset rules here, and the
// sync's settings_layering.ts transition renders each repo's managed
// layers to diff the legacy settings.yml against.
//
// Inputs are repo facts: the module selection (the target repo's
// .repo-platform.yml - selecting the settings-sync module there is the
// opt-in), effective visibility (private repositories reject the
// public-only layers with a 422), and the
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
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { loadManifests, type ModuleManifest } from "../../../scripts/module_manifests.ts";
import { parseAnswers } from "../../../scripts/render_dogfood.ts";
import { parseFlags } from "../shared/flags.ts";
import { fail, setOutput, warning } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";
import { RETIRED_MODULES } from "../sync/modules.ts";
import { captureNetwork } from "./discovery.ts";
import { mergeLayers } from "./merge_settings_layers.ts";
import {
  isMapping,
  type MergedSettings,
  parseLayerFile,
  parseYamlMapping,
  type SettingsLayer,
} from "./settings_document.ts";

/** A label tuple. A type alias rather than an interface so it carries an
 *  implicit index signature: a label list is a value inside a merged
 *  document, and only structural types are assignable to MergedValue. */
export type Label = {
  name: string;
  color: string;
  description: string;
};

export interface RepoFacts {
  /** The target's module selection (its .repo-platform.yml list). */
  modules: string[];
  /** Effective visibility (declared repository.private, else live):
   *  private repos reject the public-only blocks. */
  private: boolean;
  /** Resolved tracking-label answers, one per SELECTED stream module. */
  trackingLabels: { module: string; label: string }[];
}

// --- the settings layers ----------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** The module-level layer filenames, next to each templates/<module>/
 *  module.yml. compose_template.ts skips them: they are read here, never
 *  rendered into a repository. */
const MODULE_LAYER = "settings.yml";
const MODULE_PUBLIC_LAYER = "settings-public.yml";
const MODULE_PRIVATE_LAYER = "settings-private.yml";

export const BASELINE_LAYER = join(REPO_ROOT, ".github/settings-baseline.yml");
export const FLEET_PUBLIC_LAYER = join(REPO_ROOT, ".github/settings-public.yml");
export const FLEET_PRIVATE_LAYER = join(REPO_ROOT, ".github/settings-private.yml");

/** Every layer file a repository's facts select, LOW to HIGH: the fleet
 *  baseline, the fleet visibility overlay, each selected module's own
 *  layer, then each selected module's visibility overlay. A layer file
 *  that does not exist is simply not a layer. The repo's own settings.yml
 *  and .github/settings-override.yml are layers 5 and 6, applied by
 *  merge_settings_layers.ts at apply time. */
export function layerPaths(facts: RepoFacts, manifests: ModuleManifest[]): string[] {
  const visibility = facts.private ? MODULE_PRIVATE_LAYER : MODULE_PUBLIC_LAYER;
  const selected = manifests.filter((m) => facts.modules.includes(m.module));
  const moduleLayer = (module: string, name: string) => join(REPO_ROOT, "templates", module, name);
  return [
    BASELINE_LAYER,
    facts.private ? FLEET_PRIVATE_LAYER : FLEET_PUBLIC_LAYER,
    ...selected.map((m) => moduleLayer(m.module, MODULE_LAYER)),
    ...selected.map((m) => moduleLayer(m.module, visibility)),
  ].filter((path) => existsSync(path));
}

/** One layer document, through the settings parse boundary: the file is
 *  known here, so a rule that declares no `type` names this file and the
 *  position inside it. */
export function loadLayer(path: string): SettingsLayer {
  return parseLayerFile(readFileSync(path, "utf-8"), path);
}

/** Every label tuple any layer can emit, for ANY module selection and
 *  either visibility; tracking labels excluded (those render from the
 *  very answers the copier validators check). The single roster
 *  scripts/generate.ts and check_ssot.ts key on. */
export function allLayerLabels(manifests: ModuleManifest[] = loadManifests()): Label[] {
  const labels: Label[] = [];
  const paths = [BASELINE_LAYER, FLEET_PUBLIC_LAYER, FLEET_PRIVATE_LAYER];
  for (const m of manifests) {
    for (const name of [MODULE_LAYER, MODULE_PUBLIC_LAYER, MODULE_PRIVATE_LAYER]) {
      paths.push(join(REPO_ROOT, "templates", m.module, name));
    }
  }
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const declared = loadLayer(path).labels;
    if (!Array.isArray(declared)) continue;
    for (const label of declared) {
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

/** Every label NAME any layer can emit; the reserved-label roster the
 *  tracking-label validators are generated from. */
export function managedLabelNames(manifests: ModuleManifest[] = loadManifests()): string[] {
  return allLayerLabels(manifests).map((label) => label.name);
}

/** Two layers declaring one name is fine (the merge folds them); two
 *  declaring one name with DIFFERENT spellings is an authoring error the
 *  apply would fight over, so the merged roster is checked here. */
function assertUniqueNames(
  entries: { name: string }[],
  what: string,
  fold: (name: string) => string,
): void {
  const seen = new Map<string, string>();
  for (const { name } of entries) {
    const prior = seen.get(fold(name));
    if (prior !== undefined) {
      throw new Error(
        `the merged ${what} declare ${JSON.stringify(prior)} and ${JSON.stringify(name)}, ` +
          "which collide - two settings layers claim one name; rename one",
      );
    }
    seen.set(fold(name), name);
  }
}

/** The repo's tracking labels: the ONE settings contribution no layer
 *  file can express, because the label NAME is the repository's own
 *  copier answer (fuzzer_label / nightly_label) while the color and
 *  description tuple lives in the module manifest. */
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

/** copier.yml's computed enable_codeql from the same inputs: a public
 *  repository with at least one selected toolchain module. */
export function enableCodeql(facts: RepoFacts, manifests: ModuleManifest[]): boolean {
  return (
    !facts.private &&
    manifests.some((m) => m.toolchain !== undefined && facts.modules.includes(m.module))
  );
}

/** The managed settings document for a repo's facts: layers 1 to 4 merged
 *  in order, with the repo's tracking labels appended. Identity keys are
 *  absent on purpose - they live in the repo's own settings.yml, which
 *  merges OVER this document. */
export function managedSettings(
  facts: RepoFacts,
  manifests: ModuleManifest[] = loadManifests(),
): MergedSettings {
  const merged = mergeLayers(layerPaths(facts, manifests).map(loadLayer));
  const labels = [
    ...(Array.isArray(merged.labels) ? (merged.labels as Label[]) : []),
    ...trackingLabels(facts, manifests),
  ];
  // Appended AFTER the merge, which is safe without re-hardening the
  // document: `merged` is a MergedSettings already, and a Label is three
  // strings - neither side can reintroduce a null or a duplicate rule
  // type, and the compiler is what says so.
  if (labels.length > 0) merged.labels = labels;
  // Case-folded like GitHub's own label dedup; ruleset names match exactly.
  assertUniqueNames(labels, "labels", (name) => name.toLowerCase());
  assertUniqueNames(
    (Array.isArray(merged.rulesets) ? merged.rulesets : []) as { name: string }[],
    "rulesets",
    (name) => name,
  );
  return merged;
}

/** The merged label roster for a repo's facts. */
export function managedLabels(facts: RepoFacts, manifests: ModuleManifest[]): Label[] {
  const labels = managedSettings(facts, manifests).labels;
  return Array.isArray(labels) ? (labels as Label[]) : [];
}

/** The merged rulesets for a repo's facts. */
export function managedRulesets(
  facts: RepoFacts,
  manifests: ModuleManifest[],
): Record<string, unknown>[] {
  const rulesets = managedSettings(facts, manifests).rulesets;
  return Array.isArray(rulesets) ? (rulesets as Record<string, unknown>[]) : [];
}

// --- fact resolution --------------------------------------------------------

/** Modules from a .repo-platform.yml text; throws on a missing or
 *  malformed top-level list (the baseline cannot be computed from a
 *  guess). */
/** The module selection, VALIDATED against the manifest roster. An
 *  unknown name cannot be tolerated here the way an unknown key can:
 *  layerPaths simply finds no layer files for it, so a typo yields a
 *  perfectly valid-looking document that is missing that module's labels,
 *  and the apply's delete-undeclared pass then removes them from the live
 *  repository. A retired module is different - the template dropped it on
 *  purpose and repos may still list it - so it is dropped with a warning,
 *  the same tolerance sync/modules.ts applies (and the same single list,
 *  imported rather than mirrored). */
export function modulesFrom(
  registrationText: string,
  where: string,
  manifests: ModuleManifest[] = loadManifests(),
  retired: ReadonlySet<string> = RETIRED_MODULES,
): string[] {
  const modules = parseYamlMapping(registrationText, where).modules;
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === "string")) {
    throw new Error(`${where}: no readable top-level modules list`);
  }
  return assertKnownModules(modules, where, manifests, retired);
}

/** Every selection reaching the render goes through here, against the SAME
 *  manifest array the render uses - a validator keyed on its own roster
 *  could pass a name the render then finds no layers for. */
export function assertKnownModules(
  modules: string[],
  where: string,
  manifests: ModuleManifest[],
  retired: ReadonlySet<string> = RETIRED_MODULES,
): string[] {
  const known = new Set(manifests.map((m) => m.module));
  const kept: string[] = [];
  const unknown: string[] = [];
  for (const name of modules) {
    if (known.has(name)) kept.push(name);
    else if (retired.has(name)) warning(`${where}: module "${name}" is retired; ignoring it`);
    else unknown.push(name);
  }
  if (unknown.length > 0) {
    throw new Error(
      `${where}: unknown module(s) ${unknown.map((n) => JSON.stringify(n)).join(", ")} - not a ` +
        "template module and not retired. Applying the settings without them would compute a " +
        "roster missing their labels, and the apply deletes undeclared labels.",
    );
  }
  return kept;
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
  const answers = parseYamlMapping(answersText, where);
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

/** One file from a target, AT A PINNED REF. Every fact and the repo layer
 *  read at one commit: from the moving default branch, a push landing
 *  between two reads pairs an old module selection with a new repo layer,
 *  and the apply then deletes the labels of a module the repo had just
 *  selected. */
export type RepoFileFetcher = (repo: string, path: string, ref: string) => string | null;

export const fetchRepoFile: RepoFileFetcher = (repo, path, ref) => {
  const proc = captureNetwork([
    "gh",
    "api",
    `repos/${repo}/contents/${path}?ref=${ref}`,
    "-H",
    "Accept: application/vnd.github.raw",
  ]);
  if (proc.exitCode === 0) return proc.stdout;
  if (proc.stderr.includes("HTTP 404")) return null;
  throw new Error(`${repo}/${path}@${ref}: fetch failed (${proc.stderr.trim().split("\n")[0]})`);
};

/** The commit every read for this target pins to: the default branch's
 *  head, resolved ONCE per target. */
export function resolveTargetRef(repo: string): string {
  const branchProc = captureNetwork(["gh", "api", `repos/${repo}`, "--jq", ".default_branch"]);
  if (branchProc.exitCode !== 0) {
    throw new Error(
      `${repo}: cannot read the default branch (${branchProc.stderr.trim().split("\n")[0]})`,
    );
  }
  const branch = branchProc.stdout.trim();
  const head = captureNetwork(["gh", "api", `repos/${repo}/commits/${branch}`, "--jq", ".sha"]);
  if (head.exitCode !== 0) {
    throw new Error(`${repo}: cannot resolve ${branch} (${head.stderr.trim().split("\n")[0]})`);
  }
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${repo}: ${branch} resolved to no commit sha`);
  }
  return sha;
}

/** The commit a LOCAL fact source read from: the checkout's head. A local
 *  snapshot is no less stale than a fetched one - the branch it came from
 *  keeps moving - so it is pinned the same way and checked the same way.
 *  Empty when the directory is not a git checkout (the smoke harness
 *  renders a bare copier output), which check_target_fresh.ts refuses. */
export function localHeadSha(dir: string): string {
  const proc = capture(["git", "-C", dir, "rev-parse", "HEAD"]);
  const sha = proc.stdout.trim();
  return proc.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
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
 *  boolean shape is absent. Deliberately NOT the settings parse boundary:
 *  this is a peek at a fact, and a target whose settings.yml is malformed
 *  must fall back to the live probe rather than fail the render before it
 *  reaches the layer that would report the file properly. */
export function declaredPrivate(settingsText: string | null): boolean | null {
  if (settingsText === null) return null;
  let data: unknown;
  try {
    data = parseYaml(settingsText);
  } catch {
    return null;
  }
  const repository = isMapping(data) ? data.repository : null;
  const value = isMapping(repository) ? repository.private : null;
  return typeof value === "boolean" ? value : null;
}

/** Facts for the operator repository itself: it is not generated from the
 *  template (no .repo-platform.yml, no .copier-answers.yml), so its module
 *  selection and visibility come from the recorded operator answers file -
 *  the same answers the dogfood render uses (render_dogfood.ts pins its
 *  private answer to the in-repo settings.yml declaration). */
export function factsFromOperatorAnswers(
  answersPath: string,
  manifests: ModuleManifest[] = loadManifests(),
): RepoFacts {
  const answers = parseAnswers(readFileSync(answersPath, "utf-8"), answersPath);
  // The operator repository is ALWAYS a settings target, so an unknown
  // name here is the same destructive path as one in a client repo's
  // .repo-platform.yml: no layer files are found, the roster comes out
  // short, and the apply deletes the missing labels off this repository.
  const modules = assertKnownModules([...answers.modules], answersPath, manifests);
  const streams = manifests.filter(
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
export function factsFromFetch(
  repo: string,
  manifests: ModuleManifest[],
  ref: string,
  fetch: RepoFileFetcher = fetchRepoFile,
): RepoFacts {
  const registration = fetch(repo, ".repo-platform.yml", ref);
  if (registration === null) {
    throw new Error(
      `${repo}: no .repo-platform.yml on the default branch - the repo is not adopted, ` +
        "so there is no module selection to compute a settings baseline from",
    );
  }
  const modules = modulesFrom(registration, `${repo}/.repo-platform.yml`, manifests);
  const isPrivate =
    declaredPrivate(fetch(repo, ".github/settings.yml", ref)) ?? fetchRepoIsPrivate(repo);
  const streams = manifests.filter(
    (m) => m.tracking_label !== undefined && modules.includes(m.module),
  );
  let trackingLabels: { module: string; label: string }[] = [];
  if (streams.length > 0) {
    const answers = fetch(repo, ".copier-answers.yml", ref);
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
    manifests,
  );
  const answersText = readFileSync(join(dir, ".copier-answers.yml"), "utf-8");
  const settingsPath = join(dir, ".github/settings.yml");
  const declared = declaredPrivate(
    existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null,
  );
  const recorded = parseYamlMapping(answersText, where(".copier-answers.yml")).private;
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

/** The opt-in, rechecked at the PINNED commit. Selection happened in the
 *  plan job against whatever the default branch held then; a repo that
 *  dropped settings-sync in between would otherwise still get a baseline
 *  built from the opted-out revision and applied - deleting labels after
 *  the repo turned management off. The operator repository is exempt: it
 *  has no .repo-platform.yml and opts in by being the operator. */
const SETTINGS_MODULE = "settings-sync";

/** Whether this run may write a baseline at all. A pure decision so the
 *  refusal is testable on its own: asserting that facts round-trip a
 *  module list proves nothing about whether the render acts on them. */
export type RenderDecision = { kind: "render" } | { kind: "skip"; reason: string };

export function renderDecision(
  facts: RepoFacts,
  source: "fetch" | "target-dir" | "operator",
  repo: string,
): RenderDecision {
  // The operator repository has no .repo-platform.yml; it opts in by
  // being the operator, so there is no selection to recheck.
  if (source === "operator") return { kind: "render" };
  if (facts.modules.includes(SETTINGS_MODULE)) return { kind: "render" };
  return {
    kind: "skip",
    reason:
      `${repo}: the ${SETTINGS_MODULE} module is not selected at the revision these facts were ` +
      "read from, so settings are no longer managed here and this apply is SKIPPED. Applying " +
      "anyway would reconcile - and delete - labels on a repository that has turned central " +
      "settings off.",
  };
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
  // Published so the merge step reads the repo layer at the SAME commit
  // these facts came from, and so the freshness step can tell whether the
  // target moved since. Every fact source pins, local ones included.
  let pinnedRef = "";
  // The opt-in can be dropped between the plan job's selection and this
  // read; when it has been, nothing is written and the apply is gated off.
  let optedOut = false;
  try {
    const manifests = loadManifests();
    if (flags["--target-dir"] !== undefined) {
      facts = factsFromTargetDir(flags["--target-dir"], manifests);
      pinnedRef = localHeadSha(flags["--target-dir"]);
    } else if (flags["--operator-answers"] !== undefined) {
      facts = factsFromOperatorAnswers(flags["--operator-answers"], manifests);
      pinnedRef = localHeadSha(dirname(resolve(flags["--operator-answers"])));
    } else {
      // Resolved BEFORE any read, and published below, so the merge step
      // reads the repo layer at this same commit.
      pinnedRef = resolveTargetRef(repo);
      facts = factsFromFetch(repo, manifests, pinnedRef);
    }
    const source =
      flags["--target-dir"] !== undefined
        ? "target-dir"
        : flags["--operator-answers"] !== undefined
          ? "operator"
          : "fetch";
    const decision = renderDecision(facts, source, repo);
    if (decision.kind === "skip") {
      warning(decision.reason);
      optedOut = true;
    } else {
      writeFileSync(flags["--out"], renderManagedYaml(facts, manifests));
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  setOutput("ref", pinnedRef);
  setOutput("skipped", String(optedOut));
  if (optedOut) {
    console.log("skipped: the target no longer selects the settings module");
    return;
  }
  console.log(
    `rendered the managed settings baseline for ${facts.modules.length} module(s) into ${flags["--out"]}` +
      (pinnedRef === "" ? "" : ` at ${pinnedRef}`),
  );
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
