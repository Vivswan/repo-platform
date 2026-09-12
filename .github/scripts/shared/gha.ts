import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

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

/** Workflow-command data must have %, CR, and LF escaped, or the runner misparses the command and
 * the raw value hits the log. */
export function escapeData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
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

export function addMask(value: string): void {
  console.log(`::add-mask::${escapeData(value)}`);
}

export function fail(messages: string | string[]): never {
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    error(message);
  }
  process.exit(1);
}

export function setOutput(name: string, value: string): void {
  if (!value.includes("\n")) {
    appendFileSync(requireEnv("GITHUB_OUTPUT"), `${name}=${value}\n`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  if (value.includes(delimiter))
    throw new Error(`setOutput(${name}): the value carries the delimiter`);
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
