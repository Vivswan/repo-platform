// GitHub Actions helpers shared by the workflow scripts: workflow commands
// (notice/error/mask), step outputs, and env reads. Workflow-command data
// must be single-line with %/CR/LF escaped, or the runner misparses the
// command and the raw value hits the log.

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

/** Print each message as an ::error:: workflow command and exit 1. On
 * stdout, like error(): the runner parses workflow commands from stdout
 * only, so a stderr copy shows in the log but never becomes an
 * annotation. */
export function fail(messages: string | string[]): never {
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    error(message);
  }
  process.exit(1);
}

/** Append a step output to $GITHUB_OUTPUT; a value with a newline takes
 *  the runner's heredoc form. */
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
