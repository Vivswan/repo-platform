// The .gitignore REPOSITORY LOCAL region grammar, shared by the two
// writers that must agree on it: scripts/build_gitignore.ts (regenerates
// this repo's own .gitignore around the existing LOCAL body) and
// .github/scripts/sync/preserve_local_content.ts (splices a target repo's
// LOCAL body into a fresh render). One owner on purpose: a duplicate that
// drifted would let one writer mis-slice what the other produced.
//
// actions/validate-template deliberately does NOT import this module: the
// action ships standalone and enforces its own marker rules.

export const LOCAL_BEGIN = "# BEGIN REPOSITORY LOCAL";
export const LOCAL_END = "# END REPOSITORY LOCAL";

export interface Line {
  text: string;
  /** Index just past the line's newline (or end of content). */
  end: number;
}

export function splitLines(content: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      out.push({ text: content.slice(start, i), end: i + 1 });
      start = i + 1;
    }
  }
  if (start < content.length) out.push({ text: content.slice(start), end: content.length });
  return out;
}

export function stripCr(text: string): string {
  return text.replace(/\r+$/, "");
}

/** The LOCAL section split line-anchored on the BEGIN/END marker lines:
 * before runs through the BEGIN line, body sits between the markers, after
 * starts at the END line. Null when no ordered BEGIN/END line pair exists. */
export function localRegion(
  content: string,
): { before: string; body: string; after: string } | null {
  const lines = splitLines(content);
  const begin = lines.findIndex((line) => stripCr(line.text) === LOCAL_BEGIN);
  if (begin === -1) return null;
  const end = lines.findIndex((line, index) => index > begin && stripCr(line.text) === LOCAL_END);
  if (end === -1) return null;
  const bodyStart = lines[begin].end;
  const bodyEnd = lines[end - 1].end;
  return {
    before: content.slice(0, bodyStart),
    body: content.slice(bodyStart, bodyEnd),
    after: content.slice(bodyEnd),
  };
}
