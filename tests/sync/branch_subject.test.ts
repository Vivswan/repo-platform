// The branch-mode commit subject over every selection delta, plus the
// default-mode subject it falls back to.

import { describe, expect, test } from "bun:test";
import { branchSubject, syncSubject } from "../../.github/scripts/sync/branch_subject.ts";

const DISPLAY = "build@0123456789ab";

describe("branchSubject", () => {
  test.each<{ reason: string; base: string[] | null; branch: string[]; expected: string }>([
    {
      reason: "one module added",
      base: ["uv"],
      branch: ["uv", "fuzzer"],
      expected: "chore: render the fuzzer module",
    },
    {
      reason: "two modules added",
      base: ["uv"],
      branch: ["uv", "fuzzer", "nightly"],
      expected: "chore: render the fuzzer and nightly modules",
    },
    {
      reason: "three modules added",
      base: [],
      branch: ["a", "b", "c"],
      expected: "chore: render the a, b and c modules",
    },
    {
      reason: "one module removed",
      base: ["uv", "pages"],
      branch: ["uv"],
      expected: "chore: remove the pages module render",
    },
    {
      reason: "added and removed",
      base: ["uv", "pages"],
      branch: ["uv", "fuzzer"],
      expected: "chore: render the module selection (+fuzzer, -pages)",
    },
    {
      reason: "an unchanged selection (an answers-only edit) is the ordinary sync subject",
      base: ["uv"],
      branch: ["uv"],
      expected: syncSubject(DISPLAY),
    },
    {
      reason: "a reordered selection is unchanged",
      base: ["uv", "bun"],
      branch: ["bun", "uv"],
      expected: syncSubject(DISPLAY),
    },
    {
      reason: "no readable default-branch selection falls back to the sync subject",
      base: null,
      branch: ["uv", "fuzzer"],
      expected: syncSubject(DISPLAY),
    },
  ])("$reason", ({ base, branch, expected }) => {
    expect(branchSubject(base, branch, DISPLAY)).toBe(expected);
  });

  test("the sync subject names the delivered build", () => {
    expect(syncSubject(DISPLAY)).toBe("chore: update repo-platform template to build@0123456789ab");
  });
});
