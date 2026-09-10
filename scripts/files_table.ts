#!/usr/bin/env bun
// The file table of files.yml as Markdown (path, class, when), for
// docs/new-repo.md and PR bodies. --check compares the table against the
// generated region of a Markdown file instead of printing; `bun run
// files:check` runs it over docs/new-repo.md in the check chain and CI.
//
// Usage: bun scripts/files_table.ts [--check docs/new-repo.md]

import { readFileSync } from "node:fs";
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

function main(argv: string[]): number {
  const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
  const table = filesTable(config.files);
  if (argv.length === 0) {
    console.log(table);
    return 0;
  }
  if (argv.length !== 2 || argv[0] !== "--check") {
    console.error("usage: bun scripts/files_table.ts [--check <markdown file>]");
    return 2;
  }
  const doc = readFileSync(resolve(argv[1]), "utf-8");
  const start = doc.indexOf(BEGIN);
  const end = doc.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    console.error(`${argv[1]}: no files-table generated region`);
    return 1;
  }
  const current = doc.slice(start + BEGIN.length, end).trim();
  if (current !== table) {
    console.error(
      `${argv[1]}: the files table is stale; paste the output of scripts/files_table.ts`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
