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
//     --build <full sha> --repository <owner/name> --private <true|false>
//     [--previous-files <files.yml>] [--summary <path>]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FileEntry, selectEntries } from "../../../../actions/plan/files_config.ts";
import { describeMirrorProblem, ownedPaths } from "../../../../actions/plan/mirrors.ts";
import type { Registration } from "../../../../actions/plan/registration.ts";
import { REGISTRATION_PATH } from "../../../../actions/shared/platform.ts";
import { pathProblem } from "../../../../actions/shared/repo_path.ts";
import { parseFlags } from "../../shared/flags.ts";
import { lstatOrNull } from "../../shared/fs_probe.ts";
import { fail } from "../../shared/gha.ts";
import { blockSources, loadFilesConfig, type WriterFilesConfig } from "./files_config.ts";
import {
  MANIFEST_NAME,
  type ManifestRecord,
  type MirrorRecord,
  type Records,
  readRecord,
  readRecords,
  regionMarkers,
  sha256,
  writeManifest,
} from "./manifest.ts";
import { applyMirrors, blockedAncestor, MirrorFailure } from "./mirrors.ts";
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
import { resolveModules } from "./select.ts";
import { renderSettings } from "./settings_entry.ts";
import { type Found, occupant, probe, removeFile, writeFile } from "./target_files.ts";
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
    // The overlay starter is written earlier in the same loop when absent;
    // only a regular file there is read.
    const overlayPath = entry.overlay;
    const what = occupant(target, overlayPath);
    if (what !== null && what !== "a regular file") {
      return { held: `${overlayPath} is ${what}, which the render does not read through` };
    }
    const overlay = probe(target, overlayPath);
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
  if (entry.class === "link") {
    return found.kind === "link" && found.target.equals(Buffer.from(content, "utf-8"));
  }
  return found.kind === "file" && found.bytes.equals(Buffer.from(content, "utf-8"));
}

interface Written {
  outcome: WriteOutcome;
  record: ManifestRecord;
  /** What a mirror would copy, or a replaced edit is diffed against. */
  content: string;
  /** The stale record a write set aside, for the row's detail. */
  detail?: string;
}

