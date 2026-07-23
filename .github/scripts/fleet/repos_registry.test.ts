import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, type Registry, selectRepos, validateRegistry } from "./repos_registry";

function registry(overrides: Partial<Registry> = {}): Registry {
  return {
    managed: [],
    exclude: [],
    defaultChannel: null,
    config: new Map(),
    ...overrides,
  };
}

describe("validate", () => {
  test("accepts the wildcard fleet shape", () => {
    const { registry: parsed, errors } = loadRegistry(
      [
        'managed:\n  - "*"\n  - Vivswan/dotfiles',
        "exclude:\n  - Vivswan/scratch",
        "defaults:\n  channel: staging",
        "config:\n  Vivswan/repo-settings-as-code:\n    channel: latest",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(parsed?.managed).toEqual(["*", "Vivswan/dotfiles"]);
    expect(parsed?.defaultChannel).toBe("staging");
    expect(parsed?.config.get("Vivswan/repo-settings-as-code")).toEqual({ channel: "latest" });
  });

  test("rejects a bad slug", () => {
    const { errors } = validateRegistry({ managed: ["not a slug!"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"not a slug!"');
  });

  test("rejects a slug with a trailing-hyphen owner", () => {
    const { errors } = validateRegistry({ managed: ["bad-/repo"] });
    expect(errors).toHaveLength(1);
  });

  test("rejects a duplicate entry", () => {
    const { errors } = validateRegistry({ managed: ["a/b", "a/b"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("duplicate managed entry");
  });

  test("rejects two wildcards", () => {
    const { errors } = validateRegistry({ managed: ["*", "*"] });
    expect(errors.some((e) => e.includes('more than one "*"'))).toBe(true);
  });

  test("rejects exclude without a wildcard (dead config)", () => {
    const { errors } = validateRegistry({ managed: ["a/b"], exclude: ["c/d"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("dead config");
  });

  test("accepts exclude alongside a wildcard", () => {
    const { errors } = validateRegistry({ managed: ["*"], exclude: ["c/d"] });
    expect(errors).toEqual([]);
  });

  test("rejects config for an excluded repo", () => {
    const { errors } = validateRegistry({
      managed: ["*"],
      exclude: ["a/b"],
      config: { "a/b": { channel: "staging" } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("also in exclude");
  });

  test("rejects config for an invalid slug", () => {
    const { errors } = validateRegistry({ managed: ["*"], config: { "not-a-slug": {} } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('config key "not-a-slug"');
  });

  test("rejects a bad channel in defaults", () => {
    const { errors } = validateRegistry({ managed: ["a/b"], defaults: { channel: "beta" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("defaults.channel");
    expect(errors[0]).toContain("staging, latest");
  });

  test("rejects a bad channel in config", () => {
    const { errors } = validateRegistry({
      managed: ["a/b"],
      config: { "a/b": { channel: "beta" } },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("config.a/b.channel");
  });

  test("rejects unknown top-level keys", () => {
    const { errors } = validateRegistry({ managed: ["a/b"], channels: {} });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('unknown top-level key "channels"');
  });

  test("rejects an unquoted * as a YAML parse failure", () => {
    const { registry: parsed, errors } = loadRegistry("managed:\n  - *\n");
    expect(parsed).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("YAML parse error");
    expect(errors[0]).toContain('quoted ("*")');
  });

  test("reports every problem, not just the first", () => {
    const { errors } = validateRegistry({
      managed: ["bad slug", "a/b", "a/b"],
      defaults: { channel: "beta" },
      config: { nope: {} },
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("select", () => {
  test("wildcard without --discovered is an error", () => {
    const { errors } = selectRepos(registry({ managed: ["*"] }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("--discovered");
  });

  test("explicit slugs work without --discovered", () => {
    const { selection, errors } = selectRepos(registry({ managed: ["a/b", "c/d"] }));
    expect(errors).toEqual([]);
    expect(selection.map((s) => s.repo)).toEqual(["a/b", "c/d"]);
  });

  test("wildcard unions discovered with explicit slugs, minus exclude", () => {
    const { selection, errors } = selectRepos(
      registry({ managed: ["*", "x/explicit"], exclude: ["a/skipped"] }),
      { discovered: ["a/skipped", "a/kept", "x/explicit"] },
    );
    expect(errors).toEqual([]);
    expect(selection.map((s) => s.repo)).toEqual(["a/kept", "x/explicit"]);
  });

  test("splits owner and name in the output", () => {
    const { selection } = selectRepos(registry({ managed: ["Vivswan/dotfiles"] }));
    expect(selection).toEqual([
      { repo: "Vivswan/dotfiles", owner: "Vivswan", name: "dotfiles", channel: null },
    ]);
  });

  test("channel precedence: config beats defaults beats null", () => {
    const base = registry({
      managed: ["a/config", "a/default", "a/none"],
      defaultChannel: "staging",
      config: new Map([["a/config", { channel: "latest" as const }]]),
    });
    const { selection } = selectRepos(base);
    const channels = Object.fromEntries(selection.map((s) => [s.repo, s.channel]));
    expect(channels["a/config"]).toBe("latest");
    expect(channels["a/default"]).toBe("staging");

    const noDefaults = registry({ managed: ["a/none"] });
    expect(selectRepos(noDefaults).selection[0].channel).toBeNull();
  });

  test("--repo filters to one repo", () => {
    const { selection } = selectRepos(registry({ managed: ["a/b", "c/d"] }), { repo: "c/d" });
    expect(selection.map((s) => s.repo)).toEqual(["c/d"]);
  });

  test("--repo miss is an error mentioning exclude", () => {
    const { errors } = selectRepos(registry({ managed: ["*"], exclude: ["a/b"] }), {
      repo: "a/b",
      discovered: ["a/b"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("exclude");
  });

  test("empty selection is [] not an error", () => {
    const { selection, errors } = selectRepos(registry({ managed: ["*"] }), { discovered: [] });
    expect(errors).toEqual([]);
    expect(selection).toEqual([]);
  });

  test("garbage in the discovered list is an error", () => {
    const { errors } = selectRepos(registry({ managed: ["*"] }), { discovered: ["not a slug"] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("discovered list entry");
  });
});

describe("CLI", () => {
  const script = new URL("./repos_registry.ts", import.meta.url).pathname;
  const repoRoot = new URL("../../..", import.meta.url).pathname;

  function run(args: string[]): { exitCode: number; stdout: string; stderr: string } {
    const proc = Bun.spawnSync(["bun", script, ...args], { cwd: repoRoot });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
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
    expect(parsed).toContainEqual({
      repo: "Vivswan/dotfiles",
      owner: "Vivswan",
      name: "dotfiles",
      channel: "staging",
    });
  });

  test("validate fails with ::error:: annotations on a broken file", async () => {
    const broken = join(tmpdir(), "repos-registry-test-broken.yml");
    await Bun.write(broken, "managed:\n  - bad slug\n  - a/b\n  - a/b\n");
    const { exitCode, stderr } = run(["validate", "--file", broken]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("::error::");
    expect(stderr.match(/::error::/g)?.length).toBe(2);
  });
});
