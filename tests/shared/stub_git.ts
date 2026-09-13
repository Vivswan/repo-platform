// A `git` on PATH for a script whose one git call is the newest-wins tip read (fleet/newest_main.ts):
// ls-remote answers STUB_MAIN_TIP as main's tip, or a dead remote when STUB_GIT_FAIL is set. Any other
// subcommand is a stub bug. When STUB_CALLS names a file, every call is appended to it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const STUB_GIT_FAIL_EXIT = 128;
export const STUB_GIT_FAIL_STDERR = "fatal: unable to access 'origin': Could not resolve host";
/** What the tip read's caller prints for the dead remote (shared/git_yes_no.ts). */
export const STUB_GIT_FAIL_REFUSAL = `git ls-remote could not answer (exit ${STUB_GIT_FAIL_EXIT}); refusing to guess: ${STUB_GIT_FAIL_STDERR}`;

export function writeStubGit(bin: string): void {
  writeFileSync(
    join(bin, "git"),
    [
      "#!/usr/bin/env bash",
      '[ -z "$STUB_CALLS" ] || echo "git $*" >> "$STUB_CALLS"',
      '[ "$1" = "ls-remote" ] || { echo "stub git: unexpected $*" >&2; exit 64; }',
      'if [ -n "$STUB_GIT_FAIL" ]; then',
      `  echo "${STUB_GIT_FAIL_STDERR}" >&2`,
      `  exit ${STUB_GIT_FAIL_EXIT}`,
      "fi",
      'printf "%s\\trefs/heads/main\\n" "$STUB_MAIN_TIP"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}
