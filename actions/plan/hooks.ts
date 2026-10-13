// The repo-owned hooks the managed ci.yml calls, and whether a call is due: a seeded hook carries the placeholder
// marker as its first line until the repository adds jobs, and the skeleton skips the call while it does (GitHub bills
// a private repository a full minute for the runner a no-op boots). Judged on the first line alone.

import { PLACEHOLDER_MARKER } from "../shared/platform.ts";

/** The hooks by the output name the skeleton reads, each at the path the sync seeds it. */
export const HOOKS = {
  "post-green": ".github/workflows/post-green.yml",
  "release-gate": ".github/workflows/release-gate.yml",
} as const;

export type Hook = keyof typeof HOOKS;

export const firstLineOf = (text: string): string => text.split(/\r?\n/, 1)[0] ?? "";

/** Whether the managed ci.yml calls the hook: not while the file is missing (`null`) or its first line is the
 *  placeholder marker. */
export function hookIsCalled(text: string | null): boolean {
  return text !== null && firstLineOf(text) !== PLACEHOLDER_MARKER;
}
