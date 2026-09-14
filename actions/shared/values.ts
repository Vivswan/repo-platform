// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { createHash } from "node:crypto";

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
