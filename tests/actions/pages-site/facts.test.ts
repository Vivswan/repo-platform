import { describe, expect, test } from "bun:test";
import { HUES } from "../../../actions/pages-site/.vitepress/theme/tokens.ts";
import {
  collectFacts,
  type DetectedLicense,
  detectedLicense,
  type FactsReader,
  hueOf,
  type ProjectFacts,
} from "../../../actions/pages-site/facts.ts";
import type { RunResult } from "../../../actions/shared/action_runtime.ts";

// An enterprise server, so a link built from a github.com literal is red; an owner whose hash differs
// from the bare name's, so a hue hashed from owner/name is red (the accent is the repository's alone).

const HEAD_INPUT = {
  repository: "fixture-org/fixture-repo",
  docsDir: "docs",
  defaultBranch: "main",
  ref: "HEAD",
  sha: "0123456789abcdef0123456789abcdef01234567",
  serverUrl: "https://ghe.example.test",
  license: null,
};

const WHAT = "fixture-org/fixture-repo at 0123456";

const NOT_FOUND_BODY = JSON.stringify({
  message: "Not Found",
  documentation_url:
    "https://docs.github.com/rest/licenses/licenses#get-the-license-for-a-repository",
  status: "404",
});

function answered(
  path: string,
  license: { key: string; spdx_id: string | null } | null,
): RunResult {
  const body = { name: path, path, sha: "0".repeat(40), encoding: "base64", content: "", license };
  return { exit: { kind: "exited", code: 0 }, stdout: JSON.stringify(body), stderr: "" };
}

function refused(stdout: string, stderr: string): RunResult {
  return { exit: { kind: "exited", code: 1 }, stdout, stderr };
}

