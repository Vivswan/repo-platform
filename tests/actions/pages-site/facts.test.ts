import { describe, expect, test } from "bun:test";
import {
  collectFacts,
  type FactsReader,
  hueOf,
  type ProjectFacts,
} from "../../../actions/pages-site/facts.ts";

const treeOf =
  (files: Record<string, string>): FactsReader =>
  (path) =>
    files[path] ?? null;

const HEAD_INPUT = {
  repository: "fixture-owner/fixture-repo",
  defaultBranch: "main",
  ref: "HEAD",
  sha: "0123456789abcdef0123456789abcdef01234567",
};

const EMPTY_FACTS: ProjectFacts = {
  repository: "fixture-owner/fixture-repo",
  repoUrl: "https://github.com/fixture-owner/fixture-repo",
  name: "fixture-repo",
  description: null,
  homepage: null,
  topics: [],
  toolchains: [],
  license: null,
  provenance: {
    label: "main",
    sha: HEAD_INPUT.sha,
    url: `https://github.com/fixture-owner/fixture-repo/commit/${HEAD_INPUT.sha}`,
  },
  hue: 3,
};

const COPIER_ANSWERS = [
  "# This file is managed by Vivswan/repo-platform.",
  "_commit: xxxxxxxx",
  "_src_path: ./tree",
  "description: A fixture repository",
  "homepage: https://example.test/docs",
  "topics: bun, docs ,, tooling",
  "project_name: Fixture",
  "",
].join("\n");

const OPERATOR_ANSWERS = [
  "project_name: repo-platform",
  "description: The operator's own answers",
  "private: false",
  "modules:",
  "  - bun",
  "",
].join("\n");

const FULL_TREE: Record<string, string> = {
  ".github/.copier-answers.yml": COPIER_ANSWERS,
  ".bun-version": "1.4.0\n",
  ".node-version": "v24.19.0\n",
  ".dvmrc": "2.9.5\n",
  ".python-version": "3.13\n",
  "rust-toolchain.toml": '[toolchain]\nchannel = "1.82.0"\ncomponents = ["clippy"]\n',
  "LICENSE.md":
    "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Individual and Small Organization License 1.1.0\n\nterms\n",
};

