// The slice of the repository's shared helpers the two Copilot actions
// need, kept LOCAL on purpose. A composite action is copied to the template
// branch and runs from its own directory, so it cannot import out of the
// repository tree - not from .github/scripts/shared/, and not from the
// sibling action either. That is a property of how actions are published,
// not drift: each PREDICATE exists exactly once (gate.ts here, rerun.ts in
// copilot-rearm), and both callers use the action rather than keeping a
// second copy of it.
//
// This file is therefore BYTE-IDENTICAL to actions/copilot-rearm/runtime.ts,
// and copilot_shared_files.test.ts fails if the two ever diverge - the same
// guard identity.ts carries. Edit one, copy it to the other.
//
// Keep these behaviour-compatible with .github/scripts/shared/ - they are
// the same functions, narrowed to what the two actions use.

import type { ZodType } from "zod";

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
   *  shared proc.ts where it is optional. Both of these actions run on a
   *  billed runner with a job timeout, and a `gh` call that hangs there
   *  burns the budget and then fails the job on the clock instead of on
   *  its own verdict - the gate would look broken and the re-armer would
   *  strand a red gate. Making the deadline unskippable is what retires
   *  the grep that used to scan the rendered bash for a bare `gh api`. */
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

/** Parses JSON and validates it in one step. A response the schema rejects
 *  is a contract problem no re-run fixes, so it exits rather than handing
 *  back a value every caller would have to re-check. */
export function parseJsonWith<T>(schema: ZodType<T>, text: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    error(`${label}: response is not JSON (${cause instanceof Error ? cause.message : cause})`);
    process.exit(1);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")} ${issue.message}`)
      .join("; ");
    error(`${label}: ${detail}`);
    process.exit(1);
  }
  return result.data;
}
