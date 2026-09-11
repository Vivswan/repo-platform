#!/usr/bin/env bun
// The file table of files.yml as Markdown (path, class, when). --write
// rewrites a Markdown file's generated region (bun run regen); --check
// compares it instead (bun run files:check, in the check chain and CI).
//
// Usage: bun scripts/files_table.ts [--check|--write docs/new-repo.md]

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type FileEntry, parseFilesConfig, type When } from "../actions/plan/files_config.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
export const BEGIN =
  "<!-- BEGIN GENERATED: files-table (scripts/files_table.ts - edit files.yml, not this block) -->";
export const END = "<!-- END GENERATED: files-table -->";

export function describeWhen(when: When | null): string {
  if (when === null) return "always";
  const parts: string[] = [];
  if (when.modules) parts.push(`modules: ${when.modules.map((m) => `\`${m}\``).join(", ")}`);
  if (when.any) parts.push(`any of ${when.any.map((m) => `\`${m}\``).join(", ")}`);
  if (when.without) parts.push(`without ${when.without.map((m) => `\`${m}\``).join(", ")}`);
  if (when.private !== undefined) parts.push(when.private ? "private" : "public");
  return parts.join("; ");
}

export function filesTable(entries: FileEntry[]): string {
  const rows = entries.map(
    (entry) => `| \`${entry.path}\` | ${entry.class} | ${describeWhen(entry.when)} |`,
  );
  return ["| File | Class | When |", "| --- | --- | --- |", ...rows].join("\n");
}

/** The generated region's bounds in a document, or null without one. */
function generatedRegion(doc: string): { start: number; end: number } | null {
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;
  return { start: start + BEGIN.length, end };
}

function main(argv: string[]): number {
  const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
  const table = filesTable(config.files);
  if (argv.length === 0) {
    console.log(table);
    return 0;
  }
  const [mode, file] = argv;
  if (argv.length !== 2 || (mode !== "--check" && mode !== "--write")) {
    console.error("usage: bun scripts/files_table.ts [--check|--write <markdown file>]");
    return 2;
  }
  const path = resolve(file);
  const doc = readFileSync(path, "utf-8");
  const region = generatedRegion(doc);
  if (region === null) {
    console.error(`${file}: no files-table generated region`);
    return 1;
  }
  const current = doc.slice(region.start, region.end).trim();
  if (current === table) {
    if (mode === "--write") console.log(`${file}: the files table matches files.yml`);
    return 0;
  }
  if (mode === "--check") {
    console.error(`${file}: the files table is stale; run bun run regen`);
    return 1;
  }
  writeFileSync(path, `${doc.slice(0, region.start)}\n${table}\n${doc.slice(region.end)}`);
  console.log(`${file}: files table rewritten`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