describe("collectFacts", () => {
  test("reads every fact from a fully populated copier-managed tree", () => {
    expect(collectFacts(treeOf(FULL_TREE), HEAD_INPUT)).toEqual({
      ...EMPTY_FACTS,
      description: "A fixture repository",
      homepage: "https://example.test/docs",
      topics: ["bun", "docs", "tooling"],
      toolchains: [
        { name: "Bun", version: "1.4.0" },
        { name: "Node.js", version: "24.19.0" },
        { name: "Deno", version: "2.9.5" },
        { name: "Python", version: "3.13" },
        { name: "Rust", version: "1.82.0" },
      ],
      license: { name: "Individual and Small Organization License 1.1.0", path: "LICENSE.md" },
    });
  });

  test("falls back to the operator's answers file when the copier one is absent", () => {
    const tree = treeOf({
      ".repo-platform-answers.yml": OPERATOR_ANSWERS,
      ".bun-version": "1.4.0",
    });
    expect(collectFacts(tree, HEAD_INPUT)).toEqual({
      ...EMPTY_FACTS,
      description: "The operator's own answers",
      toolchains: [{ name: "Bun", version: "1.4.0" }],
    });
  });

  test("degrades every missing or unparseable file to null or empty", () => {
    expect(collectFacts(treeOf({}), HEAD_INPUT)).toEqual(EMPTY_FACTS);
    expect(
      collectFacts(
        treeOf({
          ".github/.copier-answers.yml": "- just\n- a list\n",
          ".repo-platform-answers.yml": ": [",
        }),
        HEAD_INPUT,
      ),
    ).toEqual(EMPTY_FACTS);
  });

  test("labels provenance by the default branch for HEAD and by the tag otherwise", () => {
    const tagged = {
      ...HEAD_INPUT,
      ref: "v1.2.0",
      sha: "fedcba9876543210fedcba9876543210fedcba98",
    };
    expect(collectFacts(treeOf({}), tagged).provenance).toEqual({
      label: "v1.2.0",
      sha: tagged.sha,
      url: `https://github.com/fixture-owner/fixture-repo/commit/${tagged.sha}`,
    });
    expect(
      collectFacts(treeOf({}), { ...HEAD_INPUT, defaultBranch: "trunk" }).provenance.label,
    ).toBe("trunk");
  });

  test.each<[string, string[]]>([
    ["", []],
    ["   ", []],
    ["bun", ["bun"]],
    [" bun , docs,,tooling ", ["bun", "docs", "tooling"]],
  ])("splits the topics answer %j into %j", (raw, topics) => {
    const answers = `description: ''\nhomepage: ''\ntopics: ${JSON.stringify(raw)}\n`;
    expect(collectFacts(treeOf({ ".github/.copier-answers.yml": answers }), HEAD_INPUT)).toEqual({
      ...EMPTY_FACTS,
      topics,
    });
  });

  test.each<[string, string, string | null]>([
    ["a full URL", "https://example.test/docs/", "https://example.test/docs/"],
    ["an http URL", "http://example.test", "http://example.test"],
    ["a bare host", "example.com", "https://example.com"],
    ["a host with a path", "docs.example.com/guide", "https://docs.example.com/guide"],
    ["a slash before the first dot", "docs/example.com", null],
    ["a word", "homepage", null],
    ["words", "see the docs", null],
    ["an unknown scheme", "ftp://example.com", null],
    ["a scheme without slashes", "mailto:hello@example.com", null],
    ["blank", "  ", null],
  ])("normalizes the homepage answer %s", (_case, raw, homepage) => {
    const answers = `description: ''\nhomepage: ${JSON.stringify(raw)}\ntopics: ''\n`;
    expect(collectFacts(treeOf({ ".github/.copier-answers.yml": answers }), HEAD_INPUT)).toEqual({
      ...EMPTY_FACTS,
      homepage,
    });
  });

  test.each<[string, string, ProjectFacts["toolchains"]]>([
    [
      "a stable channel",
      '[toolchain]\nchannel = "stable"\n',
      [{ name: "Rust", version: "stable" }],
    ],
    [
      "a single-quoted pin",
      "[toolchain]\nchannel = '1.82.0'\n",
      [{ name: "Rust", version: "1.82.0" }],
    ],
    ["a dotted key", 'toolchain.channel = "stable"\n', [{ name: "Rust", version: "stable" }]],
    [
      "an inline table",
      'toolchain = { channel = "nightly" }\n',
      [{ name: "Rust", version: "nightly" }],
    ],
    ["no channel key", '[toolchain]\ncomponents = ["clippy"]\n', []],
    ["unparseable TOML", "[toolchain\nchannel = \n", []],
  ])("reads rust-toolchain.toml with %s", (_case, toml, toolchains) => {
    expect(collectFacts(treeOf({ "rust-toolchain.toml": toml }), HEAD_INPUT).toolchains).toEqual(
      toolchains,
    );
  });

  test.each<[string, string, string]>([
    [
      "a heading over a custom license",
      "# Individual and Small Organization License 1.1.0\n\nterms\n",
      "Individual and Small Organization License 1.1.0",
    ],
    ["an H2 heading", "## Private Use License\n\nterms\n", "Private Use License"],
    [
      "an indented heading with a closing sequence",
      "   # Private Use License ##\n",
      "Private Use License",
    ],
    ["a heading ending in a hash", "# License for C#\n\nterms\n", "License for C#"],
    [
      "a setext heading",
      "Private Use License\n===================\n\nterms\n",
      "Private Use License",
    ],
    ["a heading over a known license", "# MIT License\n\nCopyright (c) 2026\n", "MIT"],
    ["a The-prefixed heading", "# The MIT License (MIT)\n\nCopyright (c) 2026\n", "MIT"],
    ["an Apache 2.0 heading", "# Apache License 2.0\n\nTERMS AND CONDITIONS\n", "Apache-2.0"],
    [
      "a heading that only mentions a known name",
      "# Not the MIT License\n\nCustom terms\n",
      "Not the MIT License",
    ],
    [
      "a custom heading over a body that mentions a known name",
      "# Private Use License\n\nUnlike the MIT License, this grants nothing.\n",
      "Private Use License",
    ],
    [
      "no heading and a known name only in the body",
      "Custom terms.\n\nUnlike the MIT License, this grants nothing.\n",
      "See LICENSE.md",
    ],
    ["plain-text MIT", "MIT License\n\nCopyright (c) 2026 Someone\n", "MIT"],
    [
      "Apache's centered header",
      "                                 Apache License\n                           Version 2.0, January 2004\n",
      "Apache-2.0",
    ],
    [
      "GPL-3.0's header",
      "                    GNU GENERAL PUBLIC LICENSE\n                       Version 3, 29 June 2007\n",
      "GPL-3.0",
    ],
    ["BSD 3-Clause", "BSD 3-Clause License\n\nCopyright (c) 2026\n", "BSD-3-Clause"],
    [
      "MPL-2.0",
      "Mozilla Public License Version 2.0\n==================================\n",
      "MPL-2.0",
    ],
    ["CC0", "CC0 1.0 Universal\n\nStatement of Purpose\n", "CC0"],
    ["no heading and no known name", "All rights reserved. Ask before use.\n", "See LICENSE.md"],
    ["a known name past the head", `${"\n".repeat(30)}MIT License\n`, "See LICENSE.md"],
  ])("names the license from %s", (_case, text, name) => {
    expect(collectFacts(treeOf({ "LICENSE.md": text }), HEAD_INPUT).license).toEqual({
      name,
      path: "LICENSE.md",
    });
  });
});

describe("hueOf", () => {
  // Pinned values: a repository keeps its accent across theme releases,
  // so a hash change here is a visible fleet-wide recolor, not a refactor.
  test.each<[string, number]>([
    ["repo-platform", 5],
    ["golden-render", 3],
    ["fixture-repo", 3],
    ["a", 4],
    ["", 1],
    ["étude", 5],
  ])("hashes %j to hue %i, deterministically", (name, hue) => {
    expect(hueOf(name)).toBe(hue);
    expect(hueOf(name)).toBe(hueOf(name));
  });

  test("covers every hue and stays within 0..5", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const hue = hueOf(`repo-${i}`);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(5);
      expect(Number.isInteger(hue)).toBe(true);
      seen.add(hue);
    }
    expect(seen.size).toBe(6);
  });
});
