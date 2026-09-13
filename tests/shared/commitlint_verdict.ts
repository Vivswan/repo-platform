// commitlint's report is read as its problem list, never as the whole text: the leading symbols are not ASCII, and
// the surrounding lines (the echoed input, the count, the help link) are the formatter's, not the verdict's.

import type { BoundedSpawnResult } from "./bounded_spawn.ts";

export const ONE_SCOPE =
  "one scope per subject, spelled [A-Za-z0-9._/-]: split the change or pick the scope that names it [scope-one]";
export const SUBJECT_CASE =
  "subject must not be sentence-case, start-case, pascal-case, upper-case [subject-case]";
export const TYPE_ENUM =
  "type must be one of [build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test] [type-enum]";

export interface Verdict {
  exitCode: number;
  stderr: string;
  problems: string[];
}

/** Each problem or warning line without its symbol: `subject may not be empty [subject-empty]`. */
export function problems(stdout: string): string[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^[^\x20-\x7e]\s+(.+ \[[a-z-]+\])$/.exec(line);
    return match === null ? [] : [match[1]];
  });
}

export function verdict(result: BoundedSpawnResult): Verdict {
  return { exitCode: result.exitCode, stderr: result.stderr, problems: problems(result.stdout) };
}
