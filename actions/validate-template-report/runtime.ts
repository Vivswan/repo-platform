// The slice of the repository's shared helpers this composite action needs,
// kept LOCAL on purpose: a composite action is published on the build
// branch and runs from its own directory, so it can import from
// actions/shared/ (the dependency-free zone shipped beside it) and from
// nothing else in the repository tree.

import { closeSync, openSync } from "node:fs";

export function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    error(`${name} must be set`);
    process.exit(2);
  }
  return value;
}

/** Workflow-command payloads escape newlines and carriage returns, or a
 *  multi-line message would terminate the command at the first break. */
function escapeData(message: string): string {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

export function warning(message: string): void {
  console.log(`::warning::${escapeData(message)}`);
}

export function error(message: string): void {
  console.log(`::error::${escapeData(message)}`);
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Hard deadline in milliseconds: on expiry the child is SIGKILLed and
   *  the result reports `timedOut`. REQUIRED, unlike the repository's
   *  shared proc.ts where it is optional. This action runs on a billed
   *  runner with a job timeout, and a `gh` call that hangs there burns
   *  the budget and then fails the job on the clock instead of on its
   *  own verdict. Making the deadline unskippable is what retires the
   *  grep that used to scan the rendered bash for a bare `gh api`. */
  timeoutMs: number;
}

export function capture(command: string[], options: RunOptions): RunResult {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    timedOut: proc.exitedDueToTimeout === true,
  };
}

/** One line saying why a captured child failed: the deadline, its first
 *  stderr line, or its exit code. */
export function failureDetail(result: RunResult): string {
  if (result.timedOut) return "timed out";
  const line = result.stderr
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim();
  return line || `exit ${result.exitCode}`;
}

/** capture() with stdout streamed to a file instead of a string: for
 *  binary payloads (a tarball) that a string round trip would corrupt. */
export function download(command: string[], toFile: string, options: RunOptions): RunResult {
  const fd = openSync(toFile, "w");
  try {
    const proc = Bun.spawnSync(command, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : undefined,
      stdout: fd,
      stderr: "pipe",
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
    });
    return {
      exitCode: proc.exitCode ?? 1,
      stdout: "",
      stderr: proc.stderr.toString(),
      timedOut: proc.exitedDueToTimeout === true,
    };
  } finally {
    closeSync(fd);
  }
}

/** How a child ended: a normal exit, a signal death, or our deadline (the
 *  SIGKILL is ours, so it is not reported as a signal). */
export type ChildExit =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: string }
  | { kind: "timed-out" };

/** A child whose output belongs in the job log as it happens (stdio
 *  inherited); only how it ended comes back. */
export function run(command: string[], options: RunOptions): ChildExit {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "inherit",
    stderr: "inherit",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) return { kind: "timed-out" };
  if (proc.exitCode !== null) return { kind: "exited", code: proc.exitCode };
  return { kind: "signaled", signal: proc.signalCode ?? "an unknown signal" };
}
