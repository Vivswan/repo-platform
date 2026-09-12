// The source line's shape is parsed back by build-branches/publish.ts, sync/resolve_build.ts, fleet/judged_range.ts, and shared/stamp_checks.ts.
// The run line is a human breadcrumb to the publishing run; nothing parses it.

export function commitStampWrite(serverUrl: string, repository: string, sha: string): string {
  return `source: ${serverUrl}/${repository}/commit/${sha}`;
}

// Only a full 40-hex sha parses as a stamp: the line is plain text anyone
// can write, and a smuggled revspec (refs/remotes/origin/main) would
// otherwise re-resolve to a different commit on every verification run.
const STAMP_RE = /^source: .*\/commit\/([0-9a-f]{40})$/;

export function commitStampParseAll(message: string): string[] {
  const shas: string[] = [];
  for (const line of message.split("\n")) {
    const match = line.match(STAMP_RE);
    if (match) shas.push(match[1]);
  }
  return shas;
}

export function commitStampParse(message: string): string {
  return commitStampParseAll(message)[0] ?? "";
}

export function commitRunWrite(runUrl: string): string {
  return `run: ${runUrl}`;
}
