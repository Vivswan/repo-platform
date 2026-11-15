import { isMap, isScalar, Lexer, parseDocument, visit } from "yaml";
import { PLATFORM_NAME, PLATFORM_OWNER } from "../../actions/shared/platform";

const OWNER = /^[A-Za-z0-9_.-]+$/;

export interface Pin {
  /** The source the line was read from, as handed to the extractor. */
  file: string;

  /** The reference's first two path segments, `owner/name`, a sub-path dropped. */
  action: string;

  /** The text after the `@`: a sha, a tag, or a branch. */
  ref: string;

  /** The trailing `# <tag>` comment naming what the ref was pinned from, or null when the line carries none. */
  version: string | null;
}

/** The pin a `uses:` value names, or null for a path in the caller's checkout, a `$/` path, or an image. `comment`
 *  is the one trailing the step's line. */
function pinOf(value: unknown, comment: string | null | undefined, file: string): Pin | null {
  const [path, ref] = String(value).split("@");
  const [owner, name] = path.split("/");
  if (ref === undefined || name === undefined || !OWNER.test(owner)) return null;

  return {
    file,
    action: `${owner}/${name}`,
    ref,
    version: comment?.trim().split(/\s+/)[0] ?? null,
  };
}

/** Every `uses:` pin of a YAML source as the parser reads it, then those of its commented example lines, each comment
 *  read as a document of its own. A source is rendered first (shipped_source.ts): a placeholder is no YAML. */
export function extractUsesPins(text: string, file: string): Pin[] {
  const pins: Pin[] = [];
  visit(parseDocument(text), {
    Pair(_key, pair, path) {
      if (!isScalar(pair.key) || pair.key.value !== "uses" || !isScalar(pair.value)) return;

      // A flow-style step's trailing comment sits on its mapping, a block-style one's on the value.
      const step = path.at(-1);
      const flowComment = isMap(step) && step.flow ? step.comment : null;
      const pin = pinOf(pair.value.value, pair.value.comment ?? flowComment, file);
      if (pin !== null) pins.push(pin);
    },
  });
  const comments = [...new Lexer().lex(text)].filter((token) => token.startsWith("#"));
  return [...pins, ...comments.flatMap((comment) => extractUsesPins(comment.slice(1), file))];
}

export interface SelfPin {
  /** The source the line was read from, as handed to the extractor. */
  file: string;

  /** The owner slot as written: the `github_username` placeholder or a literal owner. */
  owner: string;

  /** The pin's stem after the owner: <name>/<path>. */
  stem: string;

  /** The text after the `@`, up to a blank or a quote. */
  ref: string;
}

/** A self pin is a `uses:` naming this repository under any owner slot (a placeholder or a literal), so a mistyped owner is judged
 *  rather than skipped. Only the `uses:` keyword marks a pin: prose spells the shape with an ellipsis. */
export function sourceSelfPins(text: string, file: string): SelfPin[] {
  const ownerSlot = String.raw`(\{\{\s*[a-z_]+\s*\}\}|[A-Za-z0-9-]+)`;
  const token = new RegExp(
    String.raw`uses:\s*['"]?${ownerSlot}/(${RegExp.escape(PLATFORM_NAME)}/[A-Za-z0-9_./-]+)@([^\s"'\x60]*)`,
    "gi",
  );
  return [...text.matchAll(token)].map((match) => ({
    file,
    owner: match[1],
    stem: match[2],
    ref: match[3],
  }));
}

/** Every `uses:` naming a file of this repository by GitHub's `$/` path, which resolves against the repository holding
 *  the file at the commit the run fetched it from. */
export function selfPaths(text: string, file: string): { file: string; path: string }[] {
  return [...text.matchAll(/uses:\s*['"]?\$\/([^\s'"]+)/g)].map((match) => ({
    file,
    path: match[1],
  }));
}

/** The owner a self pin may name: this repository's owner in any case, or the writer's `github_username` placeholder in either spelling. */
export function ownsPlatform(owner: string): boolean {
  return (
    /^\{\{\s*github_username(_lower)?\s*\}\}$/.test(owner) ||
    owner.toLowerCase() === PLATFORM_OWNER.toLowerCase()
  );
}
