// A `git` on PATH for a script whose only git calls are ls-remote reads (the newest-wins tip read of
// fleet/newest_main.ts, the branch probe of sync/resolve_row.ts): ls-remote answers STUB_MAIN_TIP as the
// asked ref's tip (under STUB_REF_PREFIX when set: a ref that only ends in the asked one, as ls-remote's suffix
// match answers), exit 2 for the ref STUB_MISSING_REF names, or a dead remote when STUB_GIT_FAIL is set. With --symref
// it first answers HEAD as STUB_DEFAULT_BRANCH (main), and the missing ref then prints nothing at exit 0, as git does once
// HEAD matched. Any other subcommand is a stub bug. When STUB_CALLS names a file, every call is appended to it.

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
      'case " $* " in *" --symref "*) printf "ref: refs/heads/%s\\tHEAD\\n%s\\tHEAD\\n" "${STUB_DEFAULT_BRANCH:-main}" "$STUB_MAIN_TIP"; missing_exit=0 ;; esac',
      '[ -z "$STUB_MISSING_REF" ] || [ "${@: -1}" != "$STUB_MISSING_REF" ] || exit "${missing_exit:-2}"',
      'printf "%s\\t%s%s\\n" "$STUB_MAIN_TIP" "$STUB_REF_PREFIX" "${@: -1}"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}
