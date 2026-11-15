// Quoted text may carry backticks of its own. Markdown closes a fence on a run at least as long as the opener and a
// code span on a run of exactly its length, so each delimiter here is one backtick longer than any run it encloses.

/** The shortest fence Markdown opens. */
const SHORTEST_FENCE = 3;

/** Markdown strips one space from each end of a code span that is not all spaces: text that opens or closes on a space or a backtick is padded. */
const NEEDS_PADDING = /^[` ]|[` ]$/;

/** A code span holding spaces alone is kept as written, so padding would add to it. */
const ONLY_SPACES = /^ +$/;

/** CommonMark ends a line on LF, CR, or CRLF, and no other character. */
const LINE_BREAKS = /[\r\n]+/g;

/** What stands for no text. Markdown has no empty code span: two backticks open a span that the next delimiter on the line closes. */
const EMPTY = "(empty)";

function longestRun(text: string): number {
  return (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
}

/** The lines of a fenced block holding `text` verbatim, opened under the info string `info`. */
export function fenced(text: string, info: string): string[] {
  const fence = "`".repeat(Math.max(SHORTEST_FENCE, longestRun(text) + 1));
  return [`${fence}${info}`, text, fence];
}

/**
 * `text` with each run of line breaks as one space.
 *
 * A line break ends a list item, a table row, or a heading, and what follows it opens a Markdown block of its own.
 */
export function oneLine(text: string): string {
  return text.replace(LINE_BREAKS, " ");
}

/** `text` as an inline code span, or fixed words outside any span for no text. The span is always one line: `oneLine` flattens `text` first. */
export function codeSpan(text: string): string {
  if (text === "") return EMPTY;

  const line = oneLine(text);
  const ticks = "`".repeat(longestRun(line) + 1);
  const pad = NEEDS_PADDING.test(line) && !ONLY_SPACES.test(line) ? " " : "";

  return `${ticks}${pad}${line}${pad}${ticks}`;
}
