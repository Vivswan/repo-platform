#!/usr/bin/env bun
// The seeded hooks post-green.yml and release-gate.yml now open with the placeholder marker the plan reads to skip the
// call, and a starter is never resynced, so this rung prepends it to the fleet's hooks that are still the seed. Those
// differ only in their header comment, so the compare is the text below that block against the seed body kept here.
// stdout is the runner's (sync/migrate.ts): each hook path written, nothing otherwise.
//
// Usage: bun migrations/0004-hook-placeholder-marker.ts <checkout>

import { probe, writeFile } from "../.github/scripts/sync/writer/target_files.ts";
import { firstLineOf, HOOKS, type Hook } from "../actions/plan/hooks.ts";
import { PLACEHOLDER_MARKER } from "../actions/shared/platform.ts";

const RUNG = "0004-hook-placeholder-marker";

/** The seed below its header comment, as every sync since the hooks were introduced wrote it. */
export const SEED_BODIES: Record<Hook, string> = {
  "post-green": [
    "name: Post Green",
    "",
    "on:",
    "  workflow_call:",
    "    inputs:",
    "      sha:",
    "        description: The green main commit the calling run judged.",
    "        required: true",
    "        type: string",
    "",
    "jobs:",
    "  noop:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    steps:",
    "      - env:",
    "          SHA: ${{ inputs.sha }}",
    '        run: echo "post-green hook for $SHA - nothing configured"',
    "",
  ].join("\n"),
  "release-gate": [
    "name: Release Gate",
    "",
    "on:",
    "  workflow_call:",
    "",
    "jobs:",
    "  noop:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 5",
    "    steps:",
    '      - run: echo "release-gate hook - nothing configured"',
    "",
  ].join("\n"),
};

/** The text below the leading block of comment and blank lines. */
export function belowHeader(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => !(line.startsWith("#") || line.trim() === ""));
  return first === -1 ? "" : lines.slice(first).join("\n");
}

/** The marked text when the hook is still the seed, null when it already carries the marker or is the repository's own. */
export function marked(hook: Hook, text: string): string | null {
  if (firstLineOf(text) === PLACEHOLDER_MARKER) return null;
  if (belowHeader(text) !== SEED_BODIES[hook]) return null;
  return `${PLACEHOLDER_MARKER}\n${text}`;
}

/** A link at the hook's own path is left for the writer; anything else that is not a file, or cannot be read, fails
 *  the row through probe's own error. */
function main(checkout: string | undefined): number {
  if (checkout === undefined) {
    console.error(`usage: bun migrations/${RUNG}.ts <checkout>`);
    return 2;
  }
  try {
    for (const [hook, relative] of Object.entries(HOOKS) as [Hook, string][]) {
      const found = probe(checkout, relative);
      if (found.kind !== "file") continue;
      const text = marked(hook, found.bytes.toString("utf-8"));
      if (text === null) continue;
      writeFile(checkout, relative, Buffer.from(text, "utf-8"));
      console.log(relative);
    }
  } catch (error) {
    console.error(`${RUNG}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(main(process.argv[2]));
