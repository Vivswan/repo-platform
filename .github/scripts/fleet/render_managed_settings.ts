#!/usr/bin/env bun
// Selects and merges settings LAYERS 1 to 4 for a repository (the six-layer
// model: docs/settings.md). No settings VALUES live here: every layer is a
// plain settings-as-code document (the fleet baseline and its visibility
// overlay under .github/, each selected module's layer files under
// files/<module>/, declared in files.yml's settings_layers), and this
// script only picks the ones a repo's facts select and merges them;
// merge_settings_layers.ts owns the dialect and adds the repo's own
// settings.yml and the fleet override on top. No layer file is ever synced
// into a client repo. Facts: the module selection and the tracking labels
// (.repo-platform.yml, the one registration every fleet member carries,
// this repository included) and the effective visibility (private repos
// reject the public-only layers with a 422).
// CLI: bun .github/scripts/fleet/render_managed_settings.ts --repo owner/name
//   --out managed.yml [--target-dir <checkout>]
// By default the facts come from the target's default branch via gh api
// (env: GH_TOKEN), visibility the DECLARED repository.private in its
// settings.yml, live-probed when undeclared; --target-dir reads a local
// checkout (the operator repository is its own checkout).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  type ModuleData,
  parseFilesConfig,
  SETTINGS_LAYER_ORDER,
  type SettingsLayerName,
} from "../../../actions/plan/files_config.ts";
import { parseRegistration } from "../../../actions/plan/registration.ts";
import { parseFlags } from "../shared/flags.ts";
import { fail, setOutput, warning } from "../shared/gha.ts";
import { capture } from "../shared/proc.ts";
import { captureNetwork } from "./discovery.ts";
import { mergeLayers } from "./merge_settings_layers.ts";
import {
  isMapping,
  type MergedSettings,
  parseLayerFile,
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
  /** Resolved tracking labels, one per SELECTED stream module. */
  trackingLabels: { module: string; label: string }[];
  /** Whether the pinned revision carries the pr-title module's managed
   *  workflow (PR_TITLE_WORKFLOW). Selecting the module activates its
   *  required-check ruleset, and a check nothing creates wedges every PR,
   *  so activation additionally waits for the workflow to be ON the
   *  default branch - the sync delivering it can land in any order
   *  relative to the apply. Deselection needs no such gate: the baseline
   *  heals the ruleset back to disabled the moment the module leaves the
   *  selection. */
  prTitleWorkflowPresent: boolean;
}

/** One module of files.yml, named. */
export type Module = ModuleData & { name: string };

// --- the settings layers ----------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

export const FILES_CONFIG = join(REPO_ROOT, "files.yml");
export const FILES_DIR = join(REPO_ROOT, "files");

export const BASELINE_LAYER = join(REPO_ROOT, ".github/settings-baseline.yml");
export const FLEET_PUBLIC_LAYER = join(REPO_ROOT, ".github/settings-public.yml");
export const FLEET_PRIVATE_LAYER = join(REPO_ROOT, ".github/settings-private.yml");

const [MODULE_LAYER, MODULE_PUBLIC_LAYER, MODULE_PRIVATE_LAYER] = SETTINGS_LAYER_ORDER;

/** files.yml's modules in canonical order, the roster every fact and layer
 *  selection is checked against. */
export function loadModules(path: string = FILES_CONFIG): Module[] {
  const modules = parseFilesConfig(readFileSync(path, "utf-8"), path).modules;
  return Object.entries(modules).map(([name, data]) => ({ ...data, name }));
}

function moduleLayerPath(module: string, name: SettingsLayerName, filesDir: string): string {
  return join(filesDir, module, name);
}