/** One entry written by its class, or the placeholders it lacks a value
 *  for (nothing is written then). A path whose record the writer reads
 *  under another class than the entry declares is a class flip: the
 *  recorded content is the platform's own previous write, so it is
 *  replaced whole when it still matches its record; otherwise the record
 *  is stale and the file is written as an unrecorded one (a flip to
 *  starter hands the file over and is never judged). */
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
  const previous = readRecord(records[entry.path]);
  const recorded = previous === null || previous.class === "starter" ? null : previous.hash;
  const flipped =
    previous !== null && previous.class !== entry.class && entry.class !== "starter"
      ? previous.class
      : null;
  const found = flipped === null ? null : probe(options.target, entry.path);
  if (
    found !== null &&
    found.kind !== "absent" &&
    !alreadyWritten(found, entry, rendered.content)
  ) {
    if (keepReason(options.target, entry.path, records) !== null) {
      const outcome = rendered.write(null);
      if ("missing" in outcome) return outcome;
      return {
        outcome,
        record: rendered.record,
        content: rendered.content,
        detail: `class changed from ${flipped} to ${entry.class}; the record was stale, so the file was judged unrecorded`,
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
  const outcome = rendered.write(recorded);
  if ("missing" in outcome) return outcome;
  return { outcome, record: rendered.record, content: rendered.content };
}

export function runSync(options: SyncOptions): SyncReport {
  const config = loadFilesConfig(options.files, options.tree, options.previousFiles);
  const slug = parseRepositorySlug(options.repository);
  const notes: string[] = [];
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
  const owned = ownedPaths(config, { modules: selected, private: options.private });
  // Manifest keys are target-repo content: a stale record is retired only
  // when its path is one the writer could have written.
  const stale: string[] = [];
  for (const [path, entry] of Object.entries(records)) {
    if (path === MANIFEST_NAME) continue;
    const record = readRecord(entry);
    if (record === null) {
      notes.push(
        `manifest record for \`${path}\` dropped: its class or shape is not one the writer records`,
      );
      continue;
    }
    if (entryPaths.has(path) || owned.retires.has(path)) continue;
    if (record.class !== "managed" && record.class !== "split" && record.class !== "link") continue;
    const problem = pathProblem(path);
    if (problem === null) stale.push(path);
    else notes.push(`manifest record for \`${path}\` ignored: the path ${problem}`);
  }
  const retired = retire(options.target, config.retired, stale, entryPaths, records);

  // A Map, so a path named like an inherited property (constructor) is
  // looked up like any other.
  const next = new Map<string, ManifestRecord>();
  // A carried record never overwrites one this run wrote.
  const carry = (path: string) => {
    const record = readRecord(records[path]);
    if (record !== null && !next.has(path)) next.set(path, record);
  };
  for (const row of retired) {
    if (row.outcome === "held" || row.outcome === "kept") carry(row.path);
  }
  // A starter whose module was deselected stays the repository's own; its
  // record stays too, so a later retirement still reads it as kept.
  for (const [path, entry] of Object.entries(records)) {
    if (
      readRecord(entry)?.class !== "starter" ||
      entryPaths.has(path) ||
      pathProblem(path) !== null
    ) {
      continue;
    }
    if (occupant(options.target, path) !== null) carry(path);
  }
  const written = new Map<string, Buffer>();
  const rows: WrittenRow[] = [];
  const replaced: SyncReport["replaced"] = [];
  for (const entry of entries) {
    // The class writers hold a file or a link in the way; anything else
    // they refuse loudly, and the sync must still end in a report.
    const taken = occupant(options.target, entry.path);
    if (taken === "a directory" || taken === "something that is not a regular file") {
      carry(entry.path);
      rows.push({
        path: entry.path,
        class: entry.class,
        change: "held",
        detail: `${taken} sits at the path, and the writer will not replace it`,
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
    const { outcome, record, content } = result;
    // A held path keeps its previous record: the file is still that write.
    if (outcome.change === "held") carry(entry.path);
    else next.set(entry.path, record);
    rows.push({
      path: entry.path,
      class: entry.class,
      change: outcome.change,
      detail: outcome.change === "held" ? outcome.reason : (result.detail ?? ""),
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
      ? { rows: [], replaced: [], records: new Map<string, MirrorRecord>() }
      : applyMirrors(
          options.target,
          registration.mirrors,
          written,
          { ...owned, stale: new Set(stale) },
          records,
        );
  for (const [path, record] of mirrors.records) next.set(path, record);
  for (const { path, before, after } of mirrors.replaced) {
    replaced.push({ path, diff: unifiedDiff(path, before, after) });
  }
  // A mirror record no declaration reaches now (removed from the
  // registration, or its glob no longer matches) leaves the manifest with a
  // note; the copy stays as the repository's own. A path under a linked
  // directory is never looked up (the link may loop); its record is noted too.
  for (const [path, entry] of Object.entries(records)) {
    if (readRecord(entry)?.class !== "mirror" || next.has(path) || pathProblem(path) !== null) {
      continue;
    }
    if (
      blockedAncestor(options.target, path)?.is !== "a symbolic link" &&
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
    mirrors: mirrors.rows,
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
  // The manifest's commit field is read as a full sha by the fleet's
  // validator (manifest_shape.ts), so a short one would fail every
  // all-green in the target after the sync merges.
  if (!/^[0-9a-f]{40}$/.test(flags["--build"])) {
    fail(
      `--build must be the build commit's full sha (40 lowercase hex characters), got ${JSON.stringify(flags["--build"])}`,
    );
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
    if (error instanceof MirrorFailure) fail(error.failures.map(describeMirrorProblem));
    fail(error instanceof Error ? error.message : String(error));
  }
  if (flags["--summary"] !== undefined) {
    writeFileSync(flags["--summary"], `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(renderReport(report));
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
