// Commands are argv arrays, never shell strings, so target-derived values cannot be re-parsed as syntax.
// Two bun >= 1.4.0 quirks shape every spawn here (the first unreported upstream as of 2026-08):
//
//   piped spawnSync, no `timeout`   -> returns at pipe EOF, not child exit; a descendant holding the pipe hangs the caller until it exits
//   piped spawnSync with `timeout`  -> returns by the deadline even with a descendant still holding the pipe, so every piped run carries one
//   the default child env           -> a snapshot from PROCESS START; a caller's process.env scrub never reaches the child unless passed explicitly
//   an undefined entry in `env`     -> deletes that key for the child

import { constants } from "node:os";

/** A bound on hanging, not an operational deadline: above every legitimate run (whole-tree pushes, validators, writer runs)
 * and inside the 10-minute job timeouts, so a wedged call dies named instead of as a runner-level kill. */
export const DEFAULT_HANG_BOUND_MS = 300_000;

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The child's pid, recorded so cleanup-sensitive callers can verify
   * the process is gone after the run. */
  pid: number;
}

/** For child output re-emitted to a public log: git quotes push URLs, userinfo included, back in its errors. */
export function redactText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]+@/gi, "$1***@")
    .replace(/x-access-token:[^/?#\s]+@/gi, "x-access-token:***@");
}

/** Sync argv carries the fleet PAT inside push URLs, and Actions logs are public. */
export function redactCommand(command: string[]): string {
  return command.map(redactText).join(" ");
}

/** Bash-style exit code: the command's own, or 128+signal when it was
 * killed (a signal-terminated child reports exitCode null). */
export function exitCodeOf(proc: { exitCode: number | null; signalCode?: string | null }): number {
  if (proc.exitCode !== null) return proc.exitCode;
  const signal = proc.signalCode
    ? (constants.signals as Record<string, number | undefined>)[proc.signalCode]
    : undefined;
  return signal !== undefined ? 128 + signal : 1;
}

/** 124 (timeout(1)'s convention) when the child had already exited 0: a piped run can hit the deadline waiting for pipe EOF
 * after a clean exit, and an expiry must never read as success. */
export function timeoutExitCode(proc: {
  exitCode: number | null;
  signalCode?: string | null;
}): number {
  const code = exitCodeOf(proc);
  return code === 0 ? 124 : code;
}

function spawnEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  return { ...process.env, ...(env ?? {}) };
}

/** Each call site still spells its spawn options as a literal: the spawn-sync-hang-bound ssot rule reads them structurally,
 * and a spread is opaque to it. */
function hangBound(options: RunOptions): number {
  return options.timeoutMs ?? DEFAULT_HANG_BOUND_MS;
}

export function capture(command: string[], options: RunOptions = {}): RunResult {
  const timeout = hangBound(options);
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: spawnEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  const timedOut = proc.exitedDueToTimeout === true;
  return {
    exitCode: timedOut ? timeoutExitCode(proc) : exitCodeOf(proc),
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    timedOut,
    pid: proc.pid,
  };
}

/** Inherited stdio has no pipe-EOF hazard, so no hang bound applies. */
export function passthrough(
  command: string[],
  options: Omit<RunOptions, "timeoutMs"> = {},
): number {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: spawnEnv(options.env),
    stdio: ["inherit", "inherit", "inherit"],
  });
  return exitCodeOf(proc);
}

export function must(command: string[], options: Omit<RunOptions, "timeoutMs"> = {}): void {
  const exitCode = passthrough(command, options);
  if (exitCode !== 0) process.exit(exitCode);
}

/** The deadline line is printed here because a SIGKILLed child usually dies without printing anything. */
export function mustCapture(command: string[], options: RunOptions = {}): string {
  const timeout = hangBound(options);
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: spawnEnv(options.env),
    stdout: "pipe",
    stderr: "inherit",
    timeout,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) {
    console.error(`command timed out after ${timeout}ms: ${redactCommand(command)}`);
    process.exit(timeoutExitCode(proc));
  }
  if (proc.exitCode !== 0) process.exit(exitCodeOf(proc));
  return proc.stdout.toString().replace(/\n+$/, "");
}
