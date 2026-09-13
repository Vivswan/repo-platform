// A git yes/no question answers with exit 0 or its "no" exit (1, or 2 for ls-remote --exit-code); any other
// exit, or a deadline expiry, is an errored look, and the helpers throw instead of guessing. Every caller acts on a "no":
//   the stable tag mover       -> would push the tag backwards
//   the directives range read  -> would refuse a sound base as missing, or an ancestor as foreign

import { capture, type RunOptions, type RunResult } from "./proc.ts";

export interface YesNoOptions extends RunOptions {
  /** The exit code that means "no": 1 for most questions, 2 for ls-remote --exit-code. */
  noExit?: number;
}

/** A deadline expiry throws even beside an exit code: a child that left a descendant holding the pipe reports its own exit at the deadline.
 * Exported for the caller that needs the answer's stdout beside its exit (the stable tag mover reads the value ls-remote lists). */
export function answered(args: string[], options: YesNoOptions): RunResult {
  const probe = capture(["git", ...args], options);
  const no = options.noExit ?? 1;
  if (probe.timedOut || (probe.exitCode !== 0 && probe.exitCode !== no)) {
    const how = probe.timedOut ? "timed out" : `exit ${probe.exitCode}`;
    throw new Error(
      `git ${args[0]} could not answer (${how}); refusing to guess: ${probe.stderr.trim()}`,
    );
  }
  return probe;
}

export function gitAnswersYes(args: string[], options: YesNoOptions = {}): boolean {
  return answered(args, options).exitCode === 0;
}

/** The sha of the commit `revspec` names, "" when it names no commit. */
export function gitResolvedCommit(revspec: string, options: RunOptions = {}): string {
  const probe = answered(["rev-parse", "--verify", "--quiet", `${revspec}^{commit}`], options);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}
