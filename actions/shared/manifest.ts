// The ownership manifest's ONE emitter and ONE parser.
//
// .github/repo-platform-manifest.json is written and read at four stations
// - compose_template.ts renders its template, copier's stamp hook rewrites
// its hash tokens in place, the sync legs read it to rebuild split files,
// and validate-template verifies byte parity against it - and each station
// once carried its own private copy of the entry-line layout or the
// duplicate-tolerant parse, which drifted (duplicate-key handling existed
// on one side only). This module is the single owner of both directions:
// entryLine emits the one-line entry layout, parseEntry reads one such
// line back, and parseManifestFiles parses (and validates) a whole
// manifest text. Consumers keep their own DATA - the validator's ownership
// tables are generated from the template declarations, never read from the
// manifest, because sync baselines manifest edits and a hand-flipped class
// would self-certify - but the CODE that turns bytes into entries lives
// here alone.
//
// The layout contract: one entry per line, 4-space indent, the JSON-quoted
// path, one inline JSON object, so a stamped manifest differs from the raw
// render in token values alone and copier's three-way update merge sees
// minimal local edits.
//
// DEPENDENCY-FREE ZONE (see grammar.ts): ships on the build branch, runs
// inside freshly rendered repositories - node builtins and zone-internal
// imports only.

import { GRAMMAR, type GrammarId, grammarWireMarker, type SplitShapes } from "./grammar.ts";

/** Where the ownership manifest lands in generated repositories. */
export const MANIFEST_NAME = ".github/repo-platform-manifest.json";

/** What an entry needs to be emitted: the declared class, with the
 *  grammar fields for splits (structural twins of the ownership schema's
 *  arms - scripts/ownership.ts's ManifestOwnership is assignable). */
export type OwnershipShape =
  | { class: "starter" }
  | { class: "managed" }
  | ({ class: "split" } & SplitShapes[GrammarId]);

/** One split entry's wire body, read off the grammar's GRAMMAR row: the
 *  row's wireMarker lands in the legacy `marker`/`managed` pair (the
 *  stamper's managedHalf and older validators read those), then the row's
 *  wireExtras under their own names in the row's order - so no spelling
 *  of the split fields exists outside the table. */
function splitBody<K extends GrammarId>(grammar: K, declaration: SplitShapes[K]): string {
  const spec = GRAMMAR[grammar];
  const extras = spec.wireExtras
    .map((field) => `, ${JSON.stringify(field)}: ${JSON.stringify(declaration[field])}`)
    .join("");
  return (
    `{"class": "split", "grammar": ${JSON.stringify(grammar)}, ` +
    `"marker": ${JSON.stringify(grammarWireMarker(grammar, declaration))}, ` +
    `"managed": "${spec.side}"${extras}, "hash": null}`
  );
}

/** One manifest entry line. Every hash renders null (hashes are per-repo
 *  facts the stamp hook fills in post-render), and the manifest's own
 *  entry carries the null provenance-commit slot the stamper writes the
 *  render's recorded _commit into. */
export function entryLine(path: string, ownership: OwnershipShape): string {
  let body: string;
  if (ownership.class === "starter") {
    body = '{"class": "starter"}';
  } else if (ownership.class === "managed") {
    body =
      path === MANIFEST_NAME
        ? '{"class": "managed", "hash": null, "commit": null}'
        : '{"class": "managed", "hash": null}';
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
  managed?: unknown;
  hash?: unknown;
  grammar?: unknown;
  commit?: unknown;
} & { [F in SplitDeclarationField]?: unknown };

/** The manifest's files mapping parsed from `text` (conflict blocks
 *  resolved toward the template side first), or a problem string when the
 *  text cannot be trusted - shared by every consumer, so no two stations
 *  can read different manifests and every one inherits the SAME
 *  validation: no mutation, stamp, or parity check ever sees a manifest
 *  this function did not clear. Every problem string is VALUE-FREE: the
 *  text is target-repo content on updates and the strings reach public
 *  logs, so none of them ever carries manifest bytes. Rejected here:
 *  - unparseable JSON, or no top-level 'files' mapping;
 *  - an entry value that is not a plain object with a string class (a
 *    null or scalar entry would throw at entry.class in a consumer,
 *    turning warn-and-continue contracts into hard failures);
 *  - a duplicated key anywhere in the JSON (found structurally, by
 *    hasDuplicateKey): duplicate JSON keys last-win at parse time, so a
 *    duplicate can flip a path's class with no parse error, and acting
 *    on the parsed value would launder it. Detection compares DECODED
 *    keys (two spellings of one key collide, like JSON.parse), but the
 *    key is deliberately NOT named in the problem - manifest keys are
 *    target-repo paths; existence is the diagnostic and the operator has
 *    the manifest. */
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
  // Duplicates count STRUCTURALLY: hasDuplicateKey walks the (already
  // JSON.parse-validated) text and finds a key bound twice inside any one
  // object - the thing JSON.parse flattens away by keeping the LAST value.
  // Any duplicate shape is caught this way: two entry lines for one path
  // (which would flip that path's ownership class silently), a duplicated
  // field inside one entry (which would flip its marker or hash), and a
  // duplicated top-level "files" mapping (which would swap the whole entry
  // set); a path literally named "files" or "$comment" is never confused
  // with its top-level structural twin, because scopes are tracked per
  // object. The problem string stays value-free like every other branch:
  // manifest keys are target-repo paths, so naming one would print
  // private-repo content into a public log - existence is the diagnostic,
  // and the operator has the manifest.
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
