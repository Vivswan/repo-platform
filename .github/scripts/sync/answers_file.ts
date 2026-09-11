// The target's .github/.copier-answers.yml, parsed once at the trust
// boundary.
// The file is target-controlled input; the sync's consumers read it
// through this module instead of re-scanning lines with their own
// semantics.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, parse, parseAllDocuments, parseDocument, visit } from "yaml";
import { walkParents } from "./checkout_path.ts";

export interface CopierAnswers {
  /** The recorded _commit VERBATIM, or "" when absent or not a string.
   * Read under the failsafe schema: the file is written with PyYAML (YAML
   * 1.1), which leaves a sha of digits around one e (1626e53...) bare,
   * and the default YAML 1.2 schema would resolve it as a number
   * ("1.626e+56"); an all-digit sha arrives quoted (the stamp hook and
   * copier both quote it) and failsafe undoes that quoting. The stamp
   * hook records the full 40-hex sha, and recorded_commit.ts refuses any
   * other shape. */
  commit: string;
  /** Every recorded answer, for consumers reading TYPED values
   * (settings_drift's boolean private, rehearse's description). Parsed
   * under the default YAML 1.2 schema, which agrees with copier's PyYAML
   * on those values but NOT on every scalar (plain 1e3 is 1000 here, a
   * string to PyYAML), so these must never be re-serialized into copier
   * --data-file input; that path is dataFileYaml, which passes the
   * recorded scalars through verbatim. */
  fields: Record<string, unknown>;
}

/** Thrown for a file this module cannot shape into CopierAnswers. The
 * message can quote target file content - hide-details callers must not
 * print it. */
export class AnswersFileError extends Error {}

/** No answers file at ANSWERS_PATH at all (the file or a parent directory
 * absent). A repository the sync writer path registered never has one, so
 * callers that must tell absence from a present-but-unusable file catch
 * this subclass. */
export class AnswersFileMissingError extends AnswersFileError {}

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

/** The recorded answers file's path inside a target checkout (copier.yml
 * `_answers_file`). */
export const ANSWERS_PATH = ".github/.copier-answers.yml";

/** The raw bytes of the target's recorded answers. Every segment of
 * ANSWERS_PATH beneath the checkout root is target-controlled, and a
 * symlink at any of them - the file itself, or `.github` pointing
 * elsewhere - would let a read (and every later rewrite: the _src_path
 * normalization, copier's own) reach outside the checkout, so the parents
 * must be real directories and the file a regular file. Every sync-side
 * read of the file goes through here, so the refusal holds in whatever
 * order the steps run. */
export function readAnswersBytes(targetDir: string): Buffer {
  const parents = walkParents(targetDir, ANSWERS_PATH);
  if (parents.kind === "missing")
    throw new AnswersFileMissingError("missing from the default branch");
  if (parents.kind === "not-a-directory") {
    throw new AnswersFileError(
      `${parents.segment} is not a real directory (a symlink or a file); the sync refuses to read through it`,
    );
  }
  const path = join(targetDir, ANSWERS_PATH);
  let kind: ReturnType<typeof lstatSync>;
  try {
    kind = lstatSync(path);
  } catch (err) {
    // Only "nothing at this path" is absence; a failure to look (EACCES,
    // EIO, ELOOP) is not, and propagates.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    throw new AnswersFileMissingError("missing from the default branch");
  }
  if (!kind.isFile()) {
    throw new AnswersFileError(
      "not a regular file (a directory or a symlink); the sync refuses to read through it",
    );
  }
  return readFileSync(path);
}

export function readAnswersFile(targetDir: string): CopierAnswers {
  const text = readAnswersBytes(targetDir).toString("utf-8");
  let parsed: unknown;
  try {
    parsed = parse(text, { logLevel: "error" });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new AnswersFileError(`cannot read as YAML: ${detail}`);
  }
  // A plain mapping only: the YAML parser hands back Set, Map, or Date for
  // tagged top levels (!!set, !!omap, !!timestamp), none of them answers.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
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
  /** Live values for the SEEDED_ANSWERS, applied only where the recorded
   * answers lack the key (unrecordedSeeds). */
  seeds?: Readonly<Record<SeededAnswer, string>>;
}

const LIVE_KEYS = ["modules", "private", "description"] as const;

/** The settings starter's identity answers: unrecorded ones (a render from before
 * they were asked) seed from the live repository once, or the starter's empty
 * defaults would clear the live values; a recorded answer wins, empty included. */
export const SEEDED_ANSWERS = ["homepage", "topics"] as const;
export type SeededAnswer = (typeof SEEDED_ANSWERS)[number];

/** The seeds to apply: the live value of each SEEDED_ANSWERS key the
 * recorded answers do not carry, in roster order. */
export function unrecordedSeeds(
  recordedKeys: Iterable<string>,
  live: Readonly<Record<SeededAnswer, string>>,
): [SeededAnswer, string][] {
  const recorded = new Set(recordedKeys);
  return SEEDED_ANSWERS.filter((key) => !recorded.has(key)).map((key) => [key, live[key]]);
}

