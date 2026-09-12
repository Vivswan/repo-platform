import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import {
  allLayerLabels,
  layerConfig,
  loadModules,
  type Module,
} from "../../../.github/scripts/sync/writer/settings_layers.ts";
import { parseFilesConfig } from "../../../actions/plan/files_config.ts";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** A bare `{{` opens a YAML flow mapping, so placeholders become a plain word before parsing, line count preserved;
 *  `${{ }}` expressions ride through. */
export function neutralizePlaceholders(text: string): string {
  return text
    .replace(/^\{\{blocks\}\}$/gm, "# blocks")
    .replace(/(\$?)\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g, (token, dollar: string) =>
      dollar === "" ? "placeholder" : token,
    );
}

export function readSource(rel: string): string {
  const text = read(rel);
  return rel.startsWith("files/") ? neutralizePlaceholders(text) : text;
}

export function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf-8");
}

/** capture() carries the hang bound a bare piped spawn lacks: the checker must not be its own counterexample to the spawn-sync-hang-bound rule. */
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

export const modules = memoize((): Module[] => loadModules(join(REPO_ROOT, "files.yml")));

export const filesConfig = memoize(() => parseFilesConfig(read("files.yml")));

export function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected a mapping`);
  }
  return value as Record<string, unknown>;
}

export interface TrackingStream {
  module: string;
  key: string;
  default: string;
  color: string;
  description: string;
}

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

/** Tracking labels are not here: they come from each repository's registration, not from a layer. */
export function managedLabelRoster(): Label[] {
  return allLayerLabels(layerConfig(filesConfig()), join(REPO_ROOT, "files"));
}
