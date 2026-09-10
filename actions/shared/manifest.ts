// The ownership manifest's ONE emitter and ONE parser.
//
// .github/repo-platform-manifest.json is written and read at four stations
// (compose/manifest.ts renders it, copier's stamp hook rewrites its hash
// tokens, the sync legs rebuild split files from it, validate-template
// checks byte parity against it), and each once carried its own copy of
// the entry-line layout or the duplicate-tolerant parse, which drifted.
// Consumers keep their own DATA: the validator's ownership tables are
// generated from the template declarations, never read from the manifest,
// because sync baselines manifest edits and a hand-flipped class would
// self-certify. Only the CODE that turns bytes into entries lives here.
//
// Layout contract: one entry per line, 4-space indent, the JSON-quoted
// path, one inline JSON object, so a stamped manifest differs from the raw
// render in token values alone and copier's three-way update merge sees
// minimal local edits.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal
// imports only.

import {
  type AssertNever,
  GRAMMAR,
  type GrammarId,
  MANAGED_REGION_WIRE_FIELDS,
  type SplitShapes,
} from "./grammar.ts";

/** Where the ownership manifest lands in generated repositories. */
export const MANIFEST_NAME = ".github/repo-platform-manifest.json";

/** Every class a recorded entry can carry. The sync writer's record union
 *  and the validator's class dispatch are both pinned to this table, so a
 *  class one side learns reaches the other or the build fails. */
export const RECORDED_CLASSES = ["managed", "split", "starter", "mirror", "link"] as const;
export type RecordedClass = (typeof RECORDED_CLASSES)[number];
const RECORDED_CLASS_SET: ReadonlySet<string> = new Set(RECORDED_CLASSES);

export function isRecordedClass(value: string): value is RecordedClass {
  return RECORDED_CLASS_SET.has(value);
}

/** What an entry needs to be emitted: the declared class, with the
 *  grammar fields for splits (structural twins of the ownership schema's
 *  arms - scripts/ownership/declarations.ts's ManifestOwnership is assignable). */
export type OwnershipShape =
  | { class: "starter" }
  | { class: "managed" }
  | ({ class: "split" } & SplitShapes[GrammarId]);

/** What JSON.parse returns and JSON.stringify prints without loss. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One entry object in the manifest's one-line layout: fields in the given
 *  order, `"key": value` pairs joined by `, `. The emitter below and the
 *  stamper's in-place rewrite both print through this, so the stamped
 *  manifest and the raw render share one byte layout. */
export function entryBody(fields: Record<string, JsonValue>): string {
  return `{${Object.entries(fields)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(", ")}}`;
}

/** One split entry's wire body, read off the grammar's GRAMMAR row: the
 *  row's wireFields under their own names in the row's order - so no
 *  spelling of the split fields exists outside the table. */
function splitBody<K extends GrammarId>(grammar: K, declaration: SplitShapes[K]): string {
  const fields: Record<string, JsonValue> = { class: "split", grammar };
  // Declaration fields are the grammar's marker strings, JSON values by
  // construction; the generic index loses that.
  for (const field of GRAMMAR[grammar].wireFields) {
    fields[String(field)] = declaration[field] as JsonValue;
  }
  fields.hash = null;
  return entryBody(fields);
}

/** One manifest entry line. Every hash renders null (hashes are per-repo
 *  facts the stamp hook fills in post-render), and the manifest's own
 *  entry carries the null provenance-commit slot the stamper writes the
 *  render's recorded _commit into. */
export function entryLine(path: string, ownership: OwnershipShape): string {
  let body: string;
  if (ownership.class === "starter") {
    body = entryBody({ class: "starter" });
  } else if (ownership.class === "managed") {
    body = entryBody(
      path === MANIFEST_NAME
        ? { class: "managed", hash: null, commit: null }
        : { class: "managed", hash: null },
    );
  } else {
    body = splitBody(ownership.grammar, ownership);
  }
  return `    ${JSON.stringify(path)}: ${body}`;
}

/** One rendered entry line, decomposed: indentation, the decoded path, the
 *  one-line entry object, the optional joining comma. null for any other
 *  line. The regex is entryLine's layout read back - the two live in one
 *  module so they cannot drift. */
const ENTRY_LINE_RE = /^(\s*)("(?:[^"\\]|\\.)*"): (\{.*\})(,?)$/;

export interface ParsedEntryLine {
  indent: string;
  path: string;
  /** The path exactly as quoted in the line (for byte-faithful rewrites). */
  quotedPath: string;
  body: string;
  comma: string;
}

export function parseEntry(line: string): ParsedEntryLine | null {
  const match = ENTRY_LINE_RE.exec(line);
  if (!match) return null;
  return {
    indent: match[1],
    path: JSON.parse(match[2]) as string,
    quotedPath: match[2],
    body: match[3],
    comma: match[4],
  };
}

// Copier's inline conflict markers, exactly as `copier update` writes them
// (git merge-file labels): anything looser could swallow content lines.
const CONFLICT_START = "<<<<<<< before updating";
const CONFLICT_SEP = "=======";
const CONFLICT_END = ">>>>>>> after updating";

