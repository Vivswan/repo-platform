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
import {
  blockSources,
  type FileEntry,
  type FilesConfig,
  loadFilesConfig,
  pathProblem,
} from "./files_config.ts";
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
import { type PlaceholderValues, spliceBlocks, substitute } from "./placeholders.ts";
import { parseRepositorySlug, placeholderValues, readRegistration } from "./registration.ts";
import {
  buildReport,
  renderReport,
  type SyncReport,
  unifiedDiff,
  type WrittenRow,
} from "./report.ts";
import { keepReason, retire } from "./retire.ts";
import { resolveModules, selectEntries } from "./select.ts";
import { type Found, probe, removeFile, writeFile } from "./target_files.ts";
import { writeLink } from "./write_link.ts";
import { type WriteOutcome, writeManaged } from "./write_managed.ts";
import { renderRegion, writeSplit } from "./write_split.ts";
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

/** A previous record carried into the new manifest when its file stays (a
 *  held or kept retirement, a refused mirror), so the next run can still
 *  tell the platform's last write from an edit; null when its shape is not
 *  one the writer emits. */
function carriedRecord(entry: Records[string]): ManifestRecord | null {
  const hash = typeof entry.hash === "string" ? entry.hash : null;
  if (entry.class === "starter") return { class: "starter" };
  if (entry.class === "managed" && hash !== null) return { class: "managed", hash };
  if (entry.class === "mirror" && hash !== null) return { class: "mirror", hash };
  if (entry.class === "link" && hash !== null) return { class: "link", hash };
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

interface Rendered {
  /** What the entry writes: the whole file, the region, or the link target. */
  content: string;
  record: ManifestRecord;
  write: (recorded: string | null) => WriteOutcome;
}

/** The entry's content and record, and its class writer bound to them. */
function render(
  options: SyncOptions,
  config: FilesConfig,
  entry: FileEntry,
  modules: string[],
  values: PlaceholderValues,
): Rendered {
  const { target } = options;
  if (entry.class === "link") {
    return {
      content: entry.target,
      record: { class: "link", hash: sha256(entry.target) },
      write: (recorded) => writeLink(target, entry.path, entry.target, recorded),
    };
  }
  const raw = (rel: string) => readFileSync(join(options.tree, rel), "utf-8");
  const blocks = blockSources(config, entry, modules, options.tree).map(raw);
  const body = substitute(spliceBlocks(raw(entry.source), blocks), values);
  if (entry.class === "split") {
    const markers = regionMarkers(entry.region);
    const region = renderRegion(body, markers);
    return {
      content: region,
      record: { class: "split", grammar: "managed-region", ...markers, hash: sha256(region) },
      write: (recorded) => writeSplit(target, entry.path, region, markers, recorded),
    };
  }
  if (entry.class === "starter") {
    return {
      content: body,
      record: { class: "starter" },
      write: () => writeStarter(target, entry.path, body),
    };
  }
  return {
    content: body,
    record: { class: "managed", hash: sha256(body) },
    write: (recorded) => writeManaged(target, entry.path, body, recorded),
  };
}

/** Whether what sits at the path is already exactly what the entry writes. */
function alreadyWritten(found: Found, entry: FileEntry, content: string): boolean {
  if (entry.class === "link") return found.kind === "link" && found.target === content;
  return found.kind === "file" && found.bytes.equals(Buffer.from(content, "utf-8"));
}

/** One entry written by its class: the outcome, the new record, and the
 *  content a mirror would copy or a replaced edit is diffed against. A path
 *  whose record the writer can carry names another class than the entry
 *  declares is a class flip: the recorded content is the platform's own
 *  previous write, so it is replaced whole when it still matches its record
 *  and held otherwise, its record carried (a flip to starter hands the file
 *  over and is never held). */
function writeEntry(
  options: SyncOptions,
  config: FilesConfig,
  entry: FileEntry,
  modules: string[],
  values: PlaceholderValues,
  records: Records,
): { outcome: WriteOutcome; record: ManifestRecord; content: string } {
  const rendered = render(options, config, entry, modules, values);
  const record = records[entry.path];
  const previous = record === undefined ? null : carriedRecord(record)?.class;
  const flipped = previous != null && previous !== entry.class && entry.class !== "starter";
  const found = flipped ? probe(options.target, entry.path) : null;
  if (
    found !== null &&
    found.kind !== "absent" &&
    !alreadyWritten(found, entry, rendered.content)
  ) {
    const reason = keepReason(options.target, entry.path, records);
    if (reason !== null) {
      const detail = `class changed from ${previous} to ${entry.class}, and ${reason}`;
      return {
        outcome: { change: "held", reason: detail },
        record: rendered.record,
        content: rendered.content,
      };
    }
    // A file staying a file is overwritten in place, which keeps its mode;
    // only a file becoming a link (or the reverse) is removed first.
    if (found.kind === "file" && entry.class !== "link") {
      writeFile(options.target, entry.path, Buffer.from(rendered.content, "utf-8"));
      return { outcome: { change: "updated" }, record: rendered.record, content: rendered.content };
    }
    removeFile(options.target, entry.path);
    const outcome = rendered.write(null);
    return {
      outcome: outcome.change === "created" ? { change: "updated" } : outcome,
      record: rendered.record,
      content: rendered.content,
    };
  }
  return {
    outcome: rendered.write(recordedHash(records, entry.path)),
    record: rendered.record,
    content: rendered.content,
  };
}

export function runSync(options: SyncOptions): SyncReport {
  const config = loadFilesConfig(options.files, options.tree, options.previousFiles);
  const registration = readRegistration(options.target);
  const values = placeholderValues(
    registration,
    parseRepositorySlug(options.repository),
    config.defaults,
  );
  const { selected, dropped } = resolveModules(config, registration.modules);
  const notes = dropped.map(
    (name) => `dropped unknown module \`${name}\` (files.yml does not know it)`,
  );
  const { records, problem } = readRecords(options.target);
  if (problem !== null) notes.push(`${problem}; every existing file is judged as unrecorded`);

  const entries = selectEntries(config, { modules: selected, private: options.private });
  const entryPaths = new Set(entries.map((entry) => entry.path));
  const retiredPaths = new Set(config.retired.map((entry) => entry.path));
  // Manifest keys are target-repo content: a stale record is retired only
  // when its path is one the writer could have written.
  const stale: string[] = [];
  for (const [path, entry] of Object.entries(records)) {
    if (entry.class !== "managed" && entry.class !== "split" && entry.class !== "link") continue;
    if (path === MANIFEST_NAME || entryPaths.has(path) || retiredPaths.has(path)) continue;
    const problem = pathProblem(path);
    if (problem === null) stale.push(path);
    else notes.push(`manifest record for \`${path}\` ignored: the path ${problem}`);
  }
  const retired = retire(options.target, config.retired, stale, entryPaths, records);

  // A Map, so a path named like an inherited property (constructor) is
  // looked up like any other.
  const next = new Map<string, ManifestRecord>();
  // A carried record never displaces one this run wrote.
  const carry = (path: string) => {
    const previous = records[path];
    const record = previous === undefined ? null : carriedRecord(previous);
    if (record !== null && !next.has(path)) next.set(path, record);
  };
  for (const row of retired) {
    if (row.outcome === "held" || row.outcome === "kept") carry(row.path);
  }
  // A starter whose module was deselected stays the repository's own; its
  // record stays too, so a later retirement still reads it as kept.
  for (const [path, entry] of Object.entries(records)) {
    if (entry.class !== "starter" || entryPaths.has(path) || pathProblem(path) !== null) continue;
    if (probe(options.target, path).kind !== "absent") carry(path);
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
    // A held path keeps its previous record: the file is still that write.
    if (outcome.change === "held") carry(entry.path);
    else next.set(entry.path, record);
    rows.push({
      path: entry.path,
      class: entry.class,
      change: outcome.change,
      detail: outcome.change === "held" ? outcome.reason : "",
    });
    if (outcome.change === "replaced local edits") {
      replaced.push({ path: entry.path, diff: unifiedDiff(entry.path, outcome.replaced, content) });
    }
    // A held file is not one this sync wrote, so no mirror copies it.
    if ((entry.class === "managed" || entry.class === "split") && outcome.change !== "held") {
      const found = probe(options.target, entry.path);
      if (found.kind === "file") written.set(entry.path, found.bytes);
    }
  }

  const mirrors =
    registration.mirrors === undefined
      ? []
      : applyMirrors(
          options.target,
          registration.mirrors,
          written,
          new Set([...entryPaths, MANIFEST_NAME]),
          records,
        );
  for (const row of mirrors) {
    const bytes = written.get(row.source);
    if (row.outcome === "refused") carry(row.target);
    else if (bytes !== undefined) next.set(row.target, { class: "mirror", hash: sha256(bytes) });
  }
  writeManifest(options.target, Object.fromEntries(next), options.build);
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
