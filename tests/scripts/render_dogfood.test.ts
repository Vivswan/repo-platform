// Unit tests for render_dogfood's pure helpers: the answers-file parsing,
// the copier-computed context derivations, the filename gates, and the
// cross-checks anchoring each answer to its authoritative source. The
// renderer itself runs against the live repo (bun run dogfood:check
// exercises every pair).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderJinjaFile } from "../../scripts/jinja_subset";
import type { ModuleManifest } from "../../scripts/module_manifests";
import {
  type AnswerSources,
  type Answers,
  answerMismatches,
  enableCodeql,
  gateOfPair,
  hasToolchain,
  moduleOfPair,
  PAIRS,
  pairIsRendered,
  parseAnswers,
  pathExists,
  renderContext,
} from "../../scripts/render_dogfood";

const answers: Answers = {
  project_name: "repo-platform",
  project_slug: "repo-platform",
  description: "d",
  github_username: "Vivswan",
  copyright_holder: "Vivswan Shah",
  private: false,
  modules: new Set([
    "agents",
    "bun",
    "release-please",
    "skills",
    "pr-title",
    "auto-assign",
    "docs-site",
  ]),
  skills_dir: "skills",
  docs_site_label: "docs-link-rot",
};

const manifests: ModuleManifest[] = [
  { module: "agents", description: "a" },
  { module: "bun", description: "b", toolchain: { codeql_language: "javascript-typescript" } },
  { module: "uv", description: "u", toolchain: { codeql_language: "python" } },
  { module: "release-please", description: "r" },
  { module: "skills", description: "s" },
  { module: "pr-title", description: "p" },
  { module: "auto-assign", description: "aa" },
  { module: "docs-site", description: "ds" },
];

const sources: AnswerSources = {
  packageName: "repo-platform",
  usernameDefault: "Vivswan",
  copyrightDefault: "Vivswan Shah",
  skillsDirDefault: "skills",
  docsSiteLabelDefault: "docs-link-rot",
  settingsDescription: "d",
  settingsPrivate: false,
  moduleNames: new Set(manifests.map((m) => m.module)),
};

describe("parseAnswers", () => {
  const lines = [
    "project_name: X Y",
    "project_slug: x-y",
    "description: d",
    "github_username: U",
    "copyright_holder: C",
    "private: true",
  ];

  test("parses a complete answers document into the typed record, modules as a set", () => {
    const text = [...lines, "modules: [bun, uv]"].join("\n");
    expect(parseAnswers(text, "f")).toEqual({
      project_name: "X Y",
      project_slug: "x-y",
      description: "d",
      github_username: "U",
      copyright_holder: "C",
      private: true,
      modules: new Set(["bun", "uv"]),
    });
  });

  test("throws loudly on a duplicated module name", () => {
    const text = [...lines, "modules: [bun, bun]"].join("\n");
    expect(() => parseAnswers(text, "f")).toThrow("modules must be unique");
  });

  test("throws loudly on a missing key, naming the file and path", () => {
    expect(() => parseAnswers("project_name: x", "f")).toThrow(/^f: /);
  });

  test("throws loudly on an unknown key (no silent extras)", () => {
    const text = "project_name: x\nchannel: staging";
    expect(() => parseAnswers(text, "f")).toThrow("channel");
  });
});

