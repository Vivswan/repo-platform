// Mirrors: byte copies of files this sync wrote, declared in the target's
// registration. A target that holds anything but the previous mirror (the
// recorded hash) or the new content is refused, never overwritten.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Registration } from "../../../../actions/plan/registration.ts";
import { lstatOrNull } from "../../shared/fs_probe.ts";
import { pathProblem } from "./files_config.ts";
import { type Records, recordedHash, sha256 } from "./manifest.ts";
import { existingFile, writeFile } from "./target_files.ts";

export interface MirrorRow {
  source: string;
  target: string;
  outcome: "written" | "current" | "refused";
  detail: string;
}

/** Why a declared mirror path cannot be written, or null. `selected` is
 *  every path files.yml writes for this repository, starters included. */
export function mirrorPathProblem(path: string, selected: ReadonlySet<string>): string | null {
  const problem = pathProblem(path);
  if (problem !== null) return problem;
  const lower = path.toLowerCase();
  if (lower.startsWith(".github/workflows/")) return "sits under .github/workflows/";
  if (selected.has(path)) return "is a path files.yml writes";
  return null;
}

/** The concrete paths a single-segment `*` pattern names under `root`: a
 *  `*` in a directory segment matches directories, a final `*` matches
 *  existing regular files, a literal final segment lands in every matched
 *  directory. A pattern without `*` is itself. */
export function expandPattern(root: string, pattern: string): string[] {
  if (!pattern.includes("*")) return [pattern];
  let prefixes = [""];
  const segments = pattern.split("/");
  segments.forEach((segment, index) => {
    const final = index === segments.length - 1;
    const next: string[] = [];
    for (const prefix of prefixes) {
      const rel = (name: string) => (prefix === "" ? name : `${prefix}/${name}`);
      if (!segment.includes("*")) {
        next.push(rel(segment));
        continue;
      }
      const re = new RegExp(`^${segment.split("*").map(escapeRe).join("[^/]*")}$`);
      const dir = join(root, prefix);
      if (lstatOrNull(dir)?.isDirectory() !== true) continue;
      for (const name of readdirSync(dir).sort()) {
        if (!re.test(name)) continue;
        const stat = lstatOrNull(join(dir, name));
        if (
          stat !== null &&
          !stat.isSymbolicLink() &&
          (final ? stat.isFile() : stat.isDirectory())
        ) {
          next.push(rel(name));
        }
      }
    }
    prefixes = next;
  });
  return prefixes.sort();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Copies every declared mirror whose source this sync wrote. `written`
 *  maps the managed and split paths written this run to their bytes,
 *  `selected` is every selected entry path (no mirror may land on one),
 *  and `records` are the previous sync's, read for the last mirror hash. */
export function applyMirrors(
  target: string,
  mirrors: NonNullable<Registration["mirrors"]>,
  written: ReadonlyMap<string, Buffer>,
  selected: ReadonlySet<string>,
  records: Records,
): MirrorRow[] {
  const rows: MirrorRow[] = [];
  const refuse = (source: string, path: string, detail: string) =>
    rows.push({ source, target: path, outcome: "refused", detail });
  // Pass one resolves every declaration to concrete targets, so a target
  // two sources claim is refused for both instead of alternating between
  // them run after run.
  const claims: { source: string; path: string }[] = [];
  for (const { source, targets } of mirrors) {
    for (const pattern of targets) {
      const patternProblem = pattern.includes("**")
        ? "uses '**'"
        : mirrorPathProblem(pattern, selected);
      if (patternProblem !== null) {
        refuse(source, pattern, `the pattern ${patternProblem}`);
        continue;
      }
      for (const path of expandPattern(target, pattern)) {
        const problem = mirrorPathProblem(path, selected);
        if (problem !== null) refuse(source, path, `the target ${problem}`);
        else claims.push({ source, path });
      }
    }
  }
  const sourcesOf = (path: string) =>
    new Set(claims.filter((c) => c.path === path).map((c) => c.source));
  for (const { source, path } of claims) {
    if (sourcesOf(path).size > 1) {
      refuse(source, path, "the target is claimed by more than one source");
      continue;
    }
    // Refused per concrete target, so each keeps its previous record.
    const bytes = written.get(source);
    if (bytes === undefined) {
      refuse(source, path, "the source is not a file this sync writes");
      continue;
    }
    const existing = existingFile(target, path);
    if (existing?.equals(bytes) === true) {
      rows.push({ source, target: path, outcome: "current", detail: "" });
      continue;
    }
    if (existing !== null && sha256(existing) !== recordedHash(records, path)) {
      refuse(source, path, "the target holds content that is not the previous mirror");
      continue;
    }
    writeFile(target, path, bytes);
    rows.push({ source, target: path, outcome: "written", detail: "" });
  }
  return rows;
}
