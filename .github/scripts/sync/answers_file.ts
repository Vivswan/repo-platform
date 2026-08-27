// The target's .copier-answers.yml, parsed once at the trust boundary.
// The file is target-controlled input; the sync's consumers read it
// through this module instead of re-scanning lines with their own
// semantics.

import { readFileSync } from "node:fs";
import { isMap, isScalar, parse, parseAllDocuments, parseDocument } from "yaml";

export interface CopierAnswers {
  /** The recorded _commit VERBATIM, or "" when absent or not a string.
   * Read under the failsafe schema: copier writes with PyYAML (YAML 1.1),
   * which leaves short shas like 1626e53 or 0089012 bare, and the default
   * YAML 1.2 schema would resolve them as numbers ("1.626e+56", "89012").
   * Failsafe keeps every scalar a string while still undoing copier's
   * to_nice_yaml quoting of ambiguous values. */
  commit: string;
  /** Every recorded answer, for field-specific consumers reading TYPED
   * values (settings_drift's boolean private, rehearse's description).
   * Parsed under the default YAML 1.2 schema, which agrees with copier's
   * PyYAML on the values those consumers read (copier writes booleans as
   * plain true/false and quotes 1.1-ambiguous strings when dumping) - but
   * NOT on every scalar (plain 1e3 is 1000 here, a string to PyYAML), so
   * these values must never be re-serialized into copier --data-file
   * input; that path goes through dataFileYaml, which passes the
   * recorded scalars through verbatim. */
  fields: Record<string, unknown>;
}

/** Thrown for a file this module cannot shape into CopierAnswers. The
 * message can quote target file content - hide-details callers must not
 * print it. */
export class AnswersFileError extends Error {}

function commitOf(text: string): string {
  // logLevel error: the parser's default level prints warned-on source
  // lines (an explicit !!tag) to stderr, which would leak target-controlled
  // file content past the callers' hide-details handling. "error" silences
  // warnings only - real parse errors still throw ("silent" would swallow
  // those too).
  const raw = parse(text, { schema: "failsafe", logLevel: "error" }) as Record<string, unknown>;
  const value = raw._commit;
  return typeof value === "string" ? value : "";
}

