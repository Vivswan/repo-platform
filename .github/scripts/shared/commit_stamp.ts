// Provenance stamp lines on build-branch commits. publish.ts writes both
// lines into every build commit message; publish.ts (re-stamp check) and
// sync/resolve_refs.ts + sync/verify_build_provenance.ts parse them back,
// so the exact line shapes live here alone.

export function commitStampWrite(serverUrl: string, repository: string, sha: string): string {
  return `source: ${serverUrl}/${repository}/commit/${sha}`;
}

// Only a full 40-hex sha parses as a stamp: the line is plain text anyone
// can write, and a smuggled revspec (refs/remotes/origin/main) would
// otherwise re-resolve to a different commit on every verification run.
const STAMP_RE = /^source: .*\/commit\/([0-9a-f]{40})$/;

/** Every stamped sha in the message, in order (for walking a branch's
 * stamp history). */
export function commitStampParseAll(message: string): string[] {
  const shas: string[] = [];
  for (const line of message.split("\n")) {
    const match = line.match(STAMP_RE);
    if (match) shas.push(match[1]);
  }
  return shas;
}

/** The first stamped sha in the message (empty when unstamped). */
export function commitStampParse(message: string): string {
  return commitStampParseAll(message)[0] ?? "";
}

export function commitRunWrite(runUrl: string): string {
  return `run: ${runUrl}`;
}

const RUN_RE = /^run: .*\/actions\/runs\/(.*)$/;

/** The first stamped run id in the message (empty when there is none). */
export function commitRunParse(message: string): string {
  for (const line of message.split("\n")) {
    const match = line.match(RUN_RE);
    if (match) return match[1];
  }
  return "";
}
