#!/usr/bin/env bun
// Exit 0 whether or not the report holds the PR; a nonzero exit is a data or environment error the operator must fix.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FileEntry,
  selectEntries,
  upstreamRefs,
} from "../../../../actions/plan/files_config.ts";
import { declaredMirrors, ownedPaths } from "../../../../actions/plan/mirrors.ts";
import type { Registration } from "../../../../actions/plan/registration.ts";
import { REGISTRATION_PATH } from "../../../../actions/shared/platform.ts";
import { pathProblem } from "../../../../actions/shared/repo_path.ts";
import type { Selection } from "../../../../actions/shared/selection.ts";
import { sha256 } from "../../../../actions/shared/values.ts";
import { lstatOrNull } from "../../shared/fs_probe.ts";
import { fail } from "../../shared/gha.ts";
import { loadFilesConfig, type WriterFilesConfig } from "./files_config.ts";
import { parseFlags } from "./flags.ts";
import {
  MANIFEST_NAME,
  type ManifestRecord,
  type Records,
  readRecord,
  readRecords,
  regionMarkers,
  writeManifest,
} from "./manifest.ts";
import { applyMirrors, blockedAncestor, MirrorFailure } from "./mirrors.ts";
import type { PlaceholderName, PlaceholderValues } from "./placeholders.ts";
import {
  PLACEHOLDER_SOURCE,
  parseRepositorySlug,
  placeholderValues,
  type RepositorySlug,
  readRegistration,
} from "./registration.ts";
import { renderSourced } from "./render_source.ts";
import {
  buildReport,
  renderReport,
  type SyncReport,
  unifiedDiff,
  type WrittenRow,
} from "./report.ts";
import { keepReason, type RetireRow, release, retire } from "./retire.ts";
import { selectModules } from "./select.ts";
import { renderSettings } from "./settings_entry.ts";
import { type Found, occupant, probe, removeFile, writeFile } from "./target_files.ts";
import { fetchUpstream, RAW_HOST, type UpstreamBodies } from "./upstream.ts";
import { type WriteOutcome, writeManaged } from "./write_managed.ts";
import { writeSplit } from "./write_split.ts";
import { writeStarter } from "./write_starter.ts";

export interface SyncOptions {
  files: string;
  tree: string;
  target: string;
  build: string;
  repository: string;
  private: boolean;
  /** The raw-content host every upstream ref is fetched from. */
  upstream: string;
}

interface Rendered {
  /** A starter's content is rendered inside its writer only on creation, so it is empty here; nothing reads it, since no mirror copies a starter and no diff is reported for one. */
  content: string;
  record: ManifestRecord;
  write: (recorded: string | null) => WriteOutcome | { missing: string[] };
}

interface Facts {
  registration: Registration;
  slug: RepositorySlug;
  values: PlaceholderValues;
  upstream: UpstreamBodies;
}

function render(
  options: SyncOptions,
  config: WriterFilesConfig,
  entry: FileEntry,
  modules: string[],
  facts: Facts,
): Rendered | { missing: string[] } | { held: string } {
  const { target } = options;
  const { values } = facts;
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
  const text = () => renderSourced(config, options.tree, entry, modules, values, facts.upstream);
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
    return {
      content: body,
      record: { class: "split", grammar: "managed-region", ...markers, hash: sha256(body) },
      write: (recorded) => writeSplit(target, entry.path, body, markers, recorded),
    };
  }
  return {
    content: body,
    record: { class: "managed", hash: sha256(body) },
    write: (recorded) => writeManaged(target, entry.path, body, recorded),
  };
}

