import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  type Registry,
  selectRepos,
  validateRegistry,
} from "../../.github/scripts/fleet/repos_registry";
import { boundedSpawnSync } from "../shared/bounded_spawn";

function registry(overrides: Partial<Registry> = {}): Registry {
  return {
    managed: { wildcard: false, repos: [] },
    exclude: [],
    ...overrides,
  };
}

describe("validate", () => {
  test("accepts the wildcard fleet shape", () => {
    const { registry: parsed, errors } = loadRegistry(
      ['managed:\n  - "*"\n  - Vivswan/dotfiles', "exclude:\n  - Vivswan/scratch"].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(parsed?.managed).toEqual({ wildcard: true, repos: ["Vivswan/dotfiles"] });
    expect(parsed?.exclude).toEqual(["Vivswan/scratch"]);
  });

  // Exact error lists: length-1-plus-substring would pass on a single
  // unrelated error, and `.some` tolerates extras. Every fault gets its
  // own row; the multi-fault row proves the validator reports them all.
  test.each([
    {
      reason: "a bad slug",
      data: { managed: ["not a slug!"] },
      errors: ['repos.yml: managed entry "not a slug!" is not an owner/name slug or "*"'],
    },
    {
      reason: "a slug with a trailing-hyphen owner",
      data: { managed: ["bad-/repo"] },
      errors: ['repos.yml: managed entry "bad-/repo" is not an owner/name slug or "*"'],
    },
    {
      reason: "a duplicate entry",
      data: { managed: ["a/b", "a/b"] },
      errors: ['repos.yml: duplicate managed entry "a/b" (slugs match ignoring case)'],
    },
    {
      reason: "a case-variant duplicate managed entry",
      data: { managed: ["a/b", "A/B"] },
      errors: ['repos.yml: duplicate managed entry "A/B" (slugs match ignoring case)'],
    },
    {
      reason: "a case-variant duplicate exclude entry",
      data: { managed: ["*"], exclude: ["a/b", "A/B"] },
      errors: ['repos.yml: duplicate exclude entry "A/B" (slugs match ignoring case)'],
    },
    {
      reason: "two wildcards",
      data: { managed: ["*", "*"] },
      errors: ['repos.yml: managed contains more than one "*" wildcard'],
    },
    {
      reason: "exclude without a wildcard (dead config)",
      data: { managed: ["a/b"], exclude: ["c/d"] },
      errors: [
        'repos.yml: exclude has entries but managed has no "*" wildcard - nothing is ' +
          "auto-discovered, so exclusions are dead config; remove the entries from exclude " +
          "(or just do not list them in managed)",
      ],
    },
    {
      reason: "exclude alongside a wildcard is fine",
      data: { managed: ["*"], exclude: ["c/d"] },
      errors: [],
    },
    {
      reason: "unknown top-level keys",
      data: { managed: ["a/b"], channels: {} },
      errors: ['repos.yml: unknown top-level key "channels" - allowed keys are managed, exclude'],
    },
    {
      reason: "every problem, not just the first",
      data: { managed: ["bad slug", "a/b", "a/b"], unknown: {} },
      errors: [
        'repos.yml: unknown top-level key "unknown" - allowed keys are managed, exclude',
        'repos.yml: managed entry "bad slug" is not an owner/name slug or "*"',
        'repos.yml: duplicate managed entry "a/b" (slugs match ignoring case)',
      ],
    },
  ])("reports $reason", ({ data, errors }) => {
    expect(validateRegistry(data).errors).toEqual(errors);
  });

  test("rejects an unquoted * as a YAML parse failure", () => {
    const { registry: parsed, errors } = loadRegistry("managed:\n  - *\n");
    expect(parsed).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("YAML parse error");
    expect(errors[0]).toContain('quoted ("*")');
  });
});

describe("select", () => {
  // Every accept row pins the full {repo, owner, name} selection and an
  // empty error list, so the owner/name split is proven on every case.
  test.each([
    {
      reason: "explicit slugs work without --discovered",
      registry: registry({ managed: { wildcard: false, repos: ["a/b", "c/d"] } }),
      options: {},
      expected: [
        { repo: "a/b", owner: "a", name: "b" },
        { repo: "c/d", owner: "c", name: "d" },
      ],
    },
    {
      reason: "wildcard unions discovered with explicit slugs, minus exclude",
      registry: registry({
        managed: { wildcard: true, repos: ["x/explicit"] },
        exclude: ["a/skipped"],
      }),
      options: { discovered: ["a/skipped", "a/kept", "x/explicit"] },
      expected: [
        { repo: "a/kept", owner: "a", name: "kept" },
        { repo: "x/explicit", owner: "x", name: "explicit" },
      ],
    },
    {
      reason: "exclude and dedupe match case-insensitively, keeping the listed casing",
      registry: registry({
        managed: { wildcard: true, repos: ["X/Explicit"] },
        exclude: ["A/Skipped"],
      }),
      options: { discovered: ["a/skipped", "x/explicit", "a/kept"] },
      expected: [
        { repo: "X/Explicit", owner: "X", name: "Explicit" },
        { repo: "a/kept", owner: "a", name: "kept" },
      ],
    },
    {
      reason: "--repo filters to one repo",
      registry: registry({ managed: { wildcard: false, repos: ["a/b", "c/d"] } }),
      options: { repo: "c/d" },
      expected: [{ repo: "c/d", owner: "c", name: "d" }],
    },
    {
      reason: "--repo matches case-insensitively",
      registry: registry({ managed: { wildcard: false, repos: ["a/b", "C/Mixed-Case"] } }),
      options: { repo: "c/mixed-case" },
      expected: [{ repo: "C/Mixed-Case", owner: "C", name: "Mixed-Case" }],
    },
    {
      reason: "--repo takes a comma list: trimmed, folded, deduped, in selection order",
      registry: registry({ managed: { wildcard: false, repos: ["a/b", "C/Mixed-Case", "e/f"] } }),
      options: { repo: " e/f , c/MIXED-case,E/F" },
      expected: [
        { repo: "C/Mixed-Case", owner: "C", name: "Mixed-Case" },
        { repo: "e/f", owner: "e", name: "f" },
      ],
    },
    {
      reason: "an empty selection is [] not an error",
      registry: registry({ managed: { wildcard: true, repos: [] } }),
      options: { discovered: [] },
      expected: [],
    },
  ])("selects: $reason", ({ registry: reg, options, expected }) => {
    expect(selectRepos(reg, options)).toEqual({ selection: expected, errors: [] });
  });

  // Each short-circuit path: the exact message, and an EMPTY selection
  // riding with it.
  test.each([
    {
      reason: "wildcard without --discovered",
      registry: registry({ managed: { wildcard: true, repos: [] } }),
      options: {},
      error:
        'repos.yml: managed contains "*" but no --discovered file was provided - pass the ' +
        "caller's discovery output (a JSON array of owner/name strings)",
    },
    {
      reason: "a --repo miss, mentioning exclude and withholding the value",
      registry: registry({ managed: { wildcard: true, repos: [] }, exclude: ["a/b"] }),
      options: { repo: "a/b", discovered: ["a/b"] },
      error:
        "--repo: 1 of 1 requested repos matched no selected repository (values withheld - " +
        "they may be private slugs): a repo you dispatched with is not in managed (or the " +
        "discovered list), or it is listed in exclude; check the spelling (matching ignores case)",
    },
    {
      reason: "one miss in a list fails the whole selection, counting only",
      registry: registry({ managed: { wildcard: false, repos: ["a/b", "c/d"] } }),
      options: { repo: "a/b,c/d,x/private-typo" },
      error:
        "--repo: 1 of 3 requested repos matched no selected repository (values withheld - " +
        "they may be private slugs): a repo you dispatched with is not in managed (or the " +
        "discovered list), or it is listed in exclude; check the spelling (matching ignores case)",
    },
    {
      reason: "a lone comma is an empty entry, never the whole fleet",
      registry: registry({ managed: { wildcard: false, repos: ["a/b"] } }),
      options: { repo: " , " },
      error:
        "--repo has an empty entry: pass owner/name slugs separated by commas, with no stray or trailing comma",
    },
    {
      reason: "a trailing comma is an empty entry, never a silently narrowed list",
      registry: registry({ managed: { wildcard: false, repos: ["a/b", "c/d"] } }),
      options: { repo: "a/b,c/d," },
      error:
        "--repo has an empty entry: pass owner/name slugs separated by commas, with no stray or trailing comma",
    },
    {
      reason: "garbage in the discovered list, named by index only",
      registry: registry({ managed: { wildcard: true, repos: [] } }),
      options: { discovered: ["not a slug"] },
      error: "discovered list entry at index 0 is not an owner/name slug",
    },
  ])("errors on $reason", ({ registry: reg, options, error }) => {
    expect(selectRepos(reg, options)).toEqual({ selection: [], errors: [error] });
  });
});

describe("CLI", () => {
  const script = new URL("../../.github/scripts/fleet/repos_registry.ts", import.meta.url).pathname;
  const repoRoot = new URL("../..", import.meta.url).pathname;

  function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const proc = boundedSpawnSync(["bun", script, ...args], { cwd: repoRoot });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
    };
  }

  test("validate passes on the checked-in repos.yml", () => {
    const { exitCode, stdout } = run(["validate"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("repos.yml: OK");
  });

  test("select resolves the checked-in repos.yml against a discovered list", async () => {
    const discovered = join(tmpdir(), "repos-registry-test-discovered.json");
    await Bun.write(discovered, JSON.stringify(["Vivswan/dotfiles"]));
    const { exitCode, stdout } = run(["select", "--discovered", discovered]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toContainEqual({ repo: "Vivswan/dotfiles", owner: "Vivswan", name: "dotfiles" });
  });

  test("validate fails with ::error:: annotations on a broken file", async () => {
    const broken = join(tmpdir(), "repos-registry-test-broken.yml");
    await Bun.write(broken, "managed:\n  - bad slug\n  - a/b\n  - a/b\n");
    // Annotations parse from stdout only; that is where fail() prints -
    // one ::error:: line per problem, exact text, nothing else.
    const { exitCode, stdout } = run(["validate", "--file", broken]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe(
      `::error::${broken}: managed entry "bad slug" is not an owner/name slug or "*"\n` +
        `::error::${broken}: duplicate managed entry "a/b" (slugs match ignoring case)\n`,
    );
  });

  test("select accepts discovered {repo, ...} objects with extra keys", async () => {
    const discovered = join(tmpdir(), "repos-registry-test-discovered-objects.json");
    await Bun.write(
      discovered,
      JSON.stringify([{ repo: "Vivswan/dotfiles", private: false, extra: 1 }]),
    );
    const { exitCode, stdout } = run(["select", "--discovered", discovered]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).map((row: { repo: string }) => row.repo)).toContain(
      "Vivswan/dotfiles",
    );
  });

  test("a discovered entry of the wrong shape fails naming its index, never its value", async () => {
    const discovered = join(tmpdir(), "repos-registry-test-discovered-bad.json");
    await Bun.write(discovered, JSON.stringify(["Vivswan/dotfiles", { repo: 42 }]));
    const { exitCode, stdout } = run(["select", "--discovered", discovered]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("entry at index 1");
    expect(stdout).not.toContain("42");
  });

  test("a malformed discovered file fails value-free (no SyntaxError echo)", async () => {
    // The bare identifier is the leaking form: a raw JSON.parse error
    // quotes it ('Unexpected identifier "hiddenserver"') into this public
    // log, and discovered.json carries private slugs.
    const discovered = join(tmpdir(), "repos-registry-test-discovered-unparseable.json");
    await Bun.write(discovered, '["Vivswan/dotfiles", hiddenserver]');
    const { exitCode, stdout, stderr } = run(["select", "--discovered", discovered]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("not valid JSON");
    expect(stdout + stderr).not.toContain("hiddenserver");
  });

  test("excluded prints the exclude list as a JSON array", async () => {
    const file = join(tmpdir(), "repos-registry-test-excluded.yml");
    await Bun.write(file, 'managed:\n  - "*"\nexclude:\n  - a/b\n  - a/c\n');
    const { exitCode, stdout } = run(["excluded", "--file", file]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(["a/b", "a/c"]);
  });
});