export function readAnswersFile(path: string): CopierAnswers {
  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = parse(text, { logLevel: "error" });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new AnswersFileError(`cannot read as YAML: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AnswersFileError("top level must be a mapping");
  }
  return { commit: commitOf(text), fields: parsed as Record<string, unknown> };
}

/** The live values render_data.ts re-supplies on top of the recorded
 * answers; their keys are dropped from the carried document and re-emitted
 * from these values exactly once. */
export interface LiveRenderData {
  modules: readonly string[];
  private: boolean;
  description: string;
}

const LIVE_KEYS = ["modules", "private", "description"] as const;

/** A string as a PyYAML-safe YAML double-quoted scalar. JSON string
 * literals are a valid YAML double-quote subset (JSON.stringify emits only
 * escapes YAML also defines, and escapes lone surrogates itself), EXCEPT
 * that JSON leaves some characters raw which YAML 1.1 treats specially:
 * NEL/LS/PS are LINE BREAKS there (PyYAML would fold them to spaces), and
 * DEL, the other C1 controls, and the U+FFFE/U+FFFF non-characters are
 * outside YAML's printable set (PyYAML rejects the file). Those are
 * re-escaped as \\uXXXX, which PyYAML reads back verbatim. */
function yamlDoubleQuoted(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029\ufffe\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function liveDataYaml({ modules, private: privateFlag, description }: LiveRenderData): string {
  const moduleLines =
    modules.length === 0
      ? "modules: []\n"
      : `modules:\n${modules.map((name) => `  - ${yamlDoubleQuoted(name)}\n`).join("")}`;
  return `${moduleLines}private: ${privateFlag}\ndescription: ${yamlDoubleQuoted(description)}\n`;
}

// The emitter targets YAML 1.2, where NEL/DEL/C1 are printable non-breaks
// - so a carried double-quoted scalar PyYAML wrote as \\x7F or \\u0085
// re-emits as the RAW character, which PyYAML then rejects (C0/DEL/C1,
// non-characters) or silently FOLDS to a space (raw NEL; raw LS/PS are
// preserved by PyYAML 6, verified against 6.0.3, so they stay
// carriable and refusing them would false-reject). No in-place
// fix is context-safe (a raw byte inside a single-quoted or plain scalar
// cannot take a backslash escape), so an assembled data file carrying any
// such character - or a lone surrogate - is refused outright.
// Copier-written answers never contain them in practice; refusing loudly
// beats delivering renders that diverge from copier's own.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters to refuse them is this rule's whole job
const UNCARRIABLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A copier --data-file built from the recorded answers, scalars passed
 * through VERBATIM: copier re-parses the data file with PyYAML (YAML 1.1),
 * so the invariant is byte-level, not value-level - a re-typed re-dump
 * would hand PyYAML different bytes than the answers file held (the yaml
 * package's default schema reads `project_name: 1e3` as 1000 and
 * `_commit: 1626e53` as 1.626e+56; even its yaml-1.1 mode floats 1e3,
 * which PyYAML keeps a string). Parsing the document under the failsafe
 * schema and re-emitting it preserves each scalar's source form (plain
 * stays plain, quoting style survives), so PyYAML parses the emission
 * exactly as it parses the answers file itself. Copier answer keys with a
 * leading underscore (copier's own metadata) are dropped whole; with
 * `live` set, the live-value keys are dropped too and re-emitted from the
 * live values in PyYAML-safe forms.
 *
 * The result is POSTCONDITION-checked before it is returned: re-parsed as
 * exactly one mapping document carrying each live key exactly once. The
 * answers file is target-controlled, and a shape this assembly cannot
 * carry (a document-end marker that would strand appended keys, an alias
 * whose anchor the filter dropped) must fail loudly here, never hand
 * copier a data file that parses differently than the answers did.
 *
 * Throws AnswersFileError for text this cannot shape; the message can
 * quote target file content - hide-details callers must not print it. */
export function dataFileYaml(text: string, live: LiveRenderData | null): string {
  // logLevel error for the same reason as commitOf.
  const doc = parseDocument(text, { schema: "failsafe", logLevel: "error" });
  if (doc.errors.length > 0) {
    throw new AnswersFileError(`cannot read as YAML: ${doc.errors[0].message.split("\n")[0]}`);
  }
  const contents = doc.contents;
  if (!isMap(contents)) {
    throw new AnswersFileError("top level must be a mapping");
  }
  const dropped = live === null ? [] : LIVE_KEYS;
  contents.items = contents.items.filter((item) => {
    // Under failsafe every scalar is a string; a non-scalar key is a
    // collection key copier never writes - refuse rather than guess
    // which side of the filter it belongs on.
    if (!isScalar(item.key) || typeof item.key.value !== "string") {
      throw new AnswersFileError("top-level keys must be plain scalars");
    }
    const key = item.key.value;
    return !key.startsWith("_") && !(dropped as readonly string[]).includes(key);
  });
  let carried: string;
  if (contents.items.length === 0) {
    // "{}\n" would strand appended keys after a flow mapping, and "" would
    // read as null to PyYAML (copier crashes on a null data file); the
    // postcondition below settles which caller gets which shape.
    carried = "";
  } else {
    try {
      carried = doc.toString();
    } catch (err) {
      // The emitter's message can quote target content (an unresolved
      // alias error names the anchor); keep the typed contract with a
      // value-free summary.
      throw new AnswersFileError(
        `the answers document cannot be re-emitted after filtering (${
          err instanceof Error ? err.constructor.name : "error"
        }; an alias whose anchor was dropped, or a shape the emitter refuses)`,
      );
    }
  }
  const out = live === null ? (carried === "" ? "{}\n" : carried) : carried + liveDataYaml(live);
  // Postcondition on the assembled text, not the inputs: the failure mode
  // is silent divergence, so anything short of one clean mapping document
  // with the live keys exactly once is refused.
  if (UNCARRIABLE_RE.test(out) || LONE_SURROGATE_RE.test(out)) {
    throw new AnswersFileError(
      "a recorded answer carries control, line-separator, or non-character text " +
        "that cannot ride a data file verbatim (PyYAML would reject or fold it) - " +
        "refusing to hand copier a data file that parses differently than the answers did",
    );
  }
  const docs = parseAllDocuments(out, { schema: "failsafe", logLevel: "error" });
  const shapeError = () =>
    new AnswersFileError(
      "the recorded answers document's shape cannot be carried into a copier data " +
        "file (a document-end marker or directive strands the appended keys, or the " +
        "re-emission is not a single mapping)",
    );
  if (docs.length !== 1 || docs[0].errors.length > 0) throw shapeError();
  const outMap = docs[0].contents;
  if (!isMap(outMap)) throw shapeError();
  if (live !== null) {
    for (const key of LIVE_KEYS) {
      const count = outMap.items.filter(
        (item) => isScalar(item.key) && item.key.value === key,
      ).length;
      if (count !== 1) throw shapeError();
    }
  }
  return out;
}
