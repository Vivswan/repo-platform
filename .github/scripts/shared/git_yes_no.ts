// A git yes/no question (merge-base --is-ancestor, rev-parse --verify) answers with exit 0 or
// 1; any other exit, or a deadline expiry, is an errored look. The callers act on a "no" (the
// stable tag mover would push the tag backwards, the directives range read would take its
// fallback base over a live build branch), so an error must never pass for one: the helper
// throws instead of guessing.

import { capture, type RunOptions } from "./proc.ts";

/** Whether `git ...args` answered yes (exit 0). A no is exit 1; anything else throws, and so
 *  does a deadline expiry even beside an exit code (a child that left a descendant holding the
 *  pipe reports its own exit at the deadline). */
export function gitAnswersYes(args: string[], options: RunOptions = {}): boolean {
  const probe = capture(["git", ...args], options);
  if (probe.timedOut || (probe.exitCode !== 0 && probe.exitCode !== 1)) {
    const how = probe.timedOut ? "timed out" : `exit ${probe.exitCode}`;
    throw new Error(
      `git ${args[0]} could not answer (${how}); refusing to guess: ${probe.stderr.trim()}`,
    );
  }
  return probe.exitCode === 0;
}