/** A string as a PyYAML-safe YAML double-quoted scalar. JSON string
 * literals are a valid YAML double-quote subset, EXCEPT that JSON leaves
 * raw some characters YAML 1.1 treats specially: NEL/LS/PS are LINE BREAKS
 * there (PyYAML folds them to spaces), and DEL, the other C1 controls, and
 * U+FFFE/U+FFFF are outside YAML's printable set (PyYAML rejects the
 * file). Those are re-escaped as \\uXXXX. Lone surrogates escape too, but
 * still DECODE to a value copier cannot render; the postcondition's
 * decoded-scalar check refuses those. */
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

// The emitter targets YAML 1.2, where NEL/DEL/C1 are printable, so a
// double-quoted scalar PyYAML wrote as \\x7F or \\u0085 re-emits RAW, which
// PyYAML then rejects (C0/DEL/C1, non-characters) or silently FOLDS to a
// space (raw NEL; raw LS/PS survive PyYAML 6.0.3 and stay carriable). No
// in-place fix is context-safe (a raw byte in a single-quoted or plain
// scalar takes no escape), so such a character or a lone surrogate is
// refused outright; copier-written answers never carry them.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters to refuse them is this rule's whole job
const UNCARRIABLE_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A copier --data-file from the recorded answers, scalars passed through
 * VERBATIM: copier re-parses with PyYAML (YAML 1.1), so a re-typed re-dump
 * would hand it different bytes (`1e3` becomes 1000, a short sha a float);
 * the failsafe schema keeps each scalar's source form. Copier's underscore
 * keys are dropped; with `live`, the live-value keys are re-emitted in
 * PyYAML-safe forms. POSTCONDITION-checked (one mapping, each live key
 * once): target-controlled answers fail loudly here, never reach copier
 * parsing differently. Throws AnswersFileError (may quote target content). */
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
  const recordedKeys: string[] = [];
  contents.items = contents.items.filter((item) => {
    // Under failsafe every scalar is a string; a non-scalar key is a
    // collection key copier never writes - refuse rather than guess
    // which side of the filter it belongs on.
    if (!isScalar(item.key) || typeof item.key.value !== "string") {
      throw new AnswersFileError("top-level keys must be plain scalars");
    }
    const key = item.key.value;
    recordedKeys.push(key);
    return !key.startsWith("_") && !(dropped as readonly string[]).includes(key);
  });
  const seeded =
    live?.seeds === undefined
      ? []
      : unrecordedSeeds(recordedKeys, live.seeds).map(
          ([key, value]) => `${key}: ${yamlDoubleQuoted(value)}\n`,
        );
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
  const out =
    live === null
      ? carried === ""
        ? "{}\n"
        : carried
      : carried + liveDataYaml(live) + seeded.join("");
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
  // Escape-hidden surrogates pass the serialized-text scan (both emitters
  // keep them as plain-ASCII escapes), yet PyYAML decodes them into values
  // Python cannot UTF-8-encode - so the DECODED scalars are checked too.
  let decodedSurrogate = false;
  visit(docs[0], {
    Scalar(_key, node) {
      if (typeof node.value === "string" && LONE_SURROGATE_RE.test(node.value)) {
        decodedSurrogate = true;
        return visit.BREAK;
      }
    },
  });
  if (decodedSurrogate) {
    throw new AnswersFileError(
      "a recorded or live answer carries a lone surrogate (visible only once its escape " +
        "is decoded) - refusing to hand copier a data file it cannot render",
    );
  }
  if (live !== null) {
    // The live keys once each, and every seeded answer once: recorded or
    // seeded, never both and never neither.
    for (const key of [...LIVE_KEYS, ...(live.seeds === undefined ? [] : SEEDED_ANSWERS)]) {
      const count = outMap.items.filter(
        (item) => isScalar(item.key) && item.key.value === key,
      ).length;
      if (count !== 1) throw shapeError();
    }
  }
  return out;
}

/** Why the `_commit` copier's hooks just recorded is not the commit the
 * sync pinned copier to, or null when it is: the stamp hook rewrites the
 * line from copier's vcs_ref_hash, so a mismatch means the hook did not
 * run (a build tree whose copier.yml lost the --commit wiring, or
 * --skip-tasks) and the abbreviation or tag name copier writes itself is
 * what landed. The postcondition apply_update.ts enforces after every
 * copier run. */
export function recordedCommitMismatch(recorded: string, targetSha: string): string | null {
  if (recorded === targetSha) return null;
  const got = recorded === "" ? "no readable _commit" : `_commit '${recorded}'`;
  return (
    `copier recorded ${got} in .github/.copier-answers.yml, but the sync pinned it to ` +
    `commit ${targetSha}. The template's stamp hook rewrites that line from copier's ` +
    "vcs_ref_hash on every render, so it did not run - check the build tree's copier.yml " +
    "hook lines (copier.yml on main carries the wiring)."
  );
}
