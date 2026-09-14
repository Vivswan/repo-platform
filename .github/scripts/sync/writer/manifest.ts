import type { RegionKind } from "../../../../actions/plan/files_config.ts";
import type { MirrorKind } from "../../../../actions/plan/mirrors.ts";
import {
  type AssertNever,
  HASH_REGION_MARKERS,
  HTML_REGION_MARKERS,
  knownGrammar,
  type RegionMarkers,
} from "../../../../actions/shared/grammar.ts";
import {
  entryBody,
  isRecordedClass,
  type JsonValue,
  type ManifestEntryShape,
  parseManifestFiles,
  RECORD_FIELDS,
  type RecordedClass,
  strayFields,
} from "../../../../actions/shared/manifest.ts";
import {
  GENERATED_NOTICE,
  MANIFEST_NAME,
  PLATFORM_NAME,
  REGISTRATION_PATH,
} from "../../../../actions/shared/platform.ts";
import { existingFile, writeFile } from "./target_files.ts";

export { MANIFEST_NAME };

/** A record vouches for a write by its hash, so the manifest's own hash-null entry (manifest.ts renderManifest) and a record another tool left unstamped read as no record. */
export type ManifestRecord =
  | { class: "managed"; hash: string }
  | { class: "split"; grammar: "managed-region"; begin: string; end: string; hash: string }
  | { class: "starter" }
  | MirrorRecord;
/** Silent means copy, in the record as in the registration; a symlink's hash covers its link target, a copy's the bytes. */
export type MirrorRecord =
  | { class: "mirror"; hash: string }
  | { class: "mirror"; kind: "symlink"; hash: string };

export function mirrorRecord(kind: MirrorKind, hash: string): MirrorRecord {
  return kind === "symlink" ? { class: "mirror", kind, hash } : { class: "mirror", hash };
}

export function mirrorKind(record: MirrorRecord): MirrorKind {
  return "kind" in record ? "symlink" : "copy";
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** retire.ts and mirrors.ts judge through this too, so no path is held or vouched for on a record the writer could not carry; the validator's
 *  parity check reads the same field table, so a shape refused here is a finding on the target side. */
export function readRecord(entry: ManifestEntryShape | undefined): ManifestRecord | null {
  if (entry === undefined || !isRecordedClass(entry.class)) return null;
  if (strayFields(RECORD_FIELDS[entry.class], entry).length > 0) return null;
  if (entry.class === "starter") return { class: "starter" };
  const hash = entry.hash;
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return null;
  switch (entry.class) {
    case "managed":
      return { class: "managed", hash };
    case "mirror":
      if (!("kind" in entry)) return { class: "mirror", hash };
      return entry.kind === "symlink" ? { class: "mirror", kind: "symlink", hash } : null;
    case "split": {
      const grammar = knownGrammar(entry.grammar);
      return grammar !== null && typeof entry.begin === "string" && typeof entry.end === "string"
        ? { class: "split", grammar, begin: entry.begin, end: entry.end, hash }
        : null;
    }
  }
}
/** The union and the shared RECORDED_CLASSES table name the same classes, both ways. Compile-time only. @public */
export type RecordedClassesWritten = AssertNever<Exclude<RecordedClass, ManifestRecord["class"]>>;
/** Compile-time only. @public */
export type WrittenClassesRecorded = AssertNever<Exclude<ManifestRecord["class"], RecordedClass>>;

export type Records = Record<string, ManifestEntryShape>;

/** A null prototype, so a path named `__proto__` or `constructor` is looked up, assigned, and listed like any other. */
function recordsOf(files: Record<string, ManifestEntryShape> = {}): Records {
  return Object.assign(Object.create(null) as Records, files);
}

export function regionMarkers(kind: RegionKind): RegionMarkers {
  return kind === "hash" ? HASH_REGION_MARKERS : HTML_REGION_MARKERS;
}

export function readRecords(target: string): { records: Records; problem: string | null } {
  const bytes = existingFile(target, MANIFEST_NAME);
  if (bytes === null) return { records: recordsOf(), problem: null };
  const parsed = parseManifestFiles(bytes.toString("utf-8"));
  if (parsed.problem !== null)
    return { records: recordsOf(), problem: `${MANIFEST_NAME} ${parsed.problem}` };
  return { records: recordsOf(parsed.files), problem: null };
}

const COMMENT =
  `${GENERATED_NOTICE} Every platform-written path with its ownership ` +
  "class: managed (rewritten whole; hash is sha256 of the last written content), split (the " +
  "BEGIN/END-bounded region is rewritten and the repository owns everything outside it; the " +
  "hash covers the region from the BEGIN line through the END line), starter (written once, " +
  "repo-owned from then on), mirror (a byte copy of a written file, or with kind symlink a " +
  "relative symbolic link to it whose hash is sha256 of the link target, declared in files.yml or " +
  `${REGISTRATION_PATH}). This file's own entry names the ${PLATFORM_NAME} commit the repository is judged against ` +
  "until a sync moves it.";

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** The commit the manifest's own entry names, null when it names none the writer can read (a manifest from before
 *  the field, or a hand edit): the stamp rule in sync.ts then takes the build. */
export function recordedCommit(records: Records): string | null {
  const commit = records[MANIFEST_NAME]?.commit;
  return typeof commit === "string" && COMMIT_RE.test(commit) ? commit : null;
}

/** The manifest's own entry carries the commit and no hash: a self-hash would be circular. */
export function renderManifest(records: Record<string, ManifestRecord>, commit: string): string {
  const lines = Object.entries(records)
    .filter(([path]) => path !== MANIFEST_NAME)
    .map(([path, record]) => [path, entryBody(record as Record<string, JsonValue>)] as const);
  lines.push([MANIFEST_NAME, entryBody({ class: "managed", hash: null, commit })]);
  lines.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    "{",
    `  "$comment": ${JSON.stringify(COMMENT)},`,
    '  "files": {',
    lines.map(([path, body]) => `    ${JSON.stringify(path)}: ${body}`).join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

export function writeManifest(
  target: string,
  records: Record<string, ManifestRecord>,
  commit: string,
): void {
  writeFile(target, MANIFEST_NAME, Buffer.from(renderManifest(records, commit)));
}
