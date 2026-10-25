// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only. Annotations are the action's
// own @actions/core, which bun resolves upward from the importing file: from an action's directory into its
// node_modules, never from here. So nothing here annotates; a refusal throws, and the entry point annotates it.

export function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} must be set`);

  return value;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The deadline wins over the exit code: a child that exited 0 while an orphan held its pipe open still hit the deadline. */
export type ChildExit =
  | { kind: "exited"; code: number }
  | { kind: "signaled"; signal: string }
  | { kind: "timed-out" };

/** bun names the signal or, since 1.4.3's types, numbers it. */
export function childExit(proc: {
  exitedDueToTimeout?: boolean;
  exitCode: number | null;
  signalCode?: string | number | null;
}): ChildExit {
  if (proc.exitedDueToTimeout === true) return { kind: "timed-out" };

  if (proc.exitCode !== null) return { kind: "exited", code: proc.exitCode };

  return {
    kind: "signaled",
    signal: proc.signalCode == null ? "an unknown signal" : String(proc.signalCode),
  };
}

export function succeeded(exit: ChildExit): boolean {
  return exit.kind === "exited" && exit.code === 0;
}

export interface RunResult {
  exit: ChildExit;
  stdout: string;
  stderr: string;
}

/** `timeoutMs` is the hard deadline, REQUIRED: on expiry the child is SIGKILLed and the result reports `timed-out`.
 *  A `gh` call that hangs on a billed runner would otherwise fail the job on the clock, not on a verdict. */
export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
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

export function failureDetail(result: RunResult): string {
  if (result.exit.kind === "timed-out") return "timed out";

  if (result.exit.kind === "signaled") return `died on ${result.exit.signal}`;

  const line = result.stderr
    .split("\n")
    .find((l) => l.trim() !== "")
    ?.trim();
  return line || `exit ${result.exit.code}`;
}

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
