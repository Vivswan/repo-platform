import { error } from "@actions/core";

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

export function fail(messages: string | string[]): never {
  for (const message of Array.isArray(messages) ? messages : [messages]) {
    error(message);
  }
  process.exit(1);
}
