// Tests for the validate-skills action: the frontmatter/JSON loaders (edge
// cases adapted from the reference skills repository's own suite), the
// plugin-manifest loader, the per-skill contract, and the structure mode
// end-to-end over temporary fixture trees.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CheckFailure,
  kebabToTitle,
  listedInOutput,
  loadJson,
  loadJsonObject,
  loadPluginManifest,
  parseFrontmatter,
  skillDirs,
  validateMarketplace,
  validateSkillDir,
  validateStructure,
} from "./validate_skills";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "validate-skills-test-"));
}

function tempFile(content: string, name = "SKILL.md"): string {
  const path = join(tempDir(), name);
  writeFileSync(path, content);
  return path;
}

/** A fixture repo with one valid skill and the starter-shaped manifests. */
function fixtureRepo(options: { skills?: string[]; skillNames?: string[] } = {}): string {
  const root = tempDir();
  const skillNames = options.skillNames ?? ["good-skill"];
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "fixture-skills",
      skills: options.skills ?? skillNames.map((name) => `./skills/${name}`),
    }),
  );
  for (const name of skillNames) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(
      join(root, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: A fixture skill.\n---\nbody\n`,
    );
  }
  return root;
}

describe("parseFrontmatter", () => {
  test("parses top-level and nested keys with YAML types", () => {
    const path = tempFile(
      ["---", "name: test-skill", "metadata:", "  internal: true", "---", "body"].join("\n"),
    );
    expect(parseFrontmatter(path, "SKILL.md")).toEqual({
      name: "test-skill",
      metadata: { internal: true },
    });
  });

  test("strips surrounding quotes from values", () => {
    const path = tempFile("---\ndescription: \"A quoted description\"\nlicense: 'MIT'\n---\n");
    expect(parseFrontmatter(path, "SKILL.md")).toEqual({
      description: "A quoted description",
      license: "MIT",
    });
  });

  test("parses folded block scalars as their full text", () => {
    const path = tempFile("---\ndescription: >-\n  first line\n  second line\n---\n");
    expect(parseFrontmatter(path, "SKILL.md")).toEqual({ description: "first line second line" });
  });

  test("fails without a frontmatter start marker", () => {
    expect(() => parseFrontmatter(tempFile("# no frontmatter\n"), "SKILL.md")).toThrow(
      CheckFailure,
    );
  });

  test("fails without a frontmatter end marker", () => {
    expect(() => parseFrontmatter(tempFile("---\nname: x\n"), "SKILL.md")).toThrow(CheckFailure);
  });

  test("fails on invalid YAML", () => {
    expect(() => parseFrontmatter(tempFile("---\nname: [unclosed\n---\n"), "SKILL.md")).toThrow(
      CheckFailure,
    );
  });

  test("fails when frontmatter is not a mapping", () => {
    expect(() => parseFrontmatter(tempFile("---\n- just\n- a list\n---\n"), "SKILL.md")).toThrow(
      CheckFailure,
    );
  });

  test("fails on a missing file, naming it", () => {
    const run = () => parseFrontmatter("/nonexistent/SKILL.md", "nonexistent/SKILL.md");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/nonexistent\/SKILL\.md: cannot read file/);
  });
});

describe("loadJson / loadJsonObject", () => {
  test("parses valid JSON", () => {
    expect(loadJson(tempFile('{"a": 1}', "x.json"), "x.json")).toEqual({ a: 1 });
  });

  test("fails on invalid JSON", () => {
    expect(() => loadJson(tempFile("{oops", "x.json"), "x.json")).toThrow(CheckFailure);
  });

  test("fails on a missing file", () => {
    expect(() => loadJson("/nonexistent/x.json", "x.json")).toThrow(CheckFailure);
  });

  test("fails when the root is not an object", () => {
    for (const content of ["[1]", '"text"', "null", "3"]) {
      const run = () => loadJsonObject(tempFile(content, "x.json"), "x.json");
      expect(run).toThrow(CheckFailure);
      expect(run).toThrow(/x\.json: root must be an object/);
    }
  });
});

describe("loadPluginManifest", () => {
  test("accepts the starter's empty skills array", () => {
    const path = tempFile('{"name": "my-skills", "skills": []}', "plugin.json");
    expect(loadPluginManifest(path, "plugin.json")).toEqual({ name: "my-skills", skills: [] });
  });

  test("rejects a non-kebab-case name", () => {
    for (const name of ["My Skills", "my_skills", "-lead", "", 3]) {
      const path = tempFile(JSON.stringify({ name, skills: [] }), "plugin.json");
      expect(() => loadPluginManifest(path, "plugin.json")).toThrow(/must be kebab-case/);
    }
  });

  test("rejects a missing or non-array skills key", () => {
    for (const skills of [undefined, "skills", { a: 1 }]) {
      const path = tempFile(JSON.stringify({ name: "x-y", skills }), "plugin.json");
      expect(() => loadPluginManifest(path, "plugin.json")).toThrow(/skills must be an array/);
    }
  });

  test("rejects non-string skill paths", () => {
    const path = tempFile('{"name": "x-y", "skills": [3]}', "plugin.json");
    expect(() => loadPluginManifest(path, "plugin.json")).toThrow(/must be strings/);
  });
});

describe("validateSkillDir", () => {
  function skillFixture(folder: string, frontmatter: string): string {
    const dir = join(tempDir(), folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), frontmatter);
    return dir;
  }

  test("passes a conforming skill", () => {
    const dir = skillFixture(
      "good-skill",
      "---\nname: good-skill\ndescription: Does things.\n---\n",
    );
    expect(validateSkillDir(dir, "skills/good-skill")).toEqual([]);
  });

  test("reports a missing SKILL.md", () => {
    const dir = join(tempDir(), "empty-skill");
    mkdirSync(dir, { recursive: true });
    const errors = validateSkillDir(dir, "skills/empty-skill");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cannot read file/);
  });

  test("reports name/folder mismatch and missing description together", () => {
    const dir = skillFixture("real-name", "---\nname: other-name\n---\n");
    const errors = validateSkillDir(dir, "skills/real-name");
    expect(errors.some((e) => e.includes("does not match folder 'real-name'"))).toBe(true);
    expect(errors.some((e) => e.includes("missing frontmatter description"))).toBe(true);
  });

  test("rejects non-kebab-case names", () => {
    const dir = skillFixture("Bad_Name", "---\nname: Bad_Name\ndescription: d\n---\n");
    expect(validateSkillDir(dir, "skills/Bad_Name").some((e) => e.includes("kebab-case"))).toBe(
      true,
    );
  });

  test("rejects a whitespace-only description", () => {
    const dir = skillFixture("blank-skill", '---\nname: blank-skill\ndescription: "   "\n---\n');
    const errors = validateSkillDir(dir, "skills/blank-skill");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/missing frontmatter description/);
  });

  test("parses .mcp.json when the skill carries one", () => {
    const dir = skillFixture("mcp-skill", "---\nname: mcp-skill\ndescription: d\n---\n");
    writeFileSync(join(dir, ".mcp.json"), "{oops");
    const errors = validateSkillDir(dir, "skills/mcp-skill");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\.mcp\.json: invalid JSON/);
    writeFileSync(join(dir, ".mcp.json"), '{"mcpServers": {}}');
    expect(validateSkillDir(dir, "skills/mcp-skill")).toEqual([]);
  });

  test("enforces the name and description length limits", () => {
    const name = `x${"-x".repeat(40)}`; // 81 chars, kebab-case
    const dir = skillFixture(name, `---\nname: ${name}\ndescription: ${"d".repeat(1025)}\n---\n`);
    const errors = validateSkillDir(dir, `skills/${name}`);
    expect(errors.some((e) => e.includes("name exceeds 64"))).toBe(true);
    expect(errors.some((e) => e.includes("description exceeds 1024"))).toBe(true);
  });
});

describe("validateStructure", () => {
  test("passes a valid tree", () => {
    expect(validateStructure(fixtureRepo(), "skills", ".claude-plugin/plugin.json")).toEqual([]);
  });

  test("passes the starter state (empty catalog, no skills dir)", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([]);
  });

  test("reports a missing plugin manifest", () => {
    const errors = validateStructure(tempDir(), "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/plugin\.json: cannot read file/);
  });

  test("rejects traversing and out-of-tree skill paths", () => {
    for (const path of ["./skills/a/../../evil", "../outside", "./other/dir"]) {
      const root = fixtureRepo({ skills: [path], skillNames: [] });
      const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
      expect(errors.some((e) => e.includes("must be a direct child of skills/"))).toBe(true);
    }
  });

  test("rejects a referenced skill without SKILL.md", () => {
    const root = fixtureRepo({ skills: ["./skills/ghost"], skillNames: [] });
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors.some((e) => e.includes("has no SKILL.md"))).toBe(true);
  });

  test("validates unlisted folders under the skills dir too", () => {
    const root = fixtureRepo();
    mkdirSync(join(root, "skills", "stray-skill"));
    writeFileSync(join(root, "skills", "stray-skill", "SKILL.md"), "---\nname: wrong\n---\n");
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors.some((e) => e.includes("does not match folder 'stray-skill'"))).toBe(true);
  });

  test("honors a custom skills dir", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      '{"name": "x-y", "skills": ["./lib/skills/a-skill"]}',
    );
    mkdirSync(join(root, "lib", "skills", "a-skill"), { recursive: true });
    writeFileSync(
      join(root, "lib", "skills", "a-skill", "SKILL.md"),
      "---\nname: a-skill\ndescription: d\n---\n",
    );
    expect(validateStructure(root, "lib/skills", ".claude-plugin/plugin.json")).toEqual([]);
    // The same manifest against the default dir fails containment.
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors.some((e) => e.includes("must be a direct child of skills/"))).toBe(true);
  });
});

describe("validateMarketplace", () => {
  const ROOT_PLUGIN = { name: "x-y", skills: [] } as const;
  // null (not undefined - a default parameter would resurrect ROOT_PLUGIN)
  // models plugin.json having failed to load.
  const run = (
    root: string,
    content: unknown,
    rootPlugin: typeof ROOT_PLUGIN | null = ROOT_PLUGIN,
  ) => {
    const path = join(root, "marketplace.json");
    writeFileSync(path, JSON.stringify(content));
    return validateMarketplace(
      path,
      "marketplace.json",
      root,
      join(root, "skills"),
      "skills",
      rootPlugin ?? undefined,
    );
  };

  test("passes the starter shape", () => {
    const root = tempDir();
    expect(run(root, { name: "x-y", plugins: [{ name: "x-y", source: "./" }] })).toEqual([]);
  });

  test("rejects malformed roots and entries", () => {
    const root = tempDir();
    const cases: [unknown, RegExp][] = [
      [{ plugins: [{ name: "x-y", source: "./" }] }, /name undefined must be kebab-case/],
      [{ name: "Not Kebab", plugins: [{ name: "x-y", source: "./" }] }, /must be kebab-case/],
      [{ name: "x-y" }, /missing plugins array/],
      [{ name: "x-y", plugins: [] }, /missing plugins array/],
      [{ name: "x-y", plugins: ["x"] }, /must be an object/],
      [{ name: "x-y", plugins: [{ name: "Bad Name", source: "./" }] }, /must be kebab-case/],
      [{ name: "x-y", plugins: [{ name: "x-y" }] }, /needs a source path/],
      [
        { name: "x-y", plugins: [{ name: "x-y", source: "../../outside" }] },
        /escapes the repository/,
      ],
      [{ name: "x-y", plugins: [{ name: "x-y", source: "./gone" }] }, /is not a directory/],
      [
        { name: "x-y", plugins: [{ name: "other-name", source: "./" }] },
        /the two manifests must agree/,
      ],
      [
        { name: "x-y", plugins: [{ name: "x-y", source: "./", skills: ["./gone"] }] },
        /must be a direct child of skills\//,
      ],
      [
        { name: "x-y", plugins: [{ name: "x-y", source: "./", skills: ["./skills/gone"] }] },
        /has no SKILL\.md/,
      ],
      [
        {
          name: "x-y",
          plugins: [{ name: "x-y", source: "./", skills: ["./skills/a/../../evil"] }],
        },
        /must be a direct child of skills\//,
      ],
    ];
    for (const [content, message] of cases) {
      const errors = run(root, content);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(message);
    }
  });

  test("aggregates across entries instead of stopping at the first bad one", () => {
    const root = tempDir();
    const errors = run(root, {
      name: "x-y",
      plugins: [{ name: "Bad Name", source: "./" }, "not-an-object", { name: "x-y", source: "./" }],
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/must be kebab-case/);
    expect(errors[1]).toMatch(/must be an object/);
  });

  test("skips the root-name consistency check when plugin.json failed to load", () => {
    const root = tempDir();
    expect(
      run(root, { name: "x-y", plugins: [{ name: "other-name", source: "./" }] }, null),
    ).toEqual([]);
  });
});

describe("symlink policy", () => {
  test("rejects a symlinked skills directory", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    const real = join(root, "real-skills");
    mkdirSync(real);
    symlinkSync(real, join(root, "skills"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/skills: resolves through a symlink/);
  });

  test("rejects a symlinked ancestor of the skills directory", () => {
    // skills_dir=lib/skills with lib/ itself a symlink: only the physical
    // root comparison sees this shape (the leaf lstat would pass).
    const root = tempDir();
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      '{"name": "x-y", "skills": ["./lib/skills/a-skill"]}',
    );
    mkdirSync(join(root, "real-lib", "skills", "a-skill"), { recursive: true });
    writeFileSync(
      join(root, "real-lib", "skills", "a-skill", "SKILL.md"),
      "---\nname: a-skill\ndescription: d\n---\n",
    );
    symlinkSync(join(root, "real-lib"), join(root, "lib"));
    const errors = validateStructure(root, "lib/skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/lib\/skills: resolves through a symlink/);
  });

  test("rejects a dangling ancestor symlink even with an empty starter catalog", () => {
    // lib -> nothing: realpath fails, so the lstat walk up the chain must
    // name the link instead of reading the tree as an absent starter dir.
    const root = fixtureRepo({ skills: [], skillNames: [] });
    symlinkSync(join(root, "missing-target"), join(root, "lib"));
    const errors = validateStructure(root, "lib/skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/lib\/skills: lib is a symlink \(dangling or diverted\)/);
    // The genuinely-missing chain still passes as the starter state.
    expect(validateStructure(root, "absent/skills", ".claude-plugin/plugin.json")).toEqual([]);
  });

  test("rejects a symlinked plugin manifest", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    writeFileSync(join(root, "real-plugin.json"), '{"name": "x-y", "skills": []}');
    const manifest = join(root, ".claude-plugin", "linked-plugin.json");
    symlinkSync(join(root, "real-plugin.json"), manifest);
    const errors = validateStructure(root, "skills", ".claude-plugin/linked-plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/linked-plugin\.json: resolves through a symlink/);
  });

  test("rejects a symlinked skill folder, listed or not", () => {
    const root = fixtureRepo({ skills: ["./skills/linked-skill"], skillNames: ["good-skill"] });
    symlinkSync(join(root, "skills", "good-skill"), join(root, "skills", "linked-skill"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors.some((e) => e.includes("is a symlink; publish the real directory"))).toBe(true);
    expect(errors.some((e) => e.includes("symlinked entries are not validated"))).toBe(true);
  });

  test("rejects a symlinked SKILL.md", () => {
    const root = fixtureRepo({ skills: ["./skills/link-md"], skillNames: ["good-skill"] });
    mkdirSync(join(root, "skills", "link-md"));
    symlinkSync(
      join(root, "skills", "good-skill", "SKILL.md"),
      join(root, "skills", "link-md", "SKILL.md"),
    );
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors.some((e) => e.includes("SKILL.md is a symlink"))).toBe(true);
    expect(errors.some((e) => e.includes("must be a real file, not a symlink"))).toBe(true);
  });

  test("rejects a symlinked .mcp.json", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "real-mcp.json"), '{"mcpServers": {}}');
    symlinkSync(join(root, "real-mcp.json"), join(root, "skills", "good-skill", ".mcp.json"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\.mcp\.json: must be a real file, not a symlink/);
  });

  test("marketplace source may pass through an in-repo symlink but not leave the repo", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    const outside = tempDir();
    mkdirSync(join(root, "real-source"));
    symlinkSync(join(root, "real-source"), join(root, "in-repo-link"));
    symlinkSync(outside, join(root, "escape-link"));
    const marketplace = join(root, ".claude-plugin", "marketplace.json");
    const run = (source: string) => {
      writeFileSync(
        marketplace,
        JSON.stringify({ name: "x-y", plugins: [{ name: "x-y", source }] }),
      );
      return validateStructure(root, "skills", ".claude-plugin/plugin.json");
    };
    expect(run("./in-repo-link")).toEqual([]);
    const errors = run("./escape-link");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /source \.\/escape-link resolves through a symlink to .*outside the repository/,
    );
  });

  test("a self-link source publishes the repository root and must match plugin.json's name", () => {
    // self-link -> . reaches the root physically; the name-consistency
    // check must compare physically too, not just for the literal "./".
    const root = fixtureRepo({ skills: [], skillNames: [] });
    symlinkSync(root, join(root, "self-link"));
    const marketplace = join(root, ".claude-plugin", "marketplace.json");
    const run = (name: string) => {
      writeFileSync(
        marketplace,
        JSON.stringify({ name: "x-y", plugins: [{ name, source: "./self-link" }] }),
      );
      return validateStructure(root, "skills", ".claude-plugin/plugin.json");
    };
    const errors = run("other-name");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/publishes the repository root but the plugin manifest names it/);
    expect(run("fixture-skills")).toEqual([]);
  });
});

describe("discovery helpers", () => {
  test("skillDirs handles missing dirs, sorts children, and flags symlinks", () => {
    expect(skillDirs(join(tempDir(), "nope"), "skills")).toEqual({ dirs: [], errors: [] });
    const root = tempDir();
    for (const name of ["b-skill", "a-skill"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "not-a-dir"), "");
    symlinkSync(join(root, "a-skill"), join(root, "c-link"));
    const { dirs, errors } = skillDirs(root, "skills");
    expect(dirs).toEqual(["a-skill", "b-skill"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/skills\/c-link: symlinked entries/);
  });

  test("listedInOutput matches on name boundaries only", () => {
    expect(listedInOutput("foo", "installs foo (v1)")).toBe(true);
    expect(listedInOutput("foo", "installs foo-bar")).toBe(false);
    expect(listedInOutput("foo-bar", "has foo listed")).toBe(false);
    expect(listedInOutput("foo-bar", "> foo-bar\n")).toBe(true);
  });

  test("kebabToTitle capitalizes each segment", () => {
    expect(kebabToTitle("vivswan-skills")).toBe("Vivswan Skills");
    expect(kebabToTitle("x")).toBe("X");
  });
});
