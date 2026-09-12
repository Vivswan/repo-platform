// One entry per line, 4-space indent, the JSON-quoted path, one inline JSON object, so two syncs' manifests differ in
// hash values alone and a review diff reads line by line.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import {
  type AssertNever,
  type GrammarId,
  MANAGED_REGION_WIRE_FIELDS,
  type SplitShapes,
} from "./grammar.ts";

/** Every class a recorded entry can carry. The sync writer's record union
 *  and the validator's class dispatch are both pinned to this table, so a
 *  class one side learns reaches the other or the build fails. */
export const RECORDED_CLASSES = ["managed", "split", "starter", "mirror", "link"] as const;
export type RecordedClass = (typeof RECORDED_CLASSES)[number];
const RECORDED_CLASS_SET: ReadonlySet<string> = new Set(RECORDED_CLASSES);

export function isRecordedClass(value: string): value is RecordedClass {
  return RECORDED_CLASS_SET.has(value);
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The writer prints every entry through this, so two syncs' manifests share one byte layout. */
export function entryBody(fields: Record<string, JsonValue>): string {
  return `{${Object.entries(fields)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(", ")}}`;
}

/** Every marker-string field any grammar's declaration owns, derived from
 *  the table's SplitShapes: a new grammar's fields join the wire
 *  vocabulary below without a hand edit here. */
type SplitDeclarationField = {
  [K in GrammarId]: Exclude<keyof SplitShapes[K], "grammar">;
}[GrammarId];

/** Every value stays unknown because manifest text is target-repo content on updates: consumers validate what they use. */
export type ManifestEntryShape = {
  class: string;
  hash?: unknown;
  grammar?: unknown;
  commit?: unknown;
  /** A mirror's materialization: "symlink" when the path is a link to the source; absent for a copy. */
  kind?: unknown;
} & { [F in SplitDeclarationField]?: unknown };

/** The closed entry-field vocabulary, the runtime twin of ManifestEntryShape: `satisfies` refuses
 *  a stranger and the AssertNever pin refuses an omission (a new grammar's tuple joins here or the
 *  build fails). The validator reports any other key. */
export const ENTRY_FIELDS = [
  "class",
  "hash",
  "grammar",
  "commit",
  "kind",
  ...MANAGED_REGION_WIRE_FIELDS,
] as const satisfies readonly (keyof ManifestEntryShape)[];
/** Compile-time only. @public */
export type EntryFieldsExhaustive = AssertNever<
  Exclude<keyof ManifestEntryShape, (typeof ENTRY_FIELDS)[number]>
>;
const ENTRY_FIELD_SET: ReadonlySet<string> = new Set(ENTRY_FIELDS);

/** The fields a record of each class carries; `commit` rides on the manifest's own managed entry. The sync writer reads a
 *  previous record and the validator's parity check judges a target's manifest through this one table, so a field on the wrong
 *  class is a hand edit to both. */
export const RECORD_FIELDS = {
  managed: ["class", "hash", "commit"],
  split: ["class", "hash", "grammar", ...MANAGED_REGION_WIRE_FIELDS],
  starter: ["class"],
  mirror: ["class", "hash", "kind"],
  link: ["class", "hash"],
} as const satisfies Record<RecordedClass, readonly (typeof ENTRY_FIELDS)[number][]>;

export function strayFields(recorded: RecordedClass, entry: ManifestEntryShape): string[] {
  const fields: readonly string[] = RECORD_FIELDS[recorded];
  return Object.keys(entry).filter((key) => !fields.includes(key));
}

export function isEntryField(key: string): boolean {
  return ENTRY_FIELD_SET.has(key);
}

export function unknownEntryFields(
  files: Record<string, ManifestEntryShape>,
): { path: string; fields: string[] }[] {
  return Object.entries(files).flatMap(([path, entry]) => {
    const fields = Object.keys(entry).filter((key) => !isEntryField(key));
    return fields.length === 0 ? [] : [{ path, fields }];
  });
}

/** Every consumer reads through here, so no station can act on a manifest another one refused. Every problem string
 *  is VALUE-FREE: the text is target-repo content on updates and the strings reach public logs. */
export function parseManifestFiles(
  text: string,
): { files: Record<string, ManifestEntryShape>; problem: null } | { files: null; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Value-free on purpose: a SyntaxError's message quotes manifest text
    // (target-repo content), and this problem string can reach a public
    // log. Standalone zone - no shared/ redaction helpers here.
    return { files: null, problem: "does not parse as a manifest (invalid JSON)" };
  }
  const manifest = parsed as { files?: unknown } | null;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    typeof manifest.files !== "object" ||
    manifest.files === null ||
    Array.isArray(manifest.files)
  ) {
    return {
      files: null,
      problem: "does not parse as a manifest (no top-level 'files' mapping)",
    };
  }
  const files = manifest.files as Record<string, unknown>;
  // A null entry is refused because a consumer would throw at entry.class, turning warn-and-continue contracts into hard failures.
  for (const value of Object.values(files)) {
    const entry = value as ManifestEntryShape | null;
    if (entry === null || typeof entry !== "object" || typeof entry.class !== "string") {
      return {
        files: null,
        problem: "carries an entry that is not an object with a string class",
      };
    }
  }
  // JSON.parse keeps the LAST value of a duplicated key, so a duplicate can
  // flip a path's ownership class, a field inside one entry (marker, hash),
  // or the whole top-level "files" mapping with no parse error; acting on
  // the parsed value would launder it. hasDuplicateKey walks the text
  // structurally with per-object scopes, so a path literally named "files"
  // never collides with its top-level twin. The key stays unnamed in the
  // problem: manifest keys are target-repo paths and the log is public.
  if (hasDuplicateKey(text)) {
    return {
      files: null,
      problem:
        "binds a key more than once (JSON consumers silently keep the last value, so a duplicate - an entry path or a field inside one - silently changes what the manifest declares)",
    };
  }
  return { files: files as Record<string, ManifestEntryShape>, problem: null };
}

/** Whether any ONE object of the text binds a key more than once. Called
 *  only on text JSON.parse has already accepted, so this token walk runs
 *  over known-valid JSON and its string/escape/scope tracking cannot
 *  desync. */
function hasDuplicateKey(resolved: string): boolean {
  const scopes: Set<string>[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let lastString: string | null = null;
  for (let i = 0; i < resolved.length; i++) {
    const ch = resolved[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
        lastString = resolved.slice(stringStart, i + 1);
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i;
    } else if (ch === ":") {
      // The string before a colon is an object key (valid JSON has no
      // other colon position); compare DECODED so two spellings of one
      // key ("a" and "a") still collide, like JSON.parse does.
      if (lastString !== null && scopes.length > 0) {
        const key = JSON.parse(lastString) as string;
        const scope = scopes[scopes.length - 1];
        if (scope.has(key)) return true;
        scope.add(key);
      }
      lastString = null;
    } else if (ch === "{") {
      scopes.push(new Set());
      lastString = null;
    } else if (ch === "}") {
      scopes.pop();
      lastString = null;
    } else if (ch !== "," && !/\s/.test(ch)) {
      lastString = null;
    }
  }
  return false;
}