describe("copier-computed context", () => {
  test("has_toolchain and enable_codeql follow copier.yml's derivations", () => {
    expect(hasToolchain(answers, manifests)).toBe(true);
    expect(enableCodeql(answers, manifests)).toBe(true);
    expect(enableCodeql({ ...answers, private: true }, manifests)).toBe(false);
    const noToolchain = { ...answers, modules: new Set(["agents", "release-please"]) };
    expect(hasToolchain(noToolchain, manifests)).toBe(false);
    expect(enableCodeql(noToolchain, manifests)).toBe(false);
  });

  test("renderContext is exactly the three computed variables plus both membership keys per module", () => {
    expect(renderContext(answers, manifests)).toEqual({
      private: false,
      has_toolchain: true,
      enable_codeql: true,
      "'agents' in modules": true,
      "'agents' not in modules": false,
      "'bun' in modules": true,
      "'bun' not in modules": false,
      "'uv' in modules": false,
      "'uv' not in modules": true,
      "'release-please' in modules": true,
      "'release-please' not in modules": false,
      "'skills' in modules": true,
      "'skills' not in modules": false,
      "'pr-title' in modules": true,
      "'pr-title' not in modules": false,
      "'auto-assign' in modules": true,
      "'auto-assign' not in modules": false,
      "'docs-site' in modules": true,
      "'docs-site' not in modules": false,
    });
  });
});

describe("moduleOfPair", () => {
  test("returns null for base templates and the module dir otherwise", () => {
    expect(moduleOfPair("templates/base/.editorconfig.jinja")).toBeNull();
    expect(moduleOfPair("templates/bun/.github/workflows/x.yml.jinja")).toBe("bun");
  });

  test("throws on a template outside templates/", () => {
    expect(() => moduleOfPair(".github/workflows/x.yml")).toThrow("not under templates/");
  });

  test("every pair's template resolves to base or an answered module", () => {
    for (const pair of PAIRS) {
      const module = moduleOfPair(pair.tpl);
      expect(module === null || answers.modules.has(module)).toBe(true);
    }
  });
});

