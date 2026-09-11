// The repository inputs more than one rule group keys on: the repo root,
// the owner, file and tree readers, and the parsed documents (files.yml
// memoized, the rest re-read per call).

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  allLayerLabels,
  loadModules,
  type Module,
} from "../../../.github/scripts/fleet/render_managed_settings.ts";
import { capture } from "../../../.github/scripts/shared/proc.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** The GitHub owner of this repository and of every fleet member: the
 *  owner slot every fleet-facing pin and PAT URL spells. */
export const OWNER = "Vivswan";

/** A writer source with its `{{name}}` placeholders replaced by a plain
 *  word and its blocks anchor line by a comment, line count preserved, so
 *  the YAML parses the way the written file will (a bare `{{` opens a flow
 *  mapping); `${{ }}` expressions are not placeholders and ride through. */
export function neutralizePlaceholders(text: string): string {
  return text
    .replace(/^\{\{blocks\}\}$/gm, "# blocks")
    .replace(/(\$?)\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, (token, dollar: string) =>
      dollar === "" ? "placeholder" : token,
    );
}

/** A writer source read for parsing: placeholders neutralized under files/,
 *  every other path verbatim. */
export function readSource(rel: string): string {
  const text = read(rel);
  return rel.startsWith("files/") ? neutralizePlaceholders(text) : text;
}

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

/** files.yml's modules in canonical order, with their data. */
export const modules = memoize((): Module[] => loadModules(join(REPO_ROOT, "files.yml")));

export function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

/** One tracking stream: the module and its files.yml tracking_label,
 *  color and description included. */
export interface TrackingStream {
  module: string;
  key: string;
  default: string;
  color: string;
  description: string;
}

/** files.yml's tracking_label streams (fuzzer, nightly, ...), in canonical
 *  order, the single source the doc constants and the label tuples are
 *  anchored to; throws when no module declares one or a stream lacks its
 *  tuple, so every rule keyed on it fails loudly. */
export function trackingStreams(): TrackingStream[] {
  const streams = modules().flatMap((m): TrackingStream[] => {
    const tracking = m.tracking_label;
    if (tracking === undefined) return [];
    if (tracking.color === undefined || tracking.description === undefined) {
      throw new Error(
        `files.yml modules.${m.name}.tracking_label: no color or description - anchor lost`,
      );
    }
    return [
      {
        module: m.name,
        key: tracking.key,
        default: tracking.default,
        color: tracking.color,
        description: tracking.description,
      },
    ];
  });
  if (streams.length === 0) throw new Error("files.yml declares no tracking_label - anchor lost");
  return streams;
}

/** The repository slug (package.json's name) beside the owner. */
export function repoSlug(): string {
  const pkg = asRecord(JSON.parse(read("package.json")), "package.json");
  return String(pkg.name);
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
 *  either visibility - tracking labels excluded (they come from each
 *  repository's registration). The single roster the doc-constant rules
 *  key on. */
export function managedLabelRoster(): Label[] {
  return allLayerLabels(modules());
}
