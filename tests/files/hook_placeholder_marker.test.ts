// The two seeded hooks and the plan agree on one first line: the plan skips a call on the marker, so a template that
// lost it (a reworded header, a reordered comment) would bill every newly seeded repository the no-op minute again,
// green; and a marker respelled in the plan alone would stop matching every seed already in the fleet, so the no-op
// call would resume there.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { firstLineOf, HOOKS, hookIsCalled } from "../../actions/plan/hooks.ts";
import { PLACEHOLDER_MARKER } from "../../actions/shared/platform.ts";

const TEMPLATES = join(import.meta.dir, "../../files/base");

describe("the seeded hooks' first line", () => {
  test.each(Object.entries(HOOKS))(
    "%s: the template opens with the marker and is not called",
    (_, path) => {
      const text = readFileSync(join(TEMPLATES, path), "utf-8");
      expect(firstLineOf(text)).toBe(PLACEHOLDER_MARKER);
      expect(hookIsCalled(text)).toBe(false);
      // The negative control: the same template with its first line deleted, as the owner is told to do, is called.
      expect(hookIsCalled(text.slice(text.indexOf("\n") + 1))).toBe(true);
    },
  );

  // The read is the skeleton's contract with a repository that edits its hook by hand: the marker counts on line 1
  // alone, so a header a maintainer adds above it, or no file at all, decides the call.
  test.each<{ reason: string; text: string | null; called: boolean }>([
    { reason: "no file", text: null, called: false },
    { reason: "the marker on line 1", text: `${PLACEHOLDER_MARKER}\nname: x\n`, called: false },
    { reason: "the marker on line 2", text: `# a comment\n${PLACEHOLDER_MARKER}\n`, called: true },
    { reason: "no marker", text: "name: x\n", called: true },
  ])("$reason -> called: $called", ({ text, called }) => {
    expect(hookIsCalled(text)).toBe(called);
  });
});
