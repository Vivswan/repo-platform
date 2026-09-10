// The repository inputs more than one rule group keys on: the repo root,
// file and tree readers, and the parsed documents (the manifests and
// copier.yml memoized, the rest re-read per call).

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { allLayerLabels } from "../../../.github/scripts/fleet/settings_layers.ts";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import { trackingStreams } from "../../generate/copier_questions.ts";
import type { JinjaVars } from "../../lib/jinja_subset.ts";
import {
  loadManifests as loadManifestsFresh,
  type ModuleManifest,
} from "../../lib/module_manifests.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

/** Every path git tracks in this repository. capture() carries the hang
 *  bound a bare piped spawn lacks (the spawn-sync-hang-bound rule's
 *  semantics - the checker must not be its own counterexample). */
export function trackedFiles(): string[] {
  const proc = capture(["git", "-C", REPO_ROOT, "ls-files", "-z"]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `git ls-files failed${proc.timedOut ? " (timed out)" : ""}: ${proc.stderr.trim()}`,
    );
  }
  return proc.stdout.split("\0").filter(Boolean);
}

/** Rules re-derive these shared inputs dozens of times per run and the
 *  underlying files never change mid-run; memoize the parse, not the
 *  callers. */
function memoize<T>(compute: () => T): () => T {
  let cached = false;
  let value: T | undefined;
  return () => {
    if (!cached) {
      value = compute();
      cached = true;
    }
    return value as T;
  };
}

export const loadManifests = memoize(loadManifestsFresh);

export function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

export const copierConfig = memoize(
  (): Record<string, unknown> => asRecord(parseYaml(read("copier.yml")), "copier.yml"),
);

/** The manifests' tracking_label streams (fuzzer, nightly, ...): the single
 *  source the hand-written copier questions and doc constants are anchored
 *  to. The list comes from scripts/generate/copier_questions.ts's trackingStreams (which throws when
 *  no manifest declares one), so every rule keyed on it fails loudly rather
 *  than passing vacuously and can never disagree with the generated
 *  tracking-labels regions. */
export function trackingManifests(): {
  module: string;
  tracking: NonNullable<ModuleManifest["tracking_label"]>;
}[] {
  return trackingStreams(loadManifests()).map((m) => ({
    module: m.module,
    tracking: m.tracking_label,
  }));
}

export function jinjaVars(): JinjaVars {
  const username = asRecord(copierConfig().github_username, "copier.yml github_username").default;
  if (typeof username !== "string" || username === "") {
    throw new Error("copier.yml: github_username has no string default");
  }
  const holder = asRecord(copierConfig().copyright_holder, "copier.yml copyright_holder").default;
  if (typeof holder !== "string" || holder === "") {
    throw new Error("copier.yml: copyright_holder has no string default");
  }
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  return { username, slug: String(pkg.name), copyrightHolder: holder };
}

export function packageScripts(): Record<string, string> {
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  return asRecord(pkg.scripts, "package.json scripts") as Record<string, string>;
}

export function repoCi(): Record<string, unknown> {
  return asRecord(parseYaml(read(".github/workflows/ci.yml")), "ci.yml");
}

export function ciJobs(ci: Record<string, unknown>, where: string): Record<string, unknown> {
  return asRecord(ci.jobs, `${where} jobs`);
}

/** All non-directory paths below `rel` (repo-relative), sorted; skips
 *  node_modules. Symlinks are returned but flagged. */
export function walkFiles(rel: string): { path: string; symlink: boolean }[] {
  const found: { path: string; symlink: boolean }[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(join(REPO_ROOT, dir)).sort()) {
      if (name === "node_modules") continue;
      const childRel = `${dir}/${name}`;
      const stat = lstatSync(join(REPO_ROOT, childRel));
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(childRel);
      else found.push({ path: childRel, symlink: stat.isSymbolicLink() });
    }
  };
  visit(rel);
  return found;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

/** Every label tuple any settings LAYER can emit for ANY selection and
 *  either visibility - tracking labels excluded (they render from
 *  per-repo answers). The single roster the doc-constant and issue-form
 *  rules key on. */
export function managedLabelRoster(): Label[] {
  return allLayerLabels(loadManifests());
}
