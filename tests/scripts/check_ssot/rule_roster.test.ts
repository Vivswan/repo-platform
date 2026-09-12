import { describe, expect, test } from "bun:test";
import { RULE_ROSTER, ruleRosterMismatches } from "../../../scripts/check/ssot/rule_roster.ts";

describe("ruleRosterMismatches", () => {
  test("a matching roster and rule list pass", () => {
    expect(ruleRosterMismatches(["a", "b"], ["a", "b"])).toEqual([]);
    expect(ruleRosterMismatches(["b", "a"], ["a", "b"])).toEqual([]);
  });

  test("a live rule missing from the roster mismatches, naming the roster edit", () => {
    const mismatches = ruleRosterMismatches(["a"], ["a", "b"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].expected).toContain("'b'");
    expect(mismatches[0].expected).toContain("RULE_ROSTER");
  });

  test("a DROPPED rule still rostered mismatches - the silent case the roster exists for", () => {
    // The run loop counts whatever the rules array holds, so losing a
    // rule changes nothing it can see; the stale roster entry is what
    // makes the drop loud.
    const mismatches = ruleRosterMismatches(["a", "b"], ["a"]);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].file).toContain("RULE_ROSTER");
    expect(mismatches[0].expected).toContain("'b'");
    expect(mismatches[0].got).toContain("no such rule");
  });

  test("a duplicate on either side mismatches", () => {
    const doubledRoster = ruleRosterMismatches(["a", "a"], ["a"]);
    expect(doubledRoster).toHaveLength(1);
    expect(doubledRoster[0].file).toContain("RULE_ROSTER");
    const doubledRule = ruleRosterMismatches(["a"], ["a", "a"]);
    expect(doubledRule).toHaveLength(1);
    expect(doubledRule[0].got).toContain("'a'");
  });

  test("the authored RULE_ROSTER itself carries no duplicates", () => {
    expect(new Set(RULE_ROSTER).size).toBe(RULE_ROSTER.length);
  });
});
