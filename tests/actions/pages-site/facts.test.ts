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
  docsDir: "docs",
  defaultBranch: "main",
  ref: "HEAD",
  sha: "0123456789abcdef0123456789abcdef01234567",
  serverUrl: "https://github.com",
};

const EMPTY_FACTS: ProjectFacts = {
  repository: "fixture-owner/fixture-repo",
  repoUrl: "https://github.com/fixture-owner/fixture-repo",
  description: null,
  homepage: null,
  topics: [],
  toolchains: [],
  license: null,
  docsDir: "docs",
  provenance: {
    label: "main",
    sha: HEAD_INPUT.sha,
    url: `https://github.com/fixture-owner/fixture-repo/commit/${HEAD_INPUT.sha}`,
  },
  hue: 3,
};

const REGISTRATION = [
  "modules: [bun]",
  "project:",
  "  name: Fixture",
  "  slug: fixture-repo",
  "  description: A fixture repository",
  "",
].join("\n");

const IDENTITY_SETTINGS = [
  "repository:",
  "  description: A fixture repository",
  "  homepage: https://example.test/docs",
  "  topics: bun, docs ,, tooling",
  "",
].join("\n");

const SETTINGS = [
  "---",
  "repository:",
  "  description: Edited after the first render",
  "  homepage: docs.example.test",
  "  topics: settings, first",
  "  private: false",
  "",
].join("\n");

const FULL_TREE: Record<string, string> = {
  ".github/settings.yml": IDENTITY_SETTINGS,
  ".bun-version": "1.4.0\n",
  ".node-version": "v24.19.0\n",
  ".dvmrc": "2.9.5\n",
  ".python-version": "3.13\n",
  "rust-toolchain.toml": '[toolchain]\nchannel = "1.82.0"\ncomponents = ["clippy"]\n',
  "LICENSE.md":
    "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Individual and Small Organization License 1.1.0\n\nterms\n",
};

