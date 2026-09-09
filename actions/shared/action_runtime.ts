// The runtime slice the composite actions' bun scripts share: env reads,
// workflow-command prints, and deadline-bearing subprocess runners. Lives
// in the dependency-free zone because a composite action runs from its
// own directory on the build branch, where nothing else of the repository
// tree exists to import from.

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

/** An error annotation; `file` pins it to a path in the checkout. */
export function error(message: string, file?: string): void {
  const where = file === undefined ? "" : ` file=${escapeData(file)}`;
  console.log(`::error${where}::${escapeData(message)}`);
}

/** How a child ended. The deadline wins over the exit code: a child that
 *  exited 0 while an orphan held its pipe open still hit the deadline. */
export type ChildExit =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: string }
  | { kind: "timed-out" };

export function childExit(proc: {
  exitedDueToTimeout?: boolean;
  exitCode: number | null;
  signalCode?: string | null;
}): ChildExit {
  if (proc.exitedDueToTimeout === true) return { kind: "timed-out" };
  if (proc.exitCode !== null) return { kind: "exited", code: proc.exitCode };
  return { kind: "signaled", signal: proc.signalCode ?? "an unknown signal" };
}

export function succeeded(exit: ChildExit): boolean {
  return exit.kind === "exited" && exit.code === 0;
}

export interface RunResult {
  exit: ChildExit;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Hard deadline in milliseconds, REQUIRED: on expiry the child is
   *  SIGKILLed and the result reports `timed-out`. A `gh` call that hangs on
   *  a billed runner would otherwise fail the job on the clock, not on a verdict. */
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
  return { exit: childExit(proc), stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

/** One line saying why a captured child failed: the deadline, the signal,
 *  its first stderr line, or its exit code. */
export function failureDetail(result: RunResult): string {
  if (result.exit.kind === "timed-out") return "timed out";
  if (result.exit.kind === "signaled") return `died on ${result.exit.signal}`;
  const line = result.stderr
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim();
  return line || `exit ${result.exit.code}`;
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
    return { exit: childExit(proc), stdout: "", stderr: proc.stderr.toString() };
  } finally {
    closeSync(fd);
  }
}

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
  return childExit(proc);
}
