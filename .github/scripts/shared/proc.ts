// Subprocess helpers shared by the workflow scripts. Commands are argv
// arrays (never shell strings), so target-derived values cannot be
// re-parsed as syntax.

import { constants } from "node:os";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Hard deadline in milliseconds: on expiry the child is SIGKILLed and
   * the result reports `timedOut`. Absent = today's unbounded behavior. */
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the child was killed by `timeoutMs` expiring. */
  timedOut?: boolean;
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

/** Run with stdout/stderr captured. */
export function capture(command: string[], options: RunOptions = {}): RunResult {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
    ...(options.timeoutMs !== undefined
      ? { timeout: options.timeoutMs, killSignal: "SIGKILL" }
      : {}),
  });
  return {
    exitCode: exitCodeOf(proc),
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    ...(options.timeoutMs !== undefined ? { timedOut: proc.exitedDueToTimeout === true } : {}),
  };
}

/** Run with inherited stdio; returns the exit code. */
export function passthrough(command: string[], options: RunOptions = {}): number {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return exitCodeOf(proc);
}

/** Run with inherited stdio; exits the process with the command's code on
 * failure. */
export function must(command: string[], options: RunOptions = {}): void {
  const exitCode = passthrough(command, options);
  if (exitCode !== 0) process.exit(exitCode);
}

/** Run with stdout captured and stderr inherited; exits the process with
 * the command's code on failure. Returns stdout with trailing newlines
 * stripped (command-substitution semantics). A `timeoutMs` expiry is a
 * failure like any other, except a line naming the deadline precedes the
 * exit - a SIGKILLed child usually dies without printing anything. */
export function mustCapture(command: string[], options: RunOptions = {}): string {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "inherit",
    ...(options.timeoutMs !== undefined
      ? { timeout: options.timeoutMs, killSignal: "SIGKILL" }
      : {}),
  });
  if (proc.exitedDueToTimeout === true) {
    console.error(`command timed out after ${options.timeoutMs}ms: ${command.join(" ")}`);
    process.exit(exitCodeOf(proc));
  }
  if (proc.exitCode !== 0) process.exit(exitCodeOf(proc));
  return proc.stdout.toString().replace(/\n+$/, "");
}
