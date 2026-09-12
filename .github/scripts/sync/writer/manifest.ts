// The shape is actions/shared/manifest.ts's own, so its parser reads what this writer emits. The manifest's own entry carries the
// build sha in its `commit` slot and no hash (a self-hash would be circular).

import { createHash } from "node:crypto";
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
  type RecordedClass,
  strayFields,
} from "../../../../actions/shared/manifest.ts";
import {
  GENERATED_NOTICE,
  MANIFEST_NAME,
  REGISTRATION_PATH,
} from "../../../../actions/shared/platform.ts";
import { existingFile, writeFile } from "./target_files.ts";

export { MANIFEST_NAME };

/** A null hash is never written by this writer; it is carried from a
 *  record another tool left unstamped, so the file stays held rather than
 *  orphaned. */
export type ManifestRecord =
  | { class: "managed"; hash: string | null }
  | { class: "split"; grammar: "managed-region"; begin: string; end: string; hash: string | null }
  | { class: "starter" }
  | MirrorRecord
  | { class: "link"; hash: string | null };
/** Silent means copy, in the record as in the registration; a symlink's hash covers its link target, a copy's the bytes. */
export type MirrorRecord =
  | { class: "mirror"; hash: string | null }
  | { class: "mirror"; kind: "symlink"; hash: string | null };

export function mirrorRecord(kind: MirrorKind, hash: string | null): MirrorRecord {
  return kind === "symlink" ? { class: "mirror", kind, hash } : { class: "mirror", hash };
}

export function mirrorKind(record: MirrorRecord): MirrorKind {
  return "kind" in record ? "symlink" : "copy";
}

const HASH_RE = /^[0-9a-f]{64}$/;

/** A previous record as this writer would have written it, or null. retire.ts and mirrors.ts judge through this too, so no
 *  path is held or vouched for on a record the writer could not carry; the validator's parity check reads the same field table,
 *  so a shape refused here is a finding on the target side. */
export function readRecord(entry: ManifestEntryShape | undefined): ManifestRecord | null {
  if (entry === undefined || !isRecordedClass(entry.class)) return null;
  if (strayFields(entry.class, entry).length > 0) return null;
  if (entry.class === "starter") return { class: "starter" };
  const hash =
    entry.hash === null
      ? null
      : typeof entry.hash === "string" && HASH_RE.test(entry.hash)
        ? entry.hash
        : undefined;
  if (hash === undefined) return null;
  switch (entry.class) {
    case "managed":
      return { class: "managed", hash };
    case "link":
      return { class: "link", hash };
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

/** Records on a null prototype: a path named like an inherited property
 *  (`__proto__`, `constructor`) is then looked up, assigned, and listed
 *  like any other, where a plain object would answer with the prototype. */
function recordsOf(files: Record<string, ManifestEntryShape> = {}): Records {
  return Object.assign(Object.create(null) as Records, files);
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
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
  "relative symbolic link to it whose hash is sha256 of the link target, declared in " +
  `${REGISTRATION_PATH}), link (a relative symbolic link; hash is sha256 of its target). This ` +
  "file's own entry records the build commit that wrote the tree.";

export function renderManifest(records: Record<string, ManifestRecord>, build: string): string {
  const lines = Object.entries(records)
    .filter(([path]) => path !== MANIFEST_NAME)
    .map(([path, record]) => [path, entryBody(record as Record<string, JsonValue>)] as const);
  lines.push([MANIFEST_NAME, entryBody({ class: "managed", hash: null, commit: build })]);
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
  build: string,
): void {
  writeFile(target, MANIFEST_NAME, Buffer.from(renderManifest(records, build)));
}