describe("collectFacts", () => {
  test("reads every fact from a fully populated tree", () => {
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

  test("falls back to the registration's description when there is no settings file", () => {
    const tree = treeOf({ ".repo-platform.yml": REGISTRATION, ".bun-version": "1.4.0" });
    expect(collectFacts(tree, HEAD_INPUT)).toEqual({
      ...EMPTY_FACTS,
      description: "A fixture repository",
      toolchains: [{ name: "Bun", version: "1.4.0" }],
    });
  });

  test("degrades every missing or unparsable file to null or empty", () => {
    expect(collectFacts(treeOf({}), HEAD_INPUT)).toEqual(EMPTY_FACTS);
    expect(
      collectFacts(
        treeOf({
          ".github/settings.yml": "- just\n- a list\n",
          ".repo-platform.yml": ": [",
        }),
        HEAD_INPUT,
      ),
    ).toEqual(EMPTY_FACTS);
  });

  test.each<[string, string, Record<string, string>, Partial<ProjectFacts>]>([
    [
      "settings.yml wins over the registration's description",
      SETTINGS,
      { ".repo-platform.yml": REGISTRATION },
      {
        description: "Edited after the first render",
        homepage: "https://docs.example.test",
        topics: ["settings", "first"],
      },
    ],
    [
      "a declared-empty description means empty, not the registration's value",
      "repository:\n  description: ''\n  homepage: ''\n  topics: ''\n",
      { ".repo-platform.yml": REGISTRATION },
      { description: null, homepage: null, topics: [] },
    ],
    [
      "a description the settings block lacks comes from the registration; homepage and topics never do",
      "repository:\n  private: true\n  topics: settings\n",
      { ".repo-platform.yml": REGISTRATION },
      { description: "A fixture repository", homepage: null, topics: ["settings"] },
    ],
    [
      "a YAML-list topics value, as the settings apply accepts",
      "repository:\n  topics: [bun, ' docs ', '', 7]\n",
      {},
      { topics: ["bun", "docs"] },
    ],
    [
      "a malformed settings.yml falls back to the registration's description",
      "repository: [",
      { ".repo-platform.yml": REGISTRATION },
      { description: "A fixture repository" },
    ],
    [
      "a settings.yml without a repository block falls back to the registration's description",
      "labels:\n  - name: docs\n",
      { ".repo-platform.yml": REGISTRATION },
      { description: "A fixture repository" },
    ],
    [
      "a registration without a project block adds nothing",
      "labels:\n  - name: docs\n",
      { ".repo-platform.yml": "modules: [bun]\n" },
      {},
    ],
    [
      "settings.yml alone, without a registration",
      SETTINGS,
      {},
      {
        description: "Edited after the first render",
        homepage: "https://docs.example.test",
        topics: ["settings", "first"],
      },
    ],
  ])("reads identity with %s", (_case, settings, registration, identity) => {
    const tree = treeOf({ ".github/settings.yml": settings, ...registration });
    expect(collectFacts(tree, HEAD_INPUT)).toEqual({ ...EMPTY_FACTS, ...identity });
  });

  test.each<[string, string, string]>([
    ["the default server", "https://github.com", "https://github.com"],
    ["an enterprise server", "https://ghe.example.test", "https://ghe.example.test"],
  ])("builds every link from %s", (_case, serverUrl, base) => {
    const facts = collectFacts(treeOf({}), { ...HEAD_INPUT, serverUrl });
    expect([facts.repoUrl, facts.provenance.url]).toEqual([
      `${base}/fixture-owner/fixture-repo`,
      `${base}/fixture-owner/fixture-repo/commit/${HEAD_INPUT.sha}`,
    ]);
  });

  test("carries the docs directory verbatim so the theme can prefix page paths", () => {
    const nested = collectFacts(treeOf({}), { ...HEAD_INPUT, docsDir: "site/manual" });
    expect(nested).toEqual({ ...EMPTY_FACTS, docsDir: "site/manual" });
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
  ])("splits the topics value %j into %j", (raw, topics) => {
    const settings = `repository:\n  topics: ${JSON.stringify(raw)}\n`;
    expect(collectFacts(treeOf({ ".github/settings.yml": settings }), HEAD_INPUT)).toEqual({
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
    ["a bare email", "hello@example.com", null],
    [
      "a host with a query holding an email",
      "example.com?email=hello@example.com",
      "https://example.com?email=hello@example.com",
    ],
    ["a host with a port and path", "example.com:8080/docs", "https://example.com:8080/docs"],
    ["localhost with a port", "localhost:3000", "https://localhost:3000"],
    ["a word", "homepage", null],
    ["words", "see the docs", null],
    ["an unknown scheme", "ftp://example.com", null],
    ["a scheme without slashes", "mailto:hello@example.com", null],
    ["a scheme alone", "https://", null],
    ["an http scheme alone", "http://", null],
    ["a URL with a space in the host", "https://exa mple.com", null],
    ["a URL with a path", "https://example.com/docs", "https://example.com/docs"],
    ["blank", "  ", null],
  ])("normalizes the homepage value %s", (_case, raw, homepage) => {
    const settings = `repository:\n  homepage: ${JSON.stringify(raw)}\n`;
    expect(collectFacts(treeOf({ ".github/settings.yml": settings }), HEAD_INPUT)).toEqual({
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
    ["unparsable TOML", "[toolchain\nchannel = \n", []],
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
      "a custom heading directly over a body whose next paragraph starts with a known name",
      "# Private Use License\nCustom terms\n\nMIT License permissions do not apply.\n",
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
    [
      "GitHub's CC0 form, titled under a publisher banner",
      "Creative Commons Legal Code\n\nCC0 1.0 Universal\n\n    CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM\n",
      "CC0",
    ],
    [
      "a banner over a known name in the body only",
      "Legal Code\n\nTerms of the MIT License\n",
      "See LICENSE.md",
    ],
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