describe("pathExists", () => {
  test("sees the dangling symlink existsSync misses, and a missing path as absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "render-dogfood-test-"));
    try {
      const link = join(dir, "dangling");
      symlinkSync(join(dir, "missing-target"), link);
      expect(existsSync(link)).toBe(false);
      expect(pathExists(link)).toBe(true);
      expect(pathExists(join(dir, "nothing"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("filename gates", () => {
  test("an ungated filename is always rendered", () => {
    expect(gateOfPair("templates/base/.editorconfig.jinja")).toEqual({ kind: "always" });
    expect(pairIsRendered("templates/base/.editorconfig.jinja", {})).toBe(true);
  });

  test("a filename if-gate is represented and follows its condition", () => {
    const tpl = "templates/base/.github/{% if not private %}CODE_OF_CONDUCT.md{% endif %}.jinja";
    expect(gateOfPair(tpl)).toEqual({ kind: "when", condition: "not private" });
    expect(pairIsRendered(tpl, { private: false })).toBe(true);
    expect(pairIsRendered(tpl, { private: true })).toBe(false);
  });

  test("an unresolvable gate condition fails loudly", () => {
    const tpl = "templates/base/{% if mystery %}X{% endif %}.jinja";
    expect(() => pairIsRendered(tpl, {})).toThrow("does not resolve");
  });
});

describe("release-please-config template", () => {
  // Regression oracle for the seeded-owner comment: every CI render uses
  // this repo's own github_username (Vivswan), so a re-hardcoded owner
  // literal in the template would pass byte-parity everywhere; rendering
  // with a different owner catches it, and JSON.parse catches a
  // substitution that breaks the file's syntax.
  test("the seeded owner follows github_username and the render stays valid JSON", () => {
    const tpl = readFileSync(
      join(import.meta.dir, "../../templates/release-please/release-please-config.json.jinja"),
      "utf-8",
    );
    const rendered = renderJinjaFile(
      tpl,
      { username: "OtherOwner", slug: "other-repo", copyrightHolder: "Other Owner" },
      {},
    );
    const packages = (JSON.parse(rendered) as { packages: Record<string, { $comment: string }> })
      .packages;
    expect(packages["."].$comment).toBe(
      "Seeded by OtherOwner/repo-platform; repo-owned after first render - edit freely",
    );
    expect(rendered).not.toContain("Vivswan");
  });
});

describe("answerMismatches", () => {
  test("passes when every answer matches its source", () => {
    expect(answerMismatches(answers, sources)).toEqual([]);
  });

  const without = (module: string) => new Set([...answers.modules].filter((m) => m !== module));
  /** The problem a deselected module's pair produces; the pair paths are
   *  hand-listed so a misclassified pair fails the row instead of being
   *  mirrored into it. */
  const orphaned = (repo: string, module: string) =>
    `modules: the generated pair ${repo} belongs to module '${module}', ` +
    "which the answers do not select";

  test.each([
    {
      reason: "a slug disagreeing with package.json AND the project_name derivation",
      override: { project_slug: "other" },
      expected: [
        'project_slug: expected "repo-platform" (package.json name), got "other"',
        'project_slug: expected "repo-platform" (copier.yml\'s derivation from project_name), got "other"',
      ],
    },
    {
      reason: "github_username drifted from the copier.yml default",
      override: { github_username: "X" },
      expected: [
        'github_username: expected "Vivswan" (copier.yml github_username default), got "X"',
      ],
    },
    {
      reason: "copyright_holder drifted from the copier.yml default",
      override: { copyright_holder: "X" },
      expected: [
        'copyright_holder: expected "Vivswan Shah" (copier.yml copyright_holder default), got "X"',
      ],
    },
    {
      reason: "description drifted from the in-repo settings file",
      override: { description: "X" },
      expected: [
        'description: expected "d" (.github/settings.yml repository.description), got "X"',
      ],
    },
    {
      reason: "private drifted from the in-repo settings file",
      override: { private: true },
      expected: ["private: expected false (.github/settings.yml repository.private), got true"],
    },
    {
      reason: "an unknown module",
      override: { modules: new Set([...answers.modules, "no"]) },
      expected: ["modules: 'no' has no templates/ module manifest"],
    },
    {
      reason: "a deselected module a pair needs",
      override: { modules: without("bun") },
      expected: [
        orphaned(".github/workflows/dependabot-bun-lockfile.yml", "bun"),
        orphaned(".bun-version", "bun"),
      ],
    },
    {
      reason: "skills_dir missing while the skills module is selected",
      override: { skills_dir: undefined },
      expected: [
        "skills_dir: missing - the skills module is selected, so the skills pairs need the directory copier.yml asks for",
      ],
    },
    {
      reason: "skills_dir set while the skills module is deselected (its pairs orphaned too)",
      override: { modules: without("skills") },
      expected: [
        "skills_dir: set but the skills module is not selected - copier never asks the question then; remove the stale answer",
        orphaned(".github/workflows/validate-skills.yml", "skills"),
      ],
    },
    {
      reason: "skills_dir drifted from the copier.yml default",
      override: { skills_dir: "lib/skills" },
      expected: ['skills_dir: expected "skills" (copier.yml skills_dir default), got "lib/skills"'],
    },
    {
      reason: "docs_site_label missing while the docs-site module is selected",
      override: { docs_site_label: undefined },
      expected: [
        "docs_site_label: missing - the docs-site module is selected, so the docs-site pair (and the operator settings facts) need the label copier.yml asks for",
      ],
    },
    {
      reason:
        "docs_site_label set while the docs-site module is deselected (its pair orphaned too)",
      override: { modules: without("docs-site") },
      expected: [
        "docs_site_label: set but the docs-site module is not selected - copier never asks the question then; remove the stale answer",
        orphaned(".github/workflows/docs-site.yml", "docs-site"),
      ],
    },
    {
      reason: "docs_site_label drifted from the copier.yml default",
      override: { docs_site_label: "other-label" },
      expected: [
        'docs_site_label: expected "docs-link-rot" (copier.yml docs_site_label default), got "other-label"',
      ],
    },
  ])("flags $reason", ({ override, expected }) => {
    expect(answerMismatches({ ...answers, ...override }, sources)).toEqual(expected);
  });
});
