// Unit tests for render_dogfood's pure helpers: the answers-file parsing,
// the copier-computed context derivations, the filename gates, and the
// cross-checks anchoring each answer to its authoritative source. The
// renderer itself runs against the live repo (bun run dogfood:check
// exercises every pair).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  modules: new Set(["agents", "bun", "release-please", "pr-title", "auto-assign"]),
};

const manifests: ModuleManifest[] = [
  { module: "agents", description: "a" },
  { module: "bun", description: "b", toolchain: { codeql_language: "javascript-typescript" } },
  { module: "uv", description: "u", toolchain: { codeql_language: "python" } },
  { module: "release-please", description: "r" },
  { module: "pr-title", description: "p" },
  { module: "auto-assign", description: "aa" },
];

const sources: AnswerSources = {
  packageName: "repo-platform",
  usernameDefault: "Vivswan",
  copyrightDefault: "Vivswan Shah",
  centralDescription: "d",
  centralPrivate: false,
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

  test("parses a complete answers document into a module set", () => {
    const text = [...lines, "modules: [bun, uv]"].join("\n");
    expect(parseAnswers(text, "f").project_slug).toBe("x-y");
    expect(parseAnswers(text, "f").private).toBe(true);
    expect([...parseAnswers(text, "f").modules].sort()).toEqual(["bun", "uv"]);
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

  test("renderContext carries the computed variables and both membership keys", () => {
    const context = renderContext(answers, manifests);
    expect(context.private).toBe(false);
    expect(context.has_toolchain).toBe(true);
    expect(context.enable_codeql).toBe(true);
    expect(context["'bun' in modules"]).toBe(true);
    expect(context["'bun' not in modules"]).toBe(false);
    expect(context["'uv' in modules"]).toBe(false);
    expect(context["'uv' not in modules"]).toBe(true);
    expect(Object.keys(context)).toHaveLength(3 + 2 * manifests.length);
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
    const tpl = "templates/base/{% if not private %}CODE_OF_CONDUCT.md{% endif %}.jinja";
    expect(gateOfPair(tpl)).toEqual({ kind: "when", condition: "not private" });
    expect(pairIsRendered(tpl, { private: false })).toBe(true);
    expect(pairIsRendered(tpl, { private: true })).toBe(false);
  });

  test("an unresolvable gate condition fails loudly", () => {
    const tpl = "templates/base/{% if mystery %}X{% endif %}.jinja";
    expect(() => pairIsRendered(tpl, {})).toThrow("does not resolve");
  });
});

describe("answerMismatches", () => {
  test("passes when every answer matches its source", () => {
    expect(answerMismatches(answers, sources)).toEqual([]);
  });

  test("flags a slug that disagrees with package.json or project_name", () => {
    const drift = answerMismatches({ ...answers, project_slug: "other" }, sources);
    expect(drift.some((p) => p.includes("package.json name"))).toBe(true);
    expect(drift.some((p) => p.includes("derivation from project_name"))).toBe(true);
  });

  test("flags identity answers that drifted from copier.yml defaults", () => {
    expect(answerMismatches({ ...answers, github_username: "X" }, sources)).toHaveLength(1);
    expect(answerMismatches({ ...answers, copyright_holder: "X" }, sources)).toHaveLength(1);
  });

  test("flags description/private drift from the central settings file", () => {
    expect(answerMismatches({ ...answers, description: "X" }, sources)).toHaveLength(1);
    expect(answerMismatches({ ...answers, private: true }, sources)).toHaveLength(1);
  });

  test("flags an unknown module and a deselected module a pair needs", () => {
    const unknown = answerMismatches(
      { ...answers, modules: new Set([...answers.modules, "no"]) },
      sources,
    );
    expect(unknown.some((p) => p.includes("'no' has no templates/"))).toBe(true);
    const withoutBun = new Set([...answers.modules].filter((m) => m !== "bun"));
    const missing = answerMismatches({ ...answers, modules: withoutBun }, sources);
    expect(missing.some((p) => p.includes("dependabot-bun-lockfile.yml"))).toBe(true);
  });
});
