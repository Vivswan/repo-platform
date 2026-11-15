// Quoted text may carry backticks of its own. Markdown closes a fence on a run at least as long as the opener and a
// code span on a run of exactly its length, so each delimiter here is one backtick longer than any run it encloses.

/** The shortest fence Markdown opens. */
const SHORTEST_FENCE = 3;

/** Markdown strips one space from each end of a code span: text that opens or closes on a space or a backtick is padded. */
const NEEDS_PADDING = /^[` ]|[` ]$/;

function longestRun(text: string): number {
  return (text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
}

/** The lines of a fenced block holding `text` verbatim, opened under the info string `info`. */
export function fenced(text: string, info: string): string[] {
  const fence = "`".repeat(Math.max(SHORTEST_FENCE, longestRun(text) + 1));
  return [`${fence}${info}`, text, fence];
}

/** `text` as an inline code span; the caller keeps it on one line. */
export function codeSpan(text: string): string {
  const ticks = "`".repeat(longestRun(text) + 1);
  const pad = NEEDS_PADDING.test(text) ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
}
