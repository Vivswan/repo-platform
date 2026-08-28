// Subprocess helpers shared by the workflow scripts. Commands are argv
// arrays (never shell strings), so target-derived values cannot be
// re-parsed as syntax.
//
// Every piped run carries a timeout, defaulted to DEFAULT_HANG_BOUND_MS,
// because of a bun >= 1.4.0 semantic the code cannot otherwise show: a
// piped Bun.spawnSync WITHOUT `timeout` returns at pipe EOF (all writer
// fds closed), not at child exit, so a child that exits after leaving a
// descendant holding the inherited pipe fds blocks the caller until that
// descendant exits - potentially forever. WITH `timeout` set, spawnSync
// returns at the deadline regardless of surviving pipe holders, so a
// universal ceiling converts an unbounded silent hang into a loud,
// bounded failure. As of 2026-08 this change is unreported upstream.

import { constants } from "node:os";

/** The default hang bound: a BOUND ON HANGING, not an operational
 * deadline. Generous enough that no legitimate subprocess ever hits it
 * (whole-tree pushes, validators, copier renders all run well under it),
 * small enough to fire with room to spare inside the 10-minute job
 * timeouts, so a wedged call dies loudly and named instead of as a
 * runner-level kill. Call sites with a real operational deadline pass
 * their own `timeoutMs`, which always wins. */
export const DEFAULT_HANG_BOUND_MS = 300_000;

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Hard deadline in milliseconds: on expiry the child is SIGKILLed and
   * the result reports `timedOut`. Absent = DEFAULT_HANG_BOUND_MS. */
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the run was cut off by the deadline (the explicit
   * `timeoutMs` or the default hang bound); `exitCode` is then always
   * nonzero. */
  timedOut: boolean;
}

/** Text with credentials redacted - URL userinfo (`scheme://user:pass@` ->
 * `scheme://***@`) and the bare `x-access-token:<token>@` shape - for any
 * child output re-emitted to a public log: git quotes push URLs back. */
export function redactText(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]+@/gi, "$1***@")
    .replace(/x-access-token:[^/?#\s]+@/gi, "x-access-token:***@");
}

/** Argv rendered for a log line, each argument redacted like redactText:
 * sync argv carries the fleet PAT inside push URLs, and Actions logs are
 * public. */
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

/** Exit code for a run cut off by its deadline: the signal code when the
 * child was killed still running, and 124 (the timeout(1) convention)
 * when the child had already exited 0 - under bun >= 1.4.0 a piped run
 * can hit the deadline waiting for pipe EOF after a clean child exit,
 * and a deadline expiry must never read as success. */
export function timeoutExitCode(proc: {
  exitCode: number | null;
  signalCode?: string | null;
}): number {
  const code = exitCodeOf(proc);
  return code === 0 ? 124 : code;
}

/** Run with stdout/stderr captured. */
export function capture(command: string[], options: RunOptions = {}): RunResult {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANG_BOUND_MS;
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const timedOut = proc.exitedDueToTimeout === true;
  return {
    exitCode: timedOut ? timeoutExitCode(proc) : exitCodeOf(proc),
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    timedOut,
  };
}

/** Run with inherited stdio; returns the exit code. Inherited stdio has
 * no pipe-EOF hazard, so no hang bound applies (and `timeoutMs` is not
 * accepted). */
export function passthrough(
  command: string[],
  options: Omit<RunOptions, "timeoutMs"> = {},
): number {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return exitCodeOf(proc);
}

/** Run with inherited stdio; exits the process with the command's code on
 * failure. */
export function must(command: string[], options: Omit<RunOptions, "timeoutMs"> = {}): void {
  const exitCode = passthrough(command, options);
  if (exitCode !== 0) process.exit(exitCode);
}

/** Run with stdout captured and stderr inherited; exits the process with
 * the command's code on failure. Returns stdout with trailing newlines
 * stripped (command-substitution semantics). A deadline expiry is a
 * failure like any other, except a line naming the deadline precedes the
 * exit - a SIGKILLed child usually dies without printing anything. */
export function mustCapture(command: string[], options: RunOptions = {}): string {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HANG_BOUND_MS;
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "inherit",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) {
    console.error(`command timed out after ${timeoutMs}ms: ${redactCommand(command)}`);
    process.exit(timeoutExitCode(proc));
  }
  if (proc.exitCode !== 0) process.exit(exitCodeOf(proc));
  return proc.stdout.toString().replace(/\n+$/, "");
}