/** A module directory's entries, none when it does not exist. */
function listDir(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** The three fleet layer files, unconditional by design, and every layer
 *  file the modules declare, in BOTH directions: a declared file that is
 *  missing and a present layer file no declaration names are each a hard
 *  error before any layer is read, because selecting by existence would
 *  fail OPEN (a deleted layer or a dropped declaration silently shrinks
 *  the stack, and the apply's delete-undeclared pass then removes its
 *  labels fleet-wide). `exists` and `list` are injectable so a test can
 *  prove either failure without touching files/. */
export function assertLayerFiles(
  modules: Module[],
  exists: (path: string) => boolean = existsSync,
  filesDir: string = FILES_DIR,
  list: (dir: string) => string[] = listDir,
): void {
  for (const path of [BASELINE_LAYER, FLEET_PUBLIC_LAYER, FLEET_PRIVATE_LAYER]) {
    if (!exists(path)) {
      throw new Error(
        `${path}: fleet settings layer is missing - every repository's baseline is built on ` +
          "it, so rendering without it would apply a fleet-wide document missing its defaults",
      );
    }
  }
  for (const module of modules) {
    for (const name of module.settings_layers ?? []) {
      const path = moduleLayerPath(module.name, name, filesDir);
      if (!exists(path)) {
        throw new Error(
          `${path}: declared in files.yml modules.${module.name}.settings_layers but missing - ` +
            "a deleted layer file must retire its settings_layers entry in the same change, " +
            "or the render would silently drop the module's labels and the apply delete them",
        );
      }
    }
    const declared = new Set<string>(module.settings_layers ?? []);
    for (const name of list(join(filesDir, module.name))) {
      if ((SETTINGS_LAYER_ORDER as readonly string[]).includes(name) && !declared.has(name)) {
        throw new Error(
          `${join(filesDir, module.name, name)}: a settings layer file files.yml ` +
            `modules.${module.name}.settings_layers does not declare - the render never reads ` +
            "an undeclared layer, so its labels would leave the roster and the apply delete " +
            "them; declare it or delete the file",
        );
      }
    }
  }
}

/** Every layer file a repository's facts select, LOW to HIGH: the fleet
 *  baseline, the fleet visibility overlay, each selected module's own layer,
 *  then each module's visibility overlay (the repo's settings.yml and the
 *  override are layers 5 and 6, merged at apply time). Which module files
 *  exist is DECLARED (files.yml's settings_layers), never discovered. */
export function layerPaths(
  facts: RepoFacts,
  modules: Module[],
  exists: (path: string) => boolean = existsSync,
  filesDir: string = FILES_DIR,
  list: (dir: string) => string[] = listDir,
): string[] {
  assertLayerFiles(modules, exists, filesDir, list);
  const visibility = facts.private ? MODULE_PRIVATE_LAYER : MODULE_PUBLIC_LAYER;
  const selected = modules.filter((m) => facts.modules.includes(m.name));
  const declares = (m: Module, name: SettingsLayerName) => (m.settings_layers ?? []).includes(name);
  // pr-title's layer is the enforcement flip of the baseline's disabled
  // required-check ruleset, so it additionally waits for the managed
  // workflow to exist at the pinned revision (the RepoFacts field has the
  // race): activating a required check nothing creates wedges every PR.
  const activatable = (m: Module) => m.name !== "pr-title" || facts.prTitleWorkflowPresent;
  return [
    BASELINE_LAYER,
    facts.private ? FLEET_PRIVATE_LAYER : FLEET_PUBLIC_LAYER,
    ...selected
      .filter((m) => declares(m, MODULE_LAYER) && activatable(m))
      .map((m) => moduleLayerPath(m.name, MODULE_LAYER, filesDir)),
    ...selected
      .filter((m) => declares(m, visibility))
      .map((m) => moduleLayerPath(m.name, visibility, filesDir)),
  ];
}

/** One layer document, through the settings parse boundary: the file is
 *  known here, so a rule that declares no `type` names this file and the
 *  position inside it. */
export function loadLayer(path: string): SettingsLayer {
  return parseLayerFile(readFileSync(path, "utf-8"), path);
}

/** Every label tuple any layer can emit, for ANY module selection and
 *  either visibility; tracking labels excluded (those come from each
 *  repository's registration). The single roster the reserved-label
 *  derivation and the checks key on. Reads exactly the DECLARED layer
 *  files, so a deleted layer fails the load loudly instead of quietly
 *  shrinking this roster. */
export function allLayerLabels(
  modules: Module[] = loadModules(),
  filesDir: string = FILES_DIR,
): Label[] {
  assertLayerFiles(modules, existsSync, filesDir);
  const labels: Label[] = [];
  const paths = [BASELINE_LAYER, FLEET_PUBLIC_LAYER, FLEET_PRIVATE_LAYER];
  for (const m of modules) {
    for (const name of m.settings_layers ?? []) {
      paths.push(moduleLayerPath(m.name, name, filesDir));
    }
  }
  for (const path of paths) {
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

/** Every label NAME any layer can emit: the roster no tracking label may
 *  reuse (the plan action refuses one, from the build branch's copy). */
export function managedLabelNames(modules: Module[] = loadModules()): string[] {
  return allLayerLabels(modules).map((label) => label.name);
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
 *  (its registration's labels.<key>, else the module default) while the
 *  color and description tuple lives in files.yml. */
export function trackingLabels(facts: RepoFacts, modules: Module[]): Label[] {
  const byName = new Map(modules.map((m) => [m.name, m]));
  return facts.trackingLabels.map(({ module, label }) => {
    const tracking = byName.get(module)?.tracking_label;
    if (tracking?.color === undefined || tracking.description === undefined) {
      throw new Error(
        `tracking label recorded for '${module}', but files.yml modules.${module} declares no ` +
          "tracking_label with a color and description - the facts and the data file disagree",
      );
    }
    return { name: label, color: tracking.color, description: tracking.description };
  });
}

/** The managed settings document for a repo's facts: layers 1 to 4 merged
 *  in order, with the repo's tracking labels appended. Identity keys are
 *  absent on purpose - they live in the repo's own settings.yml, which
 *  merges OVER this document. */
export function managedSettings(
  facts: RepoFacts,
  modules: Module[] = loadModules(),
  filesDir: string = FILES_DIR,
): MergedSettings {
  const merged = mergeLayers(layerPaths(facts, modules, existsSync, filesDir).map(loadLayer));
  const labels = [
    ...(Array.isArray(merged.labels) ? (merged.labels as Label[]) : []),
    ...trackingLabels(facts, modules),
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
export function managedLabels(facts: RepoFacts, modules: Module[]): Label[] {
  const labels = managedSettings(facts, modules).labels;
  return Array.isArray(labels) ? (labels as Label[]) : [];
}

/** The merged rulesets for a repo's facts. */
export function managedRulesets(facts: RepoFacts, modules: Module[]): Record<string, unknown>[] {
  const rulesets = managedSettings(facts, modules).rulesets;
  return Array.isArray(rulesets) ? (rulesets as Record<string, unknown>[]) : [];
}

// --- fact resolution --------------------------------------------------------

/** The registration facts of a .repo-platform.yml text, read with the
 *  plan's own grammar (fail-closed: a YAML error, an unknown key, a
 *  malformed list) and VALIDATED against the module roster. An unknown
 *  name throws: layerPaths simply finds no layer files for it, so a typo
 *  would yield a perfectly valid-looking document missing that module's
 *  labels, and the apply's delete-undeclared pass would then remove them
 *  from the live repository. `reserved` is the lower-cased roster of every
 *  label the layers manage (managedLabelNames), injectable for tests. */
export function registrationFacts(
  text: string,
  where: string,
  modules: Module[],
  reserved: ReadonlySet<string> = new Set(
    managedLabelNames(modules).map((name) => name.toLowerCase()),
  ),
): { modules: string[]; trackingLabels: { module: string; label: string }[] } {
  const read = parseRegistration(text, where);
  if ("errors" in read) throw new Error(read.errors.join("\n"));
  const selected = assertKnownModules(read.registration.modules, where, modules);
  const declared = read.registration.labels ?? {};
  const streams = modules.filter(
    (m) => m.tracking_label !== undefined && selected.includes(m.name),
  );
  const keys = new Set(streams.map((m) => m.tracking_label?.key));
  const stray = Object.keys(declared).filter((key) => !keys.has(key));
  if (stray.length > 0) {
    throw new Error(
      `${where}: labels.${stray[0]} names no selected tracking stream ` +
        `(selected: ${[...keys].join(", ") || "none"})`,
    );
  }
  const trackingLabels = streams.map((m) => {
    const tracking = m.tracking_label;
    if (tracking === undefined) throw new Error("unreachable: filtered on tracking_label");
    return { module: m.name, key: tracking.key, label: declared[tracking.key] ?? tracking.default };
  });
  // The same refusal the plan action makes from the build branch's
  // reserved roster: a stream label the layers already manage would have
  // a green night close unrelated issues and every apply fight over it.
  for (const { key, label } of trackingLabels) {
    if (reserved.has(label.toLowerCase())) {
      throw new Error(
        `${where}: tracking label "${label}" (${key}) is a label the platform already manages; ` +
          "a green night would close whatever issues carry it and every settings apply would fight over it",
      );
    }
  }
  return {
    modules: selected,
    trackingLabels: trackingLabels.map(({ module, label }) => ({ module, label })),
  };
}

/** Every selection reaching the render goes through here, against the SAME
 *  module roster the render uses - a validator keyed on its own roster
 *  could pass a name the render then finds no layers for. */
export function assertKnownModules(selected: string[], where: string, modules: Module[]): string[] {
  const known = new Set(modules.map((m) => m.name));
  const unknown = selected.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `${where}: unknown module(s) ${unknown.map((n) => JSON.stringify(n)).join(", ")} - not a ` +
        "module files.yml knows. Applying the settings without them would compute a roster " +
        "missing their labels, and the apply deletes undeclared labels; fix the modules list.",
    );
  }
  return selected;
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
 *  Empty when the directory is not a git checkout, which
 *  check_target_fresh.ts refuses. */
export function localHeadSha(dir: string): string {
  const proc = capture(["git", "-C", dir, "rev-parse", "HEAD"]);
  const sha = proc.stdout.trim();
  return proc.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : "";
}

/** Live visibility, failing closed like every other probe: only an
 *  explicit "false" proves the repo public. A probe failure throws - a
 *  wrong visibility would apply the public-only blocks to a private repo
 *  (422) or silently drop them from a public one. Live and UNPINNED,
 *  unlike every content fact: the freshness recheck pins commits, not
 *  visibility, so a flip landing mid-run applies the wrong overlay until
 *  the next nightly heal - a documented narrowed-not-closed window
 *  (docs/settings.md), accepted rather than closed. */
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

/** The pr-title module's managed workflow, whose presence at the pinned
 *  revision gates the required-check activation (RepoFacts has the race). */
export const PR_TITLE_WORKFLOW = ".github/workflows/pr-title.yml";

export const REGISTRATION_FILE = ".repo-platform.yml";
export const SETTINGS_FILE = ".github/settings.yml";

/** Facts fetched from the target's default branch (gh api), or null when it
 *  carries no .repo-platform.yml at `ref` (it left management between the
 *  plan job's selection and this read; the caller skips it). Visibility is
 *  the DECLARED repository.private in its settings.yml when boolean, else
 *  the live probe: the apply flips visibility to the declared value first,
 *  so the visibility-gated blocks must match the POST-apply state, and
 *  deriving them from live visibility would 422 the very apply performing
 *  a deliberate flip. */
export function factsFromFetch(
  repo: string,
  modules: Module[],
  ref: string,
  fetch: RepoFileFetcher = fetchRepoFile,
): RepoFacts | null {
  const registration = fetch(repo, REGISTRATION_FILE, ref);
  if (registration === null) return null;
  const facts = registrationFacts(registration, `${repo}/${REGISTRATION_FILE}`, modules);
  const isPrivate = declaredPrivate(fetch(repo, SETTINGS_FILE, ref)) ?? fetchRepoIsPrivate(repo);
  // Probed only where it can matter (the module selected): a 404 is a
  // genuine absence (fetch returns null), any other failure throws - a
  // presence misread must never silently flip the required check.
  const prTitleWorkflowPresent =
    facts.modules.includes("pr-title") && fetch(repo, PR_TITLE_WORKFLOW, ref) !== null;
  return { ...facts, private: isPrivate, prTitleWorkflowPresent };
}

/** Facts read from a local checkout: the operator repository reads its own
 *  this way (settings_layer_step.ts passes --target-dir . for it). Null
 *  when the checkout carries no .repo-platform.yml (it is not a settings
 *  target), like the fetched source. The visibility is the checkout's
 *  DECLARED repository.private; a checkout declaring none cannot have its
 *  visibility-gated blocks computed and throws. */
export function factsFromTargetDir(dir: string, modules: Module[]): RepoFacts | null {
  const registrationPath = join(dir, REGISTRATION_FILE);
  if (!existsSync(registrationPath)) return null;
  const facts = registrationFacts(
    readFileSync(registrationPath, "utf-8"),
    registrationPath,
    modules,
  );
  const settingsPath = join(dir, SETTINGS_FILE);
  const declared = declaredPrivate(
    existsSync(settingsPath) ? readFileSync(settingsPath, "utf-8") : null,
  );
  if (declared === null) {
    throw new Error(
      `${settingsPath}: declares no boolean repository.private - the baseline's ` +
        "visibility-gated blocks cannot be computed",
    );
  }
  return {
    ...facts,
    private: declared,
    prTitleWorkflowPresent: existsSync(join(dir, PR_TITLE_WORKFLOW)),
  };
}

/** The header naming the generator, so a stray scratch file self-identifies. */
const MANAGED_YAML_HEADER =
  "# Managed settings baseline, computed by repo-platform's\n" +
  "# .github/scripts/fleet/render_managed_settings.ts - scratch output, never committed.\n";

/** The managed document as YAML bytes, headed by MANAGED_YAML_HEADER. */
export function renderManagedYaml(facts: RepoFacts, modules?: Module[]): string {
  return MANAGED_YAML_HEADER + stringifyYaml(managedSettings(facts, modules));
}

/** The skip a target earns by leaving management between the plan job's
 *  selection and this read: no .repo-platform.yml at the pinned commit
 *  means no selection to compute a baseline from, and applying one built
 *  from an older revision would reconcile - and delete - labels on a
 *  repository that is no longer managed. Adoption IS the opt-in: every
 *  repository with a registration file is a settings target. */
export function leftManagementReason(repo: string): string {
  return (
    `${repo}: no .repo-platform.yml at the revision these facts were read from - the ` +
    "repository left management, so this apply is SKIPPED. Applying anyway would reconcile " +
    "- and delete - labels on a repository that is no longer managed."
  );
}

function main(args: string[]): void {
  const flags = parseFlags(args, ["--repo", "--out"] as const, ["--target-dir"] as const);
  const repo = flags["--repo"];
  // Null after the reads when the target left management (no registration
  // at the pinned revision): nothing is written and the apply is gated off.
  let facts: RepoFacts | null = null;
  // Published so the merge step reads the repo layer at the SAME commit
  // these facts came from, and so the freshness step can tell whether the
  // target moved since. Every fact source pins, local ones included.
  let pinnedRef = "";
  try {
    const modules = loadModules();
    if (flags["--target-dir"] !== undefined) {
      facts = factsFromTargetDir(flags["--target-dir"], modules);
      pinnedRef = localHeadSha(flags["--target-dir"]);
    } else {
      // Resolved BEFORE any read, and published below, so the merge step
      // reads the repo layer at this same commit.
      pinnedRef = resolveTargetRef(repo);
      facts = factsFromFetch(repo, modules, pinnedRef);
    }
    if (facts === null) {
      warning(leftManagementReason(repo));
    } else {
      writeFileSync(flags["--out"], renderManagedYaml(facts, modules));
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  setOutput("ref", pinnedRef);
  setOutput("skipped", String(facts === null));
  if (facts === null) {
    console.log(
      "skipped: the target left management (no .repo-platform.yml at the pinned revision)",
    );
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
