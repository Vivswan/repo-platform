#!/usr/bin/env bun
// The copy writer's entry point: files.yml plus the files/ tree in, one
// target checkout rewritten, the Markdown report on stdout and a JSON
// summary beside it. Managed content is copied whole, split regions are
// copied between the repository-owned halves, starters are copied once;
// the one rendered entry, the settings document, folds the settings layers
// with the repository's overlay (settings_entry.ts). Exit 0 whether or not
// the report holds the PR; a nonzero exit is a data or environment error
// the operator must fix.
//
// Usage:
//   bun sync.ts --files <files.yml> --tree <files dir> --target <checkout>
//     --build <sha> --repository <owner/name> --private <true|false>
//     [--previous-files <files.yml>] [--summary <path>] [--cutover true]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FileEntry, pathProblem } from "../../../../actions/plan/files_config.ts";
import { REGISTRATION_PATH, type Registration } from "../../../../actions/plan/registration.ts";
import { parseFlags } from "../../shared/flags.ts";
import { lstatOrNull } from "../../shared/fs_probe.ts";
import { fail } from "../../shared/gha.ts";
import { cutover } from "./cutover.ts";
import { type Displacement, displace } from "./displace.ts";
import { blockSources, loadFilesConfig, type WriterFilesConfig } from "./files_config.ts";
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
import { applyMirrors, linkedAncestor } from "./mirrors.ts";
import {
  missingPlaceholders,
  type PlaceholderName,
  type PlaceholderValues,
  spliceBlocks,
  substitute,
} from "./placeholders.ts";
import {
  PLACEHOLDER_SOURCE,
  parseRepositorySlug,
  placeholderValues,
  type RepositorySlug,
  readRegistration,
} from "./registration.ts";
import {
  buildReport,
  renderReport,
  type SyncReport,
  unifiedDiff,
  type WrittenRow,
} from "./report.ts";
import { keepReason, retire } from "./retire.ts";
import { resolveModules, selectEntries } from "./select.ts";
import { renderSettings } from "./settings_entry.ts";
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
  /** Derive a v2 registration first when the target still carries a v1
   *  one beside its answers file (cutover.ts). */
  cutover?: boolean;
}

/** A previous record carried into the new manifest when its file stays (a
 *  held or kept retirement, a held entry, a refused mirror), so the next
 *  run still holds the file instead of judging it unrecorded; a missing
 *  hash rides along as null. Null when the class is not one the writer
 *  records or a split names no markers. */
function carriedRecord(entry: Records[string]): ManifestRecord | null {
  const hash = typeof entry.hash === "string" ? entry.hash : null;
  if (entry.class === "starter") return { class: "starter" };
  if (entry.class === "managed") return { class: "managed", hash };
  if (entry.class === "mirror") return { class: "mirror", hash };
  if (entry.class === "link") return { class: "link", hash };
  if (entry.class === "split" && typeof entry.begin === "string" && typeof entry.end === "string") {
    return { class: "split", grammar: "managed-region", begin: entry.begin, end: entry.end, hash };
  }
  return null;
}

interface Rendered {
  /** What the entry writes: the whole file, the region, or the link
   *  target. A starter's is rendered inside its writer, only when it
   *  creates the file, so it is empty here (nothing reads it: no mirror
   *  copies a starter and no diff is reported for one). */
  content: string;
  record: ManifestRecord;
  write: (recorded: string | null) => WriteOutcome | { missing: string[] };
}

/** What one run renders every entry against: the registration and the
 *  slug the operator passed, beside the placeholder values. */
interface Facts {
  registration: Registration;
  slug: RepositorySlug;
  values: PlaceholderValues;
}

/** The entry's content and record, and its class writer bound to them; or
 *  the placeholders its text needs that have no value, in which case
 *  nothing is rendered (an empty value is never written); or the reason a
 *  rendered entry holds. */
