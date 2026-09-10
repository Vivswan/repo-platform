#!/usr/bin/env bun
// The copy writer's entry point: files.yml plus the files/ tree in, one
// target checkout rewritten, the Markdown report on stdout and a JSON
// summary beside it. No merge anywhere: managed content is copied whole,
// split regions are copied between the repository-owned halves, starters
// are copied once. Exit 0 whether or not the report holds the PR; a
// nonzero exit is a data or environment error the operator must fix.
//
// Usage:
//   bun sync.ts --files <files.yml> --tree <files dir> --target <checkout>
//     --build <sha> --repository <owner/name> --private <true|false>
//     [--previous-files <files.yml>] [--summary <path>]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "../../shared/flags.ts";
import { fail } from "../../shared/gha.ts";
import { blockSources, type FileEntry, type FilesConfig, loadFilesConfig } from "./files_config.ts";
import {
  MANIFEST_NAME,
  type ManifestRecord,
  type Records,
  readRecords,
  recordedHash,
  regionMarkers,
  sha256,
  writeManifest,
} from "./manifest.ts";
import { applyMirrors } from "./mirrors.ts";
import { type PlaceholderValues, substitute } from "./placeholders.ts";
import { parseRepositorySlug, placeholderValues, readRegistration } from "./registration.ts";
import {
  buildReport,
  renderReport,
  type SyncReport,
  unifiedDiff,
  type WrittenRow,
} from "./report.ts";
import { retire } from "./retire.ts";
import { resolveModules, selectEntries } from "./select.ts";
import { existingFile, type WriteOutcome, writeManaged } from "./write_managed.ts";
import { renderRegion, terminated, writeSplit } from "./write_split.ts";
import { writeStarter } from "./write_starter.ts";

export interface SyncOptions {
  files: string;
  tree: string;
  target: string;
  build: string;
  repository: string;
  private: boolean;
  previousFiles?: string;
}

/** A previous record carried into the new manifest when its file stays
 *  (a held retirement), or null when its shape is not one the writer emits. */
function carriedRecord(entry: Records[string]): ManifestRecord | null {
  const hash = typeof entry.hash === "string" ? entry.hash : null;
  if (entry.class === "managed" && hash !== null) return { class: "managed", hash };
  if (
    entry.class === "split" &&
    hash !== null &&
    typeof entry.begin === "string" &&
    typeof entry.end === "string"
  ) {
    return { class: "split", grammar: "managed-region", begin: entry.begin, end: entry.end, hash };
  }
  return null;
}

/** One entry written by its class: the outcome, the new record, and the
 *  bytes a mirror would copy plus the text a replaced edit is diffed against. */
function writeEntry(
  options: SyncOptions,
  config: FilesConfig,
  entry: FileEntry,
  modules: string[],
  values: PlaceholderValues,
  records: Records,
): { outcome: WriteOutcome; record: ManifestRecord; content: string } {
  const source = (rel: string) =>
    substitute(readFileSync(join(options.tree, rel), "utf-8"), values);
  const body = source(entry.source);
  const recorded = recordedHash(records, entry.path);
  if (entry.class === "starter") {
    return {
      outcome: writeStarter(options.target, entry.path, body),
      record: { class: "starter" },
      content: body,
    };
  }
  if (entry.class === "managed") {
    return {
      outcome: writeManaged(options.target, entry.path, body, recorded),
      record: { class: "managed", hash: sha256(body) },
      content: body,
    };
  }
  const markers = regionMarkers(entry.region ?? "hash");
  const blocks = blockSources(config, entry, modules).map(source);
  const region = renderRegion([body, ...blocks].map(terminated).join(""), markers);
  return {
    outcome: writeSplit(options.target, entry.path, region, markers, recorded),
    record: { class: "split", grammar: "managed-region", ...markers, hash: sha256(region) },
    content: region,
  };
}

export function runSync(options: SyncOptions): SyncReport {
  const config = loadFilesConfig(options.files, options.tree, options.previousFiles);
  const registration = readRegistration(options.target);
  const values = placeholderValues(registration, parseRepositorySlug(options.repository));
  const { selected, dropped } = resolveModules(config, registration.modules);
  const notes = dropped.map(
    (name) => `dropped unknown module \`${name}\` (files.yml does not know it)`,
  );
  const { records, problem } = readRecords(options.target);
  if (problem !== null) notes.push(`${problem}; every existing file is judged as unrecorded`);

  const entries = selectEntries(config, { modules: selected, private: options.private });
  const entryPaths = new Set(entries.map((entry) => entry.path));
  const retiredPaths = new Set(config.retired.map((entry) => entry.path));
  const stale = Object.entries(records)
    .filter(
      ([path, entry]) =>
        (entry.class === "managed" || entry.class === "split") &&
        path !== MANIFEST_NAME &&
        !entryPaths.has(path) &&
        !retiredPaths.has(path),
    )
    .map(([path]) => path);
  const retired = retire(options.target, config.retired, stale, records);

  const next: Record<string, ManifestRecord> = {};
  for (const row of retired) {
    const carried = row.outcome === "held" ? records[row.path] : undefined;
    const record = carried === undefined ? null : carriedRecord(carried);
    if (record !== null) next[row.path] = record;
  }
  const written = new Map<string, Buffer>();
  const rows: WrittenRow[] = [];
  const replaced: SyncReport["replaced"] = [];
  for (const entry of entries) {
    const { outcome, record, content } = writeEntry(
      options,
      config,
      entry,
      selected,
      values,
      records,
    );
    next[entry.path] = record;
    rows.push({ path: entry.path, class: entry.class, change: outcome.change });
    if (outcome.replaced !== undefined) {
      replaced.push({ path: entry.path, diff: unifiedDiff(entry.path, outcome.replaced, content) });
    }
    if (entry.class !== "starter") {
      const bytes = existingFile(options.target, entry.path);
      if (bytes !== null) written.set(entry.path, bytes);
    }
  }

  const mirrors =
    registration.mirrors === undefined
      ? []
      : applyMirrors(options.target, registration.mirrors, written, records);
  for (const row of mirrors) {
    const bytes = written.get(row.source);
    if (row.outcome !== "refused" && bytes !== undefined) {
      next[row.target] = { class: "mirror", hash: sha256(bytes) };
    }
  }
  writeManifest(options.target, next, options.build);
  return buildReport({
    build: options.build,
    modules: selected,
    private: options.private,
    written: rows,
    replaced,
    retired,
    notes,
    mirrors,
  });
}

function main(argv: string[]): number {
  const flags = parseFlags(
    argv,
    ["--files", "--tree", "--target", "--build", "--repository", "--private"] as const,
    ["--previous-files", "--summary"] as const,
  );
  if (flags["--private"] !== "true" && flags["--private"] !== "false") {
    fail("--private must be true or false");
  }
  let report: SyncReport;
  try {
    report = runSync({
      files: flags["--files"],
      tree: flags["--tree"],
      target: flags["--target"],
      build: flags["--build"],
      repository: flags["--repository"],
      private: flags["--private"] === "true",
      previousFiles: flags["--previous-files"],
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (flags["--summary"] !== undefined) {
    writeFileSync(flags["--summary"], `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(renderReport(report));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
