// Unit tests for the one-time settings.yml layering transition: the
// starter render from an identity seed, the dropped-overrides diff
// against the managed layer, and the end-to-end replacement (legacy
// marker triggers it once; hand-written and already-transitioned files
// are never touched; failures leave the old file for the next sync).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  droppedOverrides,
  type IdentitySeed,
  isLegacyBaseline,
  LEGACY_MERGEABLE_LINE,
  layeringSummary,
  renderStarter,
  transitionSettingsStarter,
} from "../../.github/scripts/sync/settings_layering";

const STARTER_TEMPLATE = readFileSync(
  join(import.meta.dir, "../../templates/settings-sync/.github/settings.yml.jinja"),
  "utf-8",
);

const seed: IdentitySeed = {
  description: "A test repo",
  homepage: "https://example.test",
  topics: "a, b",
  private: false,
  githubUsername: "Vivswan",
};

describe("isLegacyBaseline", () => {
  test("matches the marker exactly at column 0 within the header window", () => {
    expect(isLegacyBaseline(`---\n${LEGACY_MERGEABLE_LINE}\nrepository: {}\n`)).toBe(true);
    // Line 10 (index 9) is the last line inside the window; line 11 is out.
    expect(isLegacyBaseline(`${"# filler\n".repeat(9)}${LEGACY_MERGEABLE_LINE}\n`)).toBe(true);
    expect(isLegacyBaseline(`${"# filler\n".repeat(10)}${LEGACY_MERGEABLE_LINE}\n`)).toBe(false);
  });

  test("an indented mention (a block scalar of a hand-written file) never triggers", () => {
    expect(isLegacyBaseline(`repository:\n  description: |\n    ${LEGACY_MERGEABLE_LINE}\n`)).toBe(
      false,
    );
    expect(isLegacyBaseline(`see the ${LEGACY_MERGEABLE_LINE} marker\n`)).toBe(false);
  });
});

describe("renderStarter", () => {
  test("substitutes the four identity expressions and parses as YAML", () => {
    const rendered = renderStarter(STARTER_TEMPLATE, seed);
    const doc = parseYaml(rendered) as { repository: Record<string, unknown> };
    expect(doc.repository).toEqual({
      description: "A test repo",
      homepage: "https://example.test",
      topics: "a, b",
      private: false,
    });
    expect(rendered).not.toContain(LEGACY_MERGEABLE_LINE);
  });

  test("an undefined optional key drops its line instead of declaring empty", () => {
    const rendered = renderStarter(STARTER_TEMPLATE, {
      ...seed,
      homepage: undefined,
      topics: undefined,
    });
    const doc = parseYaml(rendered) as { repository: Record<string, unknown> };
    expect("homepage" in doc.repository).toBe(false);
    expect("topics" in doc.repository).toBe(false);
    expect(doc.repository.description).toBe("A test repo");
  });

  test("a template construct beyond the identity expressions throws", () => {
    expect(() => renderStarter("{% if private %}x{% endif %}\n", seed)).toThrow(
      "teach settings_layering.ts",
    );
    expect(() => renderStarter("{{ project_slug | tojson }}\n", seed)).toThrow(
      "teach settings_layering.ts",
    );
  });
});

describe("droppedOverrides", () => {
  const managed = {
    repository: { has_issues: true, security_and_analysis: { a: 1 } },
    labels: [
      { name: "bug", color: "d73a4a", description: "Something isn't working" },
      { name: "dependencies", color: "0366d6", description: "Dependency updates" },
    ],
    rulesets: [{ name: "main", target: "branch" }],
  };

  test("baseline-equal declarations and identity keys are not dropped", () => {
    const old = {
      repository: {
        description: "x",
        homepage: "",
        topics: "",
        private: false,
        has_issues: true,
        security_and_analysis: { a: 1 },
      },
      labels: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }],
      rulesets: [{ name: "main", target: "branch" }],
    };
    expect(droppedOverrides(old, managed)).toEqual([]);
  });

  test("differing and repo-only declarations are dropped and listed", () => {
    const old = {
      repository: { has_issues: false, has_extras: true },
      labels: [
        { name: "BUG", color: "000000", description: "restyled" },
        { name: "incident", color: "b60205", description: "live incident" },
      ],
      rulesets: [{ name: "release-tags", target: "tag" }],
      pages: { cname: "x" },
    };
    expect(droppedOverrides(old, managed)).toEqual([
      "repository.has_issues",
      "repository.has_extras",
      'labels "BUG"',
      'labels "incident"',
      'rulesets "release-tags"',
      "pages",
    ]);
  });

  test("label matching folds case; ruleset matching is exact", () => {
    const equalDespiteCase = {
      labels: [{ name: "BUG", color: "d73a4a", description: "Something isn't working" }],
    };
    // The tuple differs from the baseline entry (the name spelling is part
    // of the tuple), so it is listed even though the names fold together.
    expect(droppedOverrides(equalDespiteCase, managed)).toEqual(['labels "BUG"']);
    expect(droppedOverrides({ rulesets: [{ name: "MAIN", target: "branch" }] }, managed)).toEqual([
      'rulesets "MAIN"',
    ]);
  });
});

