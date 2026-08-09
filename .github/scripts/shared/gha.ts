// GitHub Actions helpers shared by the workflow scripts: workflow commands
// (notice/error/mask), step outputs, and env reads. Workflow-command data
// must be single-line with %/CR/LF escaped, or the runner misparses the
// command and the raw value hits the log.

import { appendFileSync } from "node:fs";

export function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`::error::${name} must be set`);
    process.exit(2);
  }
  return value;
}

export function hideDetails(): boolean {
  return env("HIDE_DETAILS", "false") === "true";
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

/** Append a step output to $GITHUB_OUTPUT. */
export function setOutput(name: string, value: string): void {
  appendFileSync(requireEnv("GITHUB_OUTPUT"), `${name}=${value}\n`);
}
