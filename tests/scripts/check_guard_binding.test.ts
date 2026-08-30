// The guard-binding layer's contract: every registry entry must resolve
// BOTH ways - snippet in the guard file, forcing test in the test file -
// and every detection branch must actually fire. The vanished-snippet
// test below is itself a registered forcing test (the registry's
// guard-binding-vanished-snippet-branch entry): the weekly arming audit
// neuters the branch in a scratch clone and requires that test red.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  entryBindingMismatches,
  registryBindingMismatches,
} from "../../scripts/check_guard_binding.ts";
import {
  applyMutation,
  countOccurrences,
  GUARD_REGISTRY,
  type GuardEntry,
} from "../../scripts/guard_registry.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const root = join(import.meta.dir, "../..");

function readOrNull(rel: string): string | null {
  try {
    return readFileSync(join(root, rel), "utf-8");
  } catch {
    return null;
  }
}

/** A synthetic entry the branch tests mutate one facet at a time. */
function entry(overrides: Partial<GuardEntry> = {}): GuardEntry {
  return {
    id: "synthetic",
    hazard: "a synthetic hazard",
    guardFile: "fake/guard.ts",
    snippet: "the guard token",
    mutated: "",
    testFile: "fake/guard.test.ts",
    testName: "the synthetic forcing test",
    ...overrides,
  };
}

const guardText = "before the guard token after";
const testText = 'test("the synthetic forcing test", () => {});';

describe("entryBindingMismatches", () => {
  test("a fully resolving entry reports nothing", () => {
    expect(entryBindingMismatches(entry(), guardText, testText)).toEqual([]);
  });

  test("an entry whose snippet vanished from its guard file is reported", () => {
    const problems = entryBindingMismatches(entry(), "no token here", testText);
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe("synthetic");
    expect(problems[0].problem).toContain("exactly once");
    expect(problems[0].problem).toContain("found 0");
  });

  test("an entry whose forcing test name vanished from its test file is reported", () => {
    const problems = entryBindingMismatches(entry(), guardText, 'test("some other test");');
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("the synthetic forcing test");
    expect(problems[0].problem).toContain("found 0");
  });

  test("an ambiguous snippet (present twice) is reported", () => {
    const problems = entryBindingMismatches(
      entry(),
      "the guard token and the guard token",
      testText,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("found 2");
    expect(problems[0].problem).toContain("ambiguous");
  });

  test("a duplicated test name is reported too - the audit's per-name verdict would be ambiguous", () => {
    const problems = entryBindingMismatches(entry(), guardText, `${testText}\n${testText}`);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("found 2");
  });

  test("a missing guard file is reported", () => {
    const problems = entryBindingMismatches(entry(), null, testText);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("fake/guard.ts");
    expect(problems[0].problem).toContain("missing");
  });

  test("a missing test file is reported", () => {
    const problems = entryBindingMismatches(entry(), guardText, null);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("fake/guard.test.ts");
    expect(problems[0].problem).toContain("missing");
  });

  test("a no-op mutation is reported", () => {
    const problems = entryBindingMismatches(
      entry({ mutated: "the guard token" }),
      guardText,
      testText,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("no-op");
  });
});

describe("registryBindingMismatches", () => {
  const files: Record<string, string> = {
    "fake/guard.ts": guardText,
    "fake/guard.test.ts": testText,
  };
  const readFake = (rel: string) => files[rel] ?? null;

  test("a resolving registry reports nothing", () => {
    expect(registryBindingMismatches([entry()], readFake)).toEqual([]);
  });

  test("an empty registry is itself a problem", () => {
    const problems = registryBindingMismatches([], readFake);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("empty");
  });

  test("a duplicate registry id is reported", () => {
    const problems = registryBindingMismatches([entry(), entry()], readFake);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("duplicate");
  });

  test("the landed registry resolves both ways against the real tree", () => {
    expect(registryBindingMismatches(GUARD_REGISTRY, readOrNull)).toEqual([]);
  });
});

describe("mutation primitives", () => {
  test("countOccurrences counts exact bytes and refuses an empty token", () => {
    expect(countOccurrences("aXbXc", "X")).toBe(2);
    expect(countOccurrences("abc", "X")).toBe(0);
    expect(() => countOccurrences("abc", "")).toThrow(/empty token/);
  });

  test("applyMutation rewrites exactly the declared snippet", () => {
    expect(applyMutation(guardText, entry({ mutated: "NOTHING" }))).toBe("before NOTHING after");
  });

  test("applyMutation refuses zero or multiple targets", () => {
    expect(() => applyMutation("no token here", entry())).toThrow(/appears 0 times/);
    expect(() => applyMutation("the guard token, the guard token", entry())).toThrow(
      /appears 2 times/,
    );
  });
});

describe("check_guard_binding CLI", () => {
  test("exits 0 on the landed tree and 2 on unrecognized arguments", () => {
    const green = boundedSpawnSync([process.execPath, "scripts/check_guard_binding.ts"], {
      cwd: root,
      timeoutMs: 30_000,
    });
    expect(green.exitCode).toBe(0);
    expect(green.stdout).toContain("resolve both ways");
    const usage = boundedSpawnSync(
      [process.execPath, "scripts/check_guard_binding.ts", "--bogus"],
      {
        cwd: root,
        timeoutMs: 30_000,
      },
    );
    expect(usage.exitCode).toBe(2);
  });
});