function render(
  options: SyncOptions,
  config: WriterFilesConfig,
  entry: FileEntry,
  modules: string[],
  facts: Facts,
): Rendered | { missing: string[] } | { held: string } {
  const { target } = options;
  const { values } = facts;
  if (entry.class === "link") {
    return {
      content: entry.target,
      record: { class: "link", hash: sha256(entry.target) },
      write: (recorded) => writeLink(target, entry.path, entry.target, recorded),
    };
  }
  if ("render" in entry) {
    // The overlay is the starter this entry displaces, written earlier in
    // the same loop when absent; a link there is never read through.
    const overlayPath = entry.displaces;
    const overlay = probe(target, overlayPath);
    if (overlay.kind === "link") {
      return { held: `${overlayPath} is a symbolic link, which the render does not read through` };
    }
    const rendered = renderSettings({
      config,
      tree: options.tree,
      modules,
      private: options.private,
      registration: facts.registration,
      overlay: overlay.kind === "file" ? overlay.bytes.toString("utf-8") : null,
      overlayPath,
      owner: facts.slug.owner,
    });
    if ("held" in rendered) return rendered;
    return {
      content: rendered.content,
      record: { class: "managed", hash: sha256(rendered.content) },
      write: (recorded) => writeManaged(target, entry.path, rendered.content, recorded),
    };
  }
  const raw = (rel: string) => readFileSync(join(options.tree, rel), "utf-8");
  const text = (): string | { missing: string[] } => {
    const blocks = blockSources(config, entry, modules, options.tree).map(raw);
    const spliced = spliceBlocks(raw(entry.source), blocks);
    const missing = missingPlaceholders(spliced, values);
    return missing.length > 0 ? { missing } : substitute(spliced, values);
  };
  if (entry.class === "starter") {
    return {
      content: "",
      record: { class: "starter" },
      write: () => writeStarter(target, entry.path, text),
    };
  }
  const body = text();
  if (typeof body !== "string") return body;
  if (entry.class === "split") {
    const markers = regionMarkers(entry.region);
    const region = renderRegion(body, markers);
    return {
      content: region,
      record: { class: "split", grammar: "managed-region", ...markers, hash: sha256(region) },
      write: (recorded) => writeSplit(target, entry.path, region, markers, recorded),
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

interface Written {
  outcome: WriteOutcome;
  record: ManifestRecord;
  /** What a mirror would copy, or a replaced edit is diffed against. */
  content: string;
}

/** One entry written by its class, or the placeholders it lacks a value
 *  for (nothing is written then). A path
 *  whose record the writer can carry names another class than the entry
 *  declares is a class flip: the recorded content is the platform's own
 *  previous write, so it is replaced whole when it still matches its record
 *  and held otherwise, its record carried (a flip to starter hands the file
 *  over and is never held). */
function writeEntry(
  options: SyncOptions,
  config: WriterFilesConfig,
  entry: FileEntry,
  modules: string[],
  facts: Facts,
  records: Records,
): Written | { missing: string[] } | { held: string } {
  const rendered = render(options, config, entry, modules, facts);
  if ("missing" in rendered || "held" in rendered) return rendered;
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
    if ("missing" in outcome) return outcome;
    return {
      outcome: outcome.change === "created" ? { change: "updated" } : outcome,
      record: rendered.record,
      content: rendered.content,
    };
  }
  const outcome = rendered.write(recordedHash(records, entry.path));
  if ("missing" in outcome) return outcome;
  return { outcome, record: rendered.record, content: rendered.content };
}

export function runSync(options: SyncOptions): SyncReport {
  const config = loadFilesConfig(options.files, options.tree, options.previousFiles);
  const slug = parseRepositorySlug(options.repository);
  const notes = options.cutover === true ? cutover(options.target, config, slug) : [];
  const registration = readRegistration(options.target);
  const facts: Facts = {
    registration,
    slug,
    values: placeholderValues(registration, slug, config.defaults),
  };
  const { selected, dropped } = resolveModules(config, registration.modules);
  notes.push(
    ...dropped.map((name) => `dropped unknown module \`${name}\` (files.yml does not know it)`),
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
    if (path === MANIFEST_NAME || entryPaths.has(path) || retiredPaths.has(path)) continue;
    if (carriedRecord(entry) === null) {
      notes.push(
        `manifest record for \`${path}\` dropped: its class or shape is not one the writer records`,
      );
      continue;
    }
    if (entry.class !== "managed" && entry.class !== "split" && entry.class !== "link") continue;
    const problem = pathProblem(path);
    if (problem === null) stale.push(path);
    else notes.push(`manifest record for \`${path}\` ignored: the path ${problem}`);
  }
  const retired = retire(options.target, config.retired, stale, entryPaths, records);
  const displaced = new Map<string, Displacement>(
    displace(options.target, entries, records).map((row) => [row.path, row]),
  );

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
    const displacement = displaced.get(entry.path);
    if (displacement?.outcome === "held") {
      carry(entry.path);
      rows.push({
        path: entry.path,
        class: entry.class,
        change: "held",
        detail: displacement.detail,
      });
      continue;
    }
    const result = writeEntry(options, config, entry, selected, facts, records);
    if ("held" in result) {
      carry(entry.path);
      rows.push({ path: entry.path, class: entry.class, change: "held", detail: result.held });
      continue;
    }
    if ("missing" in result) {
      for (const name of result.missing) {
        const note = `placeholder \`{{${name}}}\` has no value: set ${PLACEHOLDER_SOURCE[name as PlaceholderName]} in ${REGISTRATION_PATH}`;
        if (!notes.includes(note)) notes.push(note);
      }
      carry(entry.path);
      const tokens = result.missing.map((name) => `{{${name}}}`).join(", ");
      rows.push({
        path: entry.path,
        class: entry.class,
        change: "held",
        detail: `no value for ${tokens}`,
      });
      continue;
    }
    const { record, content } = result;
    // A displaced file's path was free, so the write created the content;
    // the row says where the repository's file went instead.
    const outcome: WriteOutcome =
      displacement?.outcome === "moved" && result.outcome.change === "created"
        ? { change: "moved", to: displacement.to }
        : result.outcome;
    // A held path keeps its previous record: the file is still that write.
    if (outcome.change === "held") carry(entry.path);
    else next.set(entry.path, record);
    rows.push({
      path: entry.path,
      class: entry.class,
      change: outcome.change,
      detail:
        outcome.change === "held"
          ? outcome.reason
          : outcome.change === "moved"
            ? `to ${outcome.to}`
            : "",
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
          new Set([...retiredPaths, ...stale]),
        );
  for (const row of mirrors) {
    const bytes = written.get(row.source);
    if (row.outcome === "refused") carry(row.target);
    else if (bytes !== undefined) next.set(row.target, { class: "mirror", hash: sha256(bytes) });
  }
  // A mirror record no declaration reaches now (removed from the
  // registration, or its glob no longer matches) leaves the manifest with a
  // note; the copy stays as the repository's own. A path under a linked
  // directory is never looked up (the link may loop); its record is noted too.
  for (const [path, entry] of Object.entries(records)) {
    if (entry.class !== "mirror" || next.has(path) || pathProblem(path) !== null) continue;
    if (
      linkedAncestor(options.target, path) === null &&
      lstatOrNull(join(options.target, path)) === null
    ) {
      continue;
    }
    notes.push(
      `manifest record for \`${path}\` dropped: no mirror in ${REGISTRATION_PATH} reaches it now, so ` +
        "the file is the repository's own (a mirror declared again adopts it while it still holds " +
        "the source's content)",
    );
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
    ["--previous-files", "--summary", "--cutover"] as const,
  );
  if (flags["--private"] !== "true" && flags["--private"] !== "false") {
    fail("--private must be true or false");
  }
  if (flags["--cutover"] !== undefined && flags["--cutover"] !== "true") {
    fail("--cutover takes only the value true");
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
      cutover: flags["--cutover"] === "true",
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
