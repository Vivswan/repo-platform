// A git yes/no question answers with exit 0 or its "no" exit (1, or 2 for ls-remote --exit-code); any other
// exit, or a deadline expiry, is an errored look, and the helpers throw instead of guessing. Every caller acts on a "no":
//   the stable tag mover       -> would push the tag backwards
//   the directives range read  -> would refuse a sound base as missing, or an ancestor as foreign
//   the newest-main read       -> would let a superseded run write, or stand the newest run down

import { capture, type RunOptions, type RunResult } from "./proc.ts";

interface YesNoOptions extends RunOptions {
  /** The exit code that means "no": 1 for most questions, 2 for ls-remote --exit-code. */
  noExit?: number;
}

/** A deadline expiry throws even beside an exit code: a child that left a descendant holding the pipe reports its own exit at the deadline. */
function answered(args: string[], options: YesNoOptions): RunResult {
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

export function gitAnswersYes(args: string[], options: RunOptions = {}): boolean {
  return answered(args, options).exitCode === 0;
}

/** The sha of the commit `revspec` names, "" when it names no commit. */
export function gitResolvedCommit(revspec: string, options: RunOptions = {}): string {
  const probe = answered(["rev-parse", "--verify", "--quiet", `${revspec}^{commit}`], options);
  return probe.exitCode === 0 ? probe.stdout.trimEnd() : "";
}

/** The sha `remote` holds for `ref` (an annotated tag's own object, not the commit it names), "" when it holds no such ref.
 * A listing without a full sha on the ref's line is an errored look too: the remote never abbreviates, so a short one is garbage. */
export function gitRemoteRef(remote: string, ref: string, options: RunOptions = {}): string {
  const probe = answered(["ls-remote", "--exit-code", remote, ref], { ...options, noExit: 2 });
  if (probe.exitCode === 2) return "";
  const line = probe.stdout.split("\n").find((entry) => entry.endsWith(`\t${ref}`));
  const sha = line === undefined ? "" : line.slice(0, line.indexOf("\t"));
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`git ls-remote listed no ${ref} line:\n${probe.stdout}`);
  }
  return sha;
}
