// Bounded-by-default Bun.spawnSync for test suites. bun-test's per-test
// timeout cannot interrupt a synchronous spawn (the child blocks the
// runner), and on the pinned bun a piped spawnSync without `timeout`
// returns at pipe EOF, not child exit (proc.ts's header has the measured
// semantics) - so one wedged child hangs the whole run. Every spawn here
// carries a hard deadline and SIGKILL.
//
// This is deliberately NOT proc.ts's capture(): capture spreads live
// process.env under the call's entries (tests routinely pass hermetic or
// poisoned envs that the spread would disarm), and it folds a deadline
// expiry into a nonzero exit code, which an exit-code assertion could
// misread as the failure it was testing for. Here env passes through
// verbatim, and a timeout or signal death THROWS: "failed to look" is
// never a result a test can assert on.

export const SPAWN_TIMEOUT_MS = 15_000;

export interface BoundedSpawnOptions {
  cwd?: string;
  /** Passed through verbatim - absent keeps bun's default environment,
   * and no process.env spread is ever added (hermetic envs stay
   * hermetic). */
  env?: Record<string, string | undefined>;
  stdin?: Uint8Array | "ignore";
  /** Hard hang bound in milliseconds; absent = SPAWN_TIMEOUT_MS. A bound
   * on hanging, not an operational deadline - callers with slow children
   * (copier renders) pass a generous one. */
  timeoutMs?: number;
}

export interface BoundedSpawnResult {
  /** Never null: a timeout or signal death throws instead. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run argv with stdout/stderr captured and a hard deadline. Throws on a
 * deadline expiry (even when the child exited 0 and only a pipe holder
 * overran - exitedDueToTimeout covers both) and on a signal death, so
 * `exitCode` is always the child's own and assertions never read a
 * kill as a verdict. */
export function boundedSpawnSync(
  argv: string[],
  options: BoundedSpawnOptions = {},
): BoundedSpawnResult {
  const timeoutMs = options.timeoutMs ?? SPAWN_TIMEOUT_MS;
  // Guarded at the one mutation point because bun's spawnSync treats 0
  // and Infinity as NO bound, and the ssot scanner trusts the
  // `timeout: timeoutMs` identifier - a bad value here would pass the
  // gate while disarming it.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `boundedSpawnSync: timeoutMs must be a positive finite number, got ${timeoutMs}`,
    );
  }
  const proc = Bun.spawnSync(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true || proc.exitCode === null) {
    const cause =
      proc.exitedDueToTimeout === true
        ? `exceeded the ${timeoutMs}ms harness bound`
        : `died on signal ${proc.signalCode}`;
    throw new Error(
      `${argv.join(" ")} ${cause} - failed to look, not a result\n` +
        `${proc.stdout.toString()}${proc.stderr.toString()}`,
    );
  }
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}