function alreadyWritten(found: Found, content: string): boolean {
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

/** A record under another class than the entry declares is a class flip. A managed, split, or mirror record the file still matches marks it the platform's own previous write, replaced whole;
 *  otherwise (a stale record, or a starter record, which carries no hash and is repo-owned) the file is judged unrecorded. A flip to starter hands the file over and is never judged. */
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
  if (found !== null && found.kind !== "absent" && !alreadyWritten(found, rendered.content)) {
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
    // only a link becoming a file is removed first.
    if (found.kind === "file") {
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

export async function runSync(options: SyncOptions): Promise<SyncReport> {
  const config = loadFilesConfig(options.files, options.tree);
  const slug = parseRepositorySlug(options.repository);
  const notes: string[] = [];
  const registration = readRegistration(options.target);
  const selected = selectModules(config, registration.modules);
  const facts: Facts = {
    registration,
    slug,
    values: placeholderValues(registration, slug, options.private, config.defaults),
    upstream: await fetchUpstream(upstreamRefs(config.files), options.upstream),
  };
  const { records, problem } = readRecords(options.target);
  if (problem !== null) notes.push(`${problem}; every existing file is judged as unrecorded`);

  const selection: Selection = {
    modules: selected,
    private: options.private,
    except: registration.except,
  };
  const entries = selectEntries(config, selection);
  const entryPaths = new Set(entries.map((entry) => entry.path));
  const declared = new Set([
    ...config.files.map((entry) => entry.path),
    ...config.mirrors.flatMap((mirror) => mirror.targets),
  ]);
  notes.push(
    ...(registration.except ?? [])
      .filter((path) => !declared.has(path))
      .map((path) => `\`except\` names \`${path}\`, a path no files.yml entry writes`),
  );
  // A stale record at a path no files.yml entry declares (a hand edit, or an entry deleted from files.yml) is one the writer cannot account for, so its retirement is noted, which holds the PR.
  // Manifest keys are target-repo content: a stale record is retired only
  // when its path is one the writer could have written, and the refusal
  // below carries a count alone.
  const excepted = new Set(registration.except ?? []);
  const stale: string[] = [];
  const released: RetireRow[] = [];
  let unreadable = 0;
  for (const [path, entry] of Object.entries(records)) {
    if (path === MANIFEST_NAME) continue;
    const record = readRecord(entry);
    if (record === null) {
      unreadable++;
      continue;
    }
    // A mirror record is mirrors.ts's to carry or drop: `except` retires no record, it drops the target from the declarations.
    if (record.class === "mirror") continue;
    if (excepted.has(path)) {
      released.push(release(path, records));
      continue;
    }
    if (entryPaths.has(path) || record.class === "starter") continue;
    const problem = pathProblem(path);
    if (problem !== null) {
      notes.push(`manifest record for \`${path}\` ignored: the path ${problem}`);
      continue;
    }
    stale.push(path);
    if (!declared.has(path) && occupant(options.target, path) !== null) {
      notes.push(
        `manifest record for \`${path}\` had no writer: no files.yml entry declares the path now; ` +
          "it is retired as a stale record (the Retired row has the outcome)",
      );
    }
  }
  if (unreadable > 0) {
    throw new Error(
      `${unreadable} manifest ${unreadable === 1 ? "record is" : "records are"} not a shape the writer ` +
        "records (an unknown class, a field the class does not carry, a hash that is not a sha256 digest, a " +
        "mirror kind other than symlink, a split without its grammar or markers); the repository's " +
        "validate-managed-files check names each - fix the manifest (git history has the stamped original), " +
        "then dispatch the sync again",
    );
  }
  const owned = ownedPaths(config, selection, stale);
  const retired = [...retire(options.target, stale, records), ...released];

  // A Map, so a path named like an inherited property (constructor) is
  // looked up like any other.
  const next = new Map<string, ManifestRecord>();
  // A carried record never overwrites one this run wrote.
  const carry = (path: string) => {
    const record = readRecord(records[path]);
    if (record !== null && !next.has(path)) next.set(path, record);
  };
  for (const row of retired) {
    if (row.outcome === "held") carry(row.path);
  }
  const written = new Map<string, Buffer>();
  const rows: WrittenRow[] = [];
  const replaced: SyncReport["replaced"] = [];
  for (const entry of entries) {
    // The class writers hold a link in the way; anything else they refuse
    // loudly, and the sync must still end in a report.
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

  const mirrors = applyMirrors(
    options.target,
    declaredMirrors(config, registration),
    written,
    owned,
    records,
  );
  for (const [path, record] of mirrors.records) next.set(path, record);
  for (const { path, before, after } of mirrors.replaced) {
    replaced.push({ path, diff: unifiedDiff(path, before, after) });
  }
  // A mirror record no declaration reaches now (removed from the
  // registration, excepted, or its glob no longer matches) leaves the manifest
  // with a note; the copy stays as the repository's own. A path under a linked
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
      `manifest record for \`${path}\` dropped: no mirror in files.yml or ${REGISTRATION_PATH} reaches it now, so ` +
        "the file is the repository's own (a mirror declared again adopts it while it still holds " +
        "the source's content)",
    );
  }
  writeManifest(options.target, Object.fromEntries(next));
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

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(
    argv,
    ["--files", "--tree", "--target", "--build", "--repository", "--private"] as const,
    ["--summary", "--upstream"] as const,
  );
  if (flags["--private"] !== "true" && flags["--private"] !== "false") {
    fail("--private must be true or false");
  }
  // The build is recorded as given (in full in the PR body, its first 12 characters in the sync commit's subject), so
  // only the canonical full sha is accepted.
  if (!/^[0-9a-f]{40}$/.test(flags["--build"])) {
    fail(
      `--build must be the build commit's full sha (40 lowercase hex characters), got ${JSON.stringify(flags["--build"])}`,
    );
  }
  let report: SyncReport;
  try {
    report = await runSync({
      files: flags["--files"],
      tree: flags["--tree"],
      target: flags["--target"],
      build: flags["--build"],
      repository: flags["--repository"],
      private: flags["--private"] === "true",
      upstream: flags["--upstream"] ?? RAW_HOST,
    });
  } catch (error) {
    if (error instanceof MirrorFailure) fail(error.lines);
    fail(error instanceof Error ? error.message : String(error));
  }
  if (flags["--summary"] !== undefined) {
    writeFileSync(flags["--summary"], `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(renderReport(report));
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
