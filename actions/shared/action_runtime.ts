// Dependency-free on purpose: a composite action runs from its own directory at the delivery commit,
// where only its own pinned dependencies are installed.

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

/** A property value escapes the separators too. */
function escapeProperty(value: string): string {
  return escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/** The command line as GitHub reads it, for a caller that prints it where it wants (stderr, a captured line). */
export function workflowCommand(
  kind: "notice" | "warning" | "error",
  message: string,
  file?: string,
  line?: number,
): string {
  const properties = [
    ...(file === undefined ? [] : [`file=${escapeProperty(file)}`]),
    ...(line === undefined ? [] : [`line=${line}`]),
  ];
  const where = properties.length === 0 ? "" : ` ${properties.join(",")}`;
  return `::${kind}${where}::${escapeData(message)}`;
}

export function notice(message: string): void {
  console.log(workflowCommand("notice", message));
}

export function warning(message: string): void {
  console.log(workflowCommand("warning", message));
}

export function error(message: string, file?: string, line?: number): void {
  console.log(workflowCommand("error", message, file, line));
}

/** The deadline wins over the exit code: a child that exited 0 while an orphan held its pipe open still hit the deadline. */
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
