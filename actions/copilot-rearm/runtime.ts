// The slice of the repository's shared helpers the composite actions
// need, kept LOCAL on purpose. Actions are published on the `actions`
// branch - their own extraction-safe delivery channel, never the composed
// template tree, whose jinja-expression filenames would kill the runner's
// tarball extraction - and each runs from its own directory, so it cannot
// import out of the repository tree: not from .github/scripts/shared/,
// and not from a sibling action either. That is a property of how actions
// are published, not drift: each PREDICATE exists exactly once (the
// gate's in gate.ts, the re-armer's in rerun.ts), and every caller uses
// the action rather than keeping a second copy of it.
//
// Byte-identical copies of this file live in each composite action that
// needs it, and copilot_shared_files.test.ts fails if any copy diverges -
// the same guard identity.ts carries. Edit one, copy it to the others.
//
// Keep these behaviour-compatible with .github/scripts/shared/ - they are
// the same functions, narrowed to what the actions use.

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
  timedOut?: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Hard deadline in milliseconds: on expiry the child is SIGKILLed and
   *  the result reports `timedOut`. Absent = unbounded. */
  timeoutMs?: number;
}

export function capture(command: string[], options: RunOptions = {}): RunResult {
  const proc = Bun.spawnSync(command, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
    ...(options.timeoutMs !== undefined
      ? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const }
      : {}),
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    ...(options.timeoutMs !== undefined ? { timedOut: proc.exitedDueToTimeout === true } : {}),
  };
}

/** Parses JSON and validates it in one step. A response the schema rejects
 *  is a contract problem no re-run fixes, so it exits rather than handing
 *  back a value every caller would have to re-check. Diagnostics name
 *  paths and issue codes only - never received values or JSON.parse's own
 *  exception text, which echo fragments of the external response into
 *  public CI logs (the value-free discipline of
 *  .github/scripts/shared/json.ts). */
export function parseJsonWith<T>(schema: ZodType<T>, text: string, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    error(`${label}: not valid JSON`);
    process.exit(1);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    error(`${label}: unexpected shape - ${detail}`);
    process.exit(1);
  }
  return result.data;
}
