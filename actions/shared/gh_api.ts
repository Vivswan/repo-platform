// `gh api --include` prints the status line, the headers (CRLF), a blank line, and the body, exit 1 off 2xx: the one way to
// read a non-2xx status from gh without parsing its error text.

export interface IncludedResponse {
  /** The HTTP status `gh api --include` printed, or null when it printed no status line. */
  status: number | null;
  /** The response body, one line. */
  body: string;
}

/** The body is folded to one line the way a shell `$(...)` would: CRs dropped, runs of newlines and spaces to one space. */
export function parseIncludedResponse(stdout: string): IncludedResponse {
  const status = /^HTTP\/[0-9.]+ (\d{3})\b/.exec(stdout);
  const separator = /\r?\n\r?\n/.exec(stdout);
  const body = separator === null ? "" : stdout.slice(separator.index + separator[0].length);
  return {
    status: status === null ? null : Number(status[1]),
    body: body
      .replaceAll("\r", "")
      .replaceAll(/[\n ]+/g, " ")
      .replace(/ $/, ""),
  };
}
