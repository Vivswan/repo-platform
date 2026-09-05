// The slice of the repository's shared helpers this composite action needs,
// kept LOCAL on purpose. A composite action is published on a build output
// branch of this repository and runs from its own directory, so it cannot
// import out of the repository tree - not from .github/scripts/shared/,
// and not from a sibling action either (actions/shared/, the dependency-free
// zone the branch ships beside every action, is the one importable
// neighbour). That is a property of how actions are published, not drift:
// the predicates themselves (freshness.ts, report.ts) exist exactly once,
// and callers use the action rather than keeping a second copy of them.
//
// This is currently the only action carrying this file (the Copilot
// actions that shared it byte-identically were retired with the
// ruleset-owned review gate). If another composite action ever copies it,
// bring back the byte-equality test that policed the copies: edit one,
// copy it to the others, never re-type.
//
// Keep these behaviour-compatible with .github/scripts/shared/ - they are
// the same functions, narrowed to what the action uses.

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

export function notice(message: string): void {
  console.log(`::notice::${escapeData(message)}`);
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

/** A child whose output belongs in the job log as it happens (stdio
 *  inherited); only the exit code comes back. */
export function run(command: string[], options: RunOptions): number {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "inherit",
    stderr: "inherit",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });
  return proc.exitCode ?? 1;
}