describe("layeringSummary", () => {
  test("empty when nothing was dropped", () => {
    expect(layeringSummary([])).toBe("");
  });

  test("lists the dropped keys and tells the reviewer what to do", () => {
    const summary = layeringSummary(['labels "incident"', "pages"]);
    expect(summary).toContain("### settings.yml layering transition");
    expect(summary).toContain('- labels "incident"');
    expect(summary).toContain("- pages");
    expect(summary).toContain("before merging");
  });
});

describe("transitionSettingsStarter", () => {
  function target(options: { settings?: string; modules?: string; answers?: string }): {
    dir: string;
    out: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "settings-layering-"));
    mkdirSync(join(dir, ".github"), { recursive: true });
    if (options.settings !== undefined) {
      writeFileSync(join(dir, ".github/settings.yml"), options.settings);
    }
    if (options.modules !== undefined) {
      writeFileSync(join(dir, ".repo-platform.yml"), options.modules);
    }
    if (options.answers !== undefined) {
      writeFileSync(join(dir, ".copier-answers.yml"), options.answers);
    }
    return { dir, out: join(dir, "settings-layering.md") };
  }

  const legacySettings = [
    "---",
    "# Rendered by the settings-sync module.",
    LEGACY_MERGEABLE_LINE,
    "repository:",
    "  description: Old declared description",
    '  homepage: ""',
    "  topics: kept, custom, topics",
    "  private: false",
    "  has_issues: true",
    "labels:",
    "  - name: extra-label",
    '    color: "0e8a16"',
    "    description: A deliberate repo label",
    "",
  ].join("\n");
  const answers = [
    "description: Live description",
    "private: false",
    'homepage: ""',
    'topics: ""',
    "github_username: Vivswan",
    "",
  ].join("\n");

  test("replaces a legacy file with the identity starter and lists the drops", () => {
    const { dir, out } = target({
      settings: legacySettings,
      modules: "modules: [uv, settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    const replaced = readFileSync(join(dir, ".github/settings.yml"), "utf-8");
    expect(replaced).not.toContain(LEGACY_MERGEABLE_LINE);
    const doc = parseYaml(replaced) as { repository: Record<string, unknown> };
    // description/private from the post-update answers (the live values);
    // homepage/topics from the old file's own declarations.
    expect(doc.repository.description).toBe("Live description");
    expect(doc.repository.topics).toBe("kept, custom, topics");
    expect(doc.repository.private).toBe(false);
    const section = readFileSync(out, "utf-8");
    expect(section).toContain('- labels "extra-label"');
    // Identity keys and baseline-equal declarations are never listed.
    expect(section).not.toContain("repository.description");
    expect(section).not.toContain("repository.has_issues");
  });

  test("a lossless transition still replaces but writes no section", () => {
    const lossless = legacySettings.replace(
      /labels:[\s\S]*$/,
      "labels:\n  - name: dependencies\n" +
        '    color: "0366d6"\n' +
        "    description: Dependency updates\n",
    );
    const { dir, out } = target({
      settings: lossless,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).not.toContain(
      LEGACY_MERGEABLE_LINE,
    );
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  test("a marker-less file (hand-written or already transitioned) is never touched", () => {
    const handWritten = "repository:\n  description: mine\n";
    const { dir, out } = target({
      settings: handWritten,
      modules: "modules: [settings-sync]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toBe(handWritten);
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  test("a repo without the settings-sync module keeps its legacy file", () => {
    const { dir, out } = target({
      settings: legacySettings,
      modules: "modules: [uv]\n",
      answers,
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toBe(legacySettings);
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  test("fail-soft: a broken answers file leaves the old file for the next sync", () => {
    const { dir, out } = target({
      settings: legacySettings,
      modules: "modules: [settings-sync]\n",
      answers: ": broken\n",
    });
    transitionSettingsStarter(dir, out, "t");
    expect(readFileSync(join(dir, ".github/settings.yml"), "utf-8")).toBe(legacySettings);
    expect(readFileSync(out, "utf-8")).toBe("");
  });

  test("a target without settings.yml writes an empty section and touches nothing", () => {
    const { dir, out } = target({ modules: "modules: [settings-sync]\n", answers });
    transitionSettingsStarter(dir, out, "t");
    expect(existsSync(join(dir, ".github/settings.yml"))).toBe(false);
    expect(readFileSync(out, "utf-8")).toBe("");
  });
});
