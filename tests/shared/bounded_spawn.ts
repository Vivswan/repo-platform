// bun-test's per-test timeout cannot interrupt a synchronous spawn, so one wedged child hangs the
// whole run. Deliberately not proc.ts's capture().
//   piped spawnSync without `timeout` on the pinned bun -> returns at pipe EOF, not child exit (proc.ts's header has the measured semantics)
//   capture() spreads live process.env                  -> disarms the hermetic and poisoned envs tests pass
//   capture() folds a deadline expiry into an exit code -> an exit-code assertion could misread it as the failure under test

export const SPAWN_TIMEOUT_MS = 15_000;

export interface BoundedSpawnOptions {
  cwd?: string;
  /** Verbatim, no process.env spread (hermetic envs stay hermetic); absent is
   * bun's own default, a snapshot of the environment at process start. */
  env?: Record<string, string | undefined>;
  stdin?: Uint8Array | "ignore";
  /** A bound on hanging, not an operational deadline: callers with slow
   * children (whole-tree writer runs) pass a generous one. */
  timeoutMs?: number;
}

export interface BoundedSpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A deadline expiry or signal death throws instead of returning, so `exitCode`
 * is always the child's own and "failed to look" is never a result a test can
 * assert on. exitedDueToTimeout is set even when the child exited 0 and only a
 * pipe holder overran. */
export function boundedSpawnSync(
  argv: string[],
  options: BoundedSpawnOptions = {},
): BoundedSpawnResult {
  const timeoutMs = options.timeoutMs ?? SPAWN_TIMEOUT_MS;
  // Guarded at the one mutation point because bun's spawnSync treats 0
  // and Infinity as NO bound, and the ssot scanner (scripts/check/ssot/process_discipline.ts)
  // trusts the `timeout: timeoutMs` identifier - a bad value here would pass
  // the gate while disarming it.
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