const EMPTY_FACTS: ProjectFacts = {
  repository: "fixture-org/fixture-repo",
  repoUrl: "https://ghe.example.test/fixture-org/fixture-repo",
  description: null,
  homepage: null,
  topics: [],
  toolchains: [],
  license: null,
  docsDir: "docs",
  provenance: {
    label: "main",
    sha: HEAD_INPUT.sha,
    url: `https://ghe.example.test/fixture-org/fixture-repo/commit/${HEAD_INPUT.sha}`,
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
  ".python-version": "3.13\n",
  "rust-toolchain.toml": '[toolchain]\nchannel = "1.82.0"\ncomponents = ["clippy"]\n',
  "LICENSE.md":
    "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Individual and Small Organization License 1.1.0\n\nterms\n",
};

function treeOf(files: Record<string, string>): FactsReader {
  return (path) => files[path] ?? null;
}

describe("collectFacts", () => {
  // The toolchain file roster is a fleet convention no file declares, and the `v` prefix is dropped in one place.
  test("reads every fact from a fully populated tree", () => {
    const input = { ...HEAD_INPUT, license: { path: "LICENSE.md", spdxId: null } };
    expect(collectFacts(treeOf(FULL_TREE), input)).toEqual({
      ...EMPTY_FACTS,
      description: "A fixture repository",
      homepage: "https://example.test/docs",
      topics: ["bun", "docs", "tooling"],
      toolchains: [
        { name: "Bun", version: "1.4.0" },
        { name: "Node.js", version: "24.19.0" },
        { name: "Python", version: "3.13" },
        { name: "Rust", version: "1.82.0" },
      ],
      license: { name: "Individual and Small Organization License 1.1.0", path: "LICENSE.md" },
    });
  });

  // The shapes the settings apply accepts (topics as one string or a YAML list, an empty string as unset)
  // live in github-settings-as-code; this is the only pin that the facts reader reads them the same way.
  test.each<[string, string | null, Partial<ProjectFacts>]>([
    [
      "every identity key declared",
      SETTINGS,
      {
        description: "Edited after the first render",
        homepage: "https://docs.example.test",
        topics: ["settings", "first"],
      },
    ],
    [
      "every identity key declared empty",
      "repository:\n  description: ''\n  homepage: ''\n  topics: ''\n",
      { description: null, homepage: null, topics: [] },
    ],
    [
      "a repository block without the description key",
      "repository:\n  private: true\n  topics: settings\n",
      { description: null, homepage: null, topics: ["settings"] },
    ],
    [
      "a YAML-list topics value, as the settings apply accepts",
      "repository:\n  topics: [bun, ' docs ', '', 7]\n",
      { topics: ["bun", "docs"] },
    ],
    ["a whitespace-only topics value", "repository:\n  topics: '   '\n", { topics: [] }],
    ["a malformed settings.yml", "repository: [", {}],
    ["a settings.yml without a repository block", "labels:\n  - name: docs\n", {}],
    ["a settings.yml that is a list", "- just\n- a list\n", {}],
    ["no settings.yml", null, {}],
  ])("reads identity with %s", (_case, settings, identity) => {
    const tree = treeOf({
      ...(settings === null ? {} : { ".github/settings.yml": settings }),
      ".repo-platform.yml": REGISTRATION,
    });
    expect(collectFacts(tree, HEAD_INPUT)).toEqual({ ...EMPTY_FACTS, ...identity });
  });

  // build.ts passes ref "HEAD" for the default-branch tier; the label must read the branch then, not the literal.
  test("labels provenance by the default branch for HEAD and by the tag otherwise", () => {
    const tagged = {
      ...HEAD_INPUT,
      ref: "v1.2.0",
      sha: "fedcba9876543210fedcba9876543210fedcba98",
    };
    expect(collectFacts(treeOf({}), tagged).provenance).toEqual({
      label: "v1.2.0",
      sha: tagged.sha,
      url: `https://ghe.example.test/fixture-org/fixture-repo/commit/${tagged.sha}`,
    });
    expect(
      collectFacts(treeOf({}), { ...HEAD_INPUT, defaultBranch: "trunk" }).provenance.label,
    ).toBe("trunk");
  });

  // GitHub's homepage field has no validator; these are the forms owners type.
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

  // rustup's accepted TOML shapes (dotted key, inline table) are external; the degrade rows are the never-fail-a-build contract.
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

  // GitHub's answer outranks the file's own words, and names the file the card links. A text GitHub matches to
  // nothing keeps its own heading, which is how a custom license is titled.
  test.each<[string, DetectedLicense | null, string, ProjectFacts["license"]]>([
    [
      "a detected license in the file GitHub picked, under a heading that says otherwise",
      { path: "COPYING", spdxId: "GPL-2.0" },
      "# Our License\n\nterms\n",
      { name: "GPL-2.0", path: "COPYING" },
    ],
    [
      "an undetected text with a heading",
      { path: "LICENSE.md", spdxId: null },
      "<!-- BEGIN REPO-PLATFORM MANAGED -->\n# Individual and Small Organization License 1.1.0\n\nterms\n",
      { name: "Individual and Small Organization License 1.1.0", path: "LICENSE.md" },
    ],
    [
      "an undetected text with a setext heading",
      { path: "LICENSE.md", spdxId: null },
      "Private Use License\n===================\n\nterms\n",
      { name: "Private Use License", path: "LICENSE.md" },
    ],
    [
      "an undetected text with a closed, indented heading",
      { path: "LICENSE.md", spdxId: null },
      "   # License for C# ##\n",
      { name: "License for C#", path: "LICENSE.md" },
    ],
    [
      "an undetected text with no heading",
      { path: "COPYING", spdxId: null },
      "All rights reserved. Ask before use.\n",
      { name: "See COPYING", path: "COPYING" },
    ],
    ["a license file GitHub did not detect", null, "MIT License\n", null],
  ])("names the license for %s", (_case, detected, text, license) => {
    const tree = treeOf(detected === null ? { "LICENSE.md": text } : { [detected.path]: text });
    expect(collectFacts(tree, { ...HEAD_INPUT, license: detected }).license).toEqual(license);
  });
});

describe("detectedLicense", () => {
  // The answer's shape is GitHub's: "other" with NOASSERTION for a text it cannot match, and 404 for no license file.
  // Every body here is hand-written to the shapes docs.github.com gives for the endpoint and for an error.
  test.each<[string, RunResult, DetectedLicense | null]>([
    [
      "a matched license",
      answered("LICENSE.md", { key: "agpl-3.0", spdx_id: "AGPL-3.0" }),
      { path: "LICENSE.md", spdxId: "AGPL-3.0" },
    ],
    [
      "a text matching no license",
      answered("COPYING", { key: "other", spdx_id: "NOASSERTION" }),
      { path: "COPYING", spdxId: null },
    ],
    [
      "a license object without an SPDX id",
      answered("LICENSE.md", { key: "other", spdx_id: null }),
      { path: "LICENSE.md", spdxId: null },
    ],
    ["a null license object", answered("LICENSE.md", null), { path: "LICENSE.md", spdxId: null }],
    ["no license file", refused(NOT_FOUND_BODY, "gh: Not Found (HTTP 404)\n"), null],
  ])("reads %s", (_case, answer, detected) => {
    expect(detectedLicense(answer, WHAT)).toEqual(detected);
  });

  // A failed read that passed as "no license" would publish a card with the row silently gone.
  test.each<[string, RunResult, string]>([
    [
      "a rate limit",
      refused(
        JSON.stringify({ message: "API rate limit exceeded", status: "403" }),
        "gh: API rate limit exceeded (HTTP 403)\n",
      ),
      `cannot read the license of ${WHAT} from GitHub (gh: API rate limit exceeded (HTTP 403))`,
    ],
    [
      "a server error with no body",
      refused("", "gh: HTTP 502\n"),
      `cannot read the license of ${WHAT} from GitHub (gh: HTTP 502)`,
    ],
    [
      "a missing token",
      refused(
        "",
        "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n",
      ),
      `cannot read the license of ${WHAT} from GitHub (gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.)`,
    ],
    [
      "a success that is not the license shape",
      { exit: { kind: "exited", code: 0 }, stdout: NOT_FOUND_BODY, stderr: "" },
      `GitHub's license answer for ${WHAT} has an unexpected shape`,
    ],
    [
      "a success that is not JSON",
      { exit: { kind: "exited", code: 0 }, stdout: "<html>", stderr: "" },
      `GitHub's license answer for ${WHAT} has an unexpected shape`,
    ],
  ])("refuses %s", (_case, answer, message) => {
    expect(() => detectedLicense(answer, WHAT)).toThrow(new Error(message));
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

  // mermaid-render reads `HUES[slot] ?? HUES[0]`, so a slot past the table silently falls to slot 0.
  test("covers every hue slot of the theme's table and none past it", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const hue = hueOf(`repo-${i}`);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(HUES.length);
      expect(Number.isInteger(hue)).toBe(true);
      seen.add(hue);
    }
    expect(seen.size).toBe(HUES.length);
  });
});