/** Copier's inline conflict blocks resolved toward the template side: the
 *  lines between ======= and >>>>>>> survive, the "before updating" local
 *  lines and the marker lines drop. Only exact, well-sequenced copier
 *  markers count; a malformed block (unterminated, or an END outside a
 *  block) returns the text unchanged - dropping lines on a guess could
 *  silently discard entries, and the parse step then reports the mess. A
 *  bare ======= outside a block is ordinary content. */
export function resolveConflictsTowardAfter(text: string): string {
  const out: string[] = [];
  let state: "keep" | "local" | "template" = "keep";
  for (const line of text.split("\n")) {
    if (line === CONFLICT_START) {
      if (state !== "keep") return text;
      state = "local";
    } else if (line === CONFLICT_SEP && state !== "keep") {
      // A second separator inside a block is malformed; outside any block
      // a bare ======= is ordinary content.
      if (state !== "local") return text;
      state = "template";
    } else if (line === CONFLICT_END) {
      if (state !== "template") return text;
      state = "keep";
    } else if (state !== "local") {
      out.push(line);
    }
  }
  if (state !== "keep") return text;
  return out.join("\n");
}

/** Every marker-string field any grammar's declaration owns, derived from
 *  the table's SplitShapes: a new grammar's fields join the wire
 *  vocabulary below without a hand edit here. */
type SplitDeclarationField = {
  [K in GrammarId]: Exclude<keyof SplitShapes[K], "grammar">;
}[GrammarId];

/** One parsed entry's known field vocabulary; every value stays unknown
 *  because manifest text is target-repo content on updates - consumers
 *  validate what they use. The split marker-string fields are the
 *  grammars' own declaration fields (SplitDeclarationField); the rest is
 *  the wire-common set. */
export type ManifestEntryShape = {
  class: string;
  hash?: unknown;
  grammar?: unknown;
  commit?: unknown;
} & { [F in SplitDeclarationField]?: unknown };

/** The closed entry-field vocabulary, the runtime twin of ManifestEntryShape: `satisfies` refuses
 *  a stranger and the AssertNever pin refuses an omission (a new grammar's tuple joins here or the
 *  build fails). The stamper re-emits entries from these keys alone; the validator reports others. */
export const ENTRY_FIELDS = [
  "class",
  "hash",
  "grammar",
  "commit",
  ...MANAGED_REGION_WIRE_FIELDS,
] as const satisfies readonly (keyof ManifestEntryShape)[];
export type EntryFieldsExhaustive = AssertNever<
  Exclude<keyof ManifestEntryShape, (typeof ENTRY_FIELDS)[number]>
>;
const ENTRY_FIELD_SET: ReadonlySet<string> = new Set(ENTRY_FIELDS);

/** Whether `key` is in the entry-field vocabulary. */
export function isEntryField(key: string): boolean {
  return ENTRY_FIELD_SET.has(key);
}

/** Each entry carrying a field outside ENTRY_FIELDS, with the offending keys, in manifest order. */
export function unknownEntryFields(
  files: Record<string, ManifestEntryShape>,
): { path: string; fields: string[] }[] {
  return Object.entries(files).flatMap(([path, entry]) => {
    const fields = Object.keys(entry).filter((key) => !isEntryField(key));
    return fields.length === 0 ? [] : [{ path, fields }];
  });
}

/** The manifest's files mapping parsed from `text` (conflict blocks
 *  resolved toward the template side first), or a problem string when the
 *  text cannot be trusted. Every consumer reads through here, so no station
 *  can act on a manifest another one refused. Every problem string is
 *  VALUE-FREE: the text is target-repo content on updates and the strings
 *  reach public logs. A null entry is refused because a consumer would throw
 *  at entry.class, turning warn-and-continue contracts into hard failures; a
 *  scalar or classless entry and duplicate keys (below) are refused too. */
export function parseManifestFiles(text: string):
  | { files: Record<string, ManifestEntryShape>; resolved: string; problem: null }
  | {
      files: null;
      resolved: string;
      problem: string;
    } {
  const resolved = resolveConflictsTowardAfter(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolved);
  } catch {
    // Value-free on purpose: a SyntaxError's message quotes manifest text
    // (target-repo content), and this problem string can reach a public
    // log. Standalone zone - no shared/ redaction helpers here.
    return { files: null, resolved, problem: "does not parse as a manifest (invalid JSON)" };
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
      resolved,
      problem: "does not parse as a manifest (no top-level 'files' mapping)",
    };
  }
  const files = manifest.files as Record<string, unknown>;
  for (const value of Object.values(files)) {
    const entry = value as ManifestEntryShape | null;
    if (entry === null || typeof entry !== "object" || typeof entry.class !== "string") {
      return {
        files: null,
        resolved,
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
  if (hasDuplicateKey(resolved)) {
    return {
      files: null,
      resolved,
      problem:
        "binds a key more than once (JSON consumers silently keep the last value, so a duplicate - an entry path or a field inside one - silently changes what the manifest declares)",
    };
  }
  return { files: files as Record<string, ManifestEntryShape>, resolved, problem: null };
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
