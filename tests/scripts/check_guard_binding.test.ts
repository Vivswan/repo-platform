// The guard-binding layer's contract: every registry entry must resolve
// BOTH ways - snippet in the guard file, forcing test in the test file -
// and every detection branch must actually fire. The vanished-snippet
// test below is itself a registered forcing test (the registry's
// guard-binding-vanished-snippet-branch entry): the weekly arming audit
// neuters the branch in a scratch clone and requires that test red.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deletionTripwire,
  entryBindingMismatches,
  extractRegistryIds,
  registryBindingMismatches,
  registryDeletionMismatches,
  retiredGuardMismatches,
} from "../../scripts/check_guard_binding.ts";
import {
  applyMutation,
  countOccurrences,
  GUARD_REGISTRY,
  type GuardEntry,
  RETIRED_GUARDS,
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

// The deletion tripwire's judgment: every id the merge-base registry
// carried must be live at HEAD or explicitly retired. The missing-id
// test below is itself a registered forcing test (the registry's
// guard-registry-deletion-tripwire entry): the weekly arming audit
// neuters the missing-id branch in a scratch clone and requires it red.
describe("registryDeletionMismatches", () => {
  const live = new Set(["kept"]);

  test("a merge-base registry id missing at HEAD without a RETIRED_GUARDS entry is reported", () => {
    const problems = registryDeletionMismatches(["kept", "dropped"], live, new Set());
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe("dropped");
    expect(problems[0].problem).toContain("GONE at HEAD");
    expect(problems[0].problem).toContain("RETIRED_GUARDS");
  });

  test("a retired id passes - the removal is acknowledged, not silent", () => {
    const retired = new Set(["dropped"]);
    expect(registryDeletionMismatches(["kept", "dropped"], live, retired)).toEqual([]);
  });

  test("an uncut registry reports nothing (additions at HEAD are free)", () => {
    expect(registryDeletionMismatches(["kept"], live, new Set())).toEqual([]);
  });
});

describe("retiredGuardMismatches", () => {
  const retired = (id: string, reason = "retired with its machinery") => ({ id, reason });

  test("a clean retirement reports nothing", () => {
    expect(retiredGuardMismatches([entry()], [retired("gone")])).toEqual([]);
  });

  test("an id both live and retired is a contradiction", () => {
    const problems = retiredGuardMismatches([entry({ id: "gone" })], [retired("gone")]);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("still live");
  });

  test("a duplicate retirement record is reported", () => {
    const problems = retiredGuardMismatches([], [retired("gone"), retired("gone")]);
    expect(problems).toHaveLength(1);
    expect(problems[0].problem).toContain("duplicate");
  });

  test("a blank or multi-line reason is reported", () => {
    for (const reason of ["  ", "line one\nline two", "line one\rline two"]) {
      const problems = retiredGuardMismatches([], [retired("gone", reason)]);
      expect(problems).toHaveLength(1);
      expect(problems[0].problem).toContain("one-line reason");
    }
  });

  test("the landed RETIRED_GUARDS list is clean", () => {
    expect(retiredGuardMismatches(GUARD_REGISTRY, RETIRED_GUARDS)).toEqual([]);
  });
});

describe("extractRegistryIds", () => {
  test("reads ids from the entry shape and the inline retirement shape, nothing else", () => {
    const source = [
      "export const GUARD_REGISTRY = [",
      "  {",
      '    id: "multi-line-entry",',
      '    hazard: "a hazard",',
      '    testName: "not an id",',
      "  },",
      "];",
      "export const RETIRED_GUARDS = [",
      '  { id: "inline-retired", reason: "retired with its machinery" },',
      "];",
    ].join("\n");
    expect(extractRegistryIds(source)).toEqual(["multi-line-entry", "inline-retired"]);
  });

  test("tracks the landed registry file's format: extraction matches the imported ids", () => {
    const source = readOrNull("scripts/guard_registry.ts");
    expect(source).not.toBeNull();
    const expected = [
      ...GUARD_REGISTRY.map((guard) => guard.id),
      ...RETIRED_GUARDS.map((record) => record.id),
    ].sort();
    expect([...extractRegistryIds(source ?? "")].sort()).toEqual(expected);
  });
});

// End-to-end negative control for the tripwire's git plumbing: the pure
// judgment above cannot notice the merge-base/show path rotting, so
// these force a real RED, a real GREEN, and a real fail-open through the
// same plumbing main() runs - in scratch repos, never this one. main()'s
// own three forwarding lines stay review-covered: a CLI-level red would
// need mutating this real repo's registry.
describe("deletionTripwire (real git plumbing)", () => {
  const scratchDirs: string[] = [];
  afterAll(() => {
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  });

  // Hermetic env for the scratch SETUP (stage_tree.test.ts's pattern):
  // GIT_* scrubbed (hook-driven runs export GIT_DIR, which would redirect
  // the fixture git at this repo), config scopes and XDG pinned empty so
  // a machine-global hook, template, or signing rule cannot false-red
  // the fixture commits - the arming audit runs this whole file.
  const fixtures = mkdtempSync(join(tmpdir(), "guard-tripwire-env-"));
  scratchDirs.push(fixtures);
  writeFileSync(join(fixtures, "empty-gitconfig"), "");
  mkdirSync(join(fixtures, "empty-xdg"));
  const hermeticEnv = (() => {
    const env = { ...process.env } as Record<string, string>;
    for (const key of Object.keys(env)) {
      if (key.startsWith("GIT_")) delete env[key];
    }
    env.GIT_CONFIG_GLOBAL = join(fixtures, "empty-gitconfig");
    env.GIT_CONFIG_SYSTEM = join(fixtures, "empty-gitconfig");
    env.XDG_CONFIG_HOME = join(fixtures, "empty-xdg");
    return env;
  })();

  function git(dir: string, args: string[]): void {
    const run = boundedSpawnSync(
      ["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.test", ...args],
      { env: hermeticEnv, timeoutMs: 30_000 },
    );
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${run.stderr}`);
  }

  const registrySource = (ids: string[]) =>
    `export const GUARD_REGISTRY = [\n${ids.map((id) => `  {\n    id: "${id}",\n  },\n`).join("")}];\n`;

  /** A scratch repo whose origin/main registry carries kept+dropped;
   *  origin/main is HEAD's commit (the on-main shape) until advanced. */
  function baseRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "guard-tripwire-"));
    scratchDirs.push(dir);
    git(dir, ["init", "--quiet", "-b", "main"]);
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/guard_registry.ts"), registrySource(["kept", "dropped"]));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "-m", "base"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    return dir;
  }

  /** baseRepo advanced one commit: HEAD's registry drops "dropped". */
  function scratchRepo(): string {
    const dir = baseRepo();
    writeFileSync(join(dir, "scripts/guard_registry.ts"), registrySource(["kept"]));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "-m", "drops one"]);
    return dir;
  }

  test("a dropped merge-base id goes RED through real git, naming the id", () => {
    const verdict = deletionTripwire(scratchRepo(), new Set(["kept"]), new Set());
    expect(verdict.skipped).toBeNull();
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0].id).toBe("dropped");
  });

  test("an uncommitted deletion while sitting ON main still reds - HEAD is the merge-base and there is no shortcut around the comparison", () => {
    const verdict = deletionTripwire(baseRepo(), new Set(["kept"]), new Set());
    expect(verdict.skipped).toBeNull();
    expect(verdict.problems.map((problem) => problem.id)).toEqual(["dropped"]);
  });

  test("the same drop with a RETIRED_GUARDS acknowledgment goes GREEN", () => {
    const verdict = deletionTripwire(scratchRepo(), new Set(["kept"]), new Set(["dropped"]));
    expect(verdict.skipped).toBeNull();
    expect(verdict.problems).toEqual([]);
  });

  test("no origin/main ref fails OPEN: a named skip, never problems", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-tripwire-"));
    scratchDirs.push(dir);
    git(dir, ["init", "--quiet", "-b", "main"]);
    writeFileSync(join(dir, "lone.txt"), "no remote here\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "--quiet", "-m", "lone"]);
    const verdict = deletionTripwire(dir, new Set(), new Set());
    expect(verdict.problems).toEqual([]);
    expect(verdict.skipped).toContain("no merge-base with origin/main");
  });

  test("CI's guards:binding job fetches full history, so the tripwire fails closed on PRs", () => {
    // Pins the comment ADJACENT to its fetch-depth: deleting either, or
    // re-shallowing the checkout, breaks this exact byte run.
    const ci = readOrNull(".github/workflows/ci.yml");
    expect(ci).toContain("bun run guards:binding");
    expect(ci).toContain(
      "depth-1 checkout would make it stand down (fail open) on every PR.\n" +
        "      - uses: actions/checkout@v7\n        with:\n          fetch-depth: 0",
    );
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
