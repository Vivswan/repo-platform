// Unit tests for the shared ownership classifier: filename-gate stripping,
// the starter/split/managed classification (including the header-on-starter
// contradiction and the .gitignore split grammar), and the marker-form
// fidelity the ownership manifest depends on.

import { describe, expect, test } from "bun:test";
import {
  classifyTemplateSource,
  landedPathAndGates,
  skipIfExistsMatchers,
} from "../../scripts/ownership";

const SKIP = skipIfExistsMatchers(
  ["_skip_if_exists:", "  - .github/workflows/checks.yml", "  - .github/ISSUE_TEMPLATE/*.yml"].join(
    "\n",
  ),
);

describe("landedPathAndGates", () => {
  test("passes ungated paths through with no gates", () => {
    expect(landedPathAndGates(".github/workflows/ci.yml")).toEqual({
      path: ".github/workflows/ci.yml",
      gates: [],
    });
  });

  test("strips a filename gate and collects its condition", () => {
    expect(landedPathAndGates("{% if not private %}CONTRIBUTING.md{% endif %}")).toEqual({
      path: "CONTRIBUTING.md",
      gates: ["not private"],
    });
  });

  test("collects gates from every path segment in order", () => {
    expect(
      landedPathAndGates("{% if 'a' in modules %}dir{% endif %}/{% if not private %}f{% endif %}"),
    ).toEqual({ path: "dir/f", gates: ["'a' in modules", "not private"] });
  });
});

describe("classifyTemplateSource", () => {
  test("skip-listed paths are starters", () => {
    const { ownership } = classifyTemplateSource(
      ".github/workflows/checks.yml",
      "name: Checks\n",
      SKIP,
      "templates/base/.github/workflows/checks.yml.jinja",
    );
    expect(ownership).toEqual({ class: "starter" });
  });

  test("a starter carrying the managed header throws the contradiction", () => {
    expect(() =>
      classifyTemplateSource(
        ".github/workflows/checks.yml",
        "# This file is managed by {{ github_username }}/repo-platform.\n",
        SKIP,
        "templates/base/.github/workflows/checks.yml.jinja",
      ),
    ).toThrow(/managed header but\s+renders a _skip_if_exists starter/);
  });

  test("the local-section sentinel makes a split, recording the exact form", () => {
    for (const marker of [
      "# repo-platform:local-section",
      "<!-- repo-platform:local-section -->",
    ]) {
      const { ownership } = classifyTemplateSource(
        "SECURITY.md",
        `top\n${marker}\ntail\n`,
        SKIP,
        "templates/base/SECURITY.md.jinja",
      );
      expect(ownership).toEqual({ class: "split", marker, managed: "above" });
    }
  });

  test("a sentinel mention mid-line does not count as a marker", () => {
    const { ownership } = classifyTemplateSource(
      "GUIDE.md",
      "see the repo-platform:local-section marker\n",
      SKIP,
      "templates/base/GUIDE.md.jinja",
    );
    expect(ownership).toEqual({ class: "managed" });
  });

  test(".gitignore splits on its own managed-section grammar, managed below", () => {
    const { ownership } = classifyTemplateSource(
      ".gitignore",
      "# BEGIN REPOSITORY LOCAL\n# END REPOSITORY LOCAL\n# BEGIN REPO-PLATFORM MANAGED\nx\n# END REPO-PLATFORM MANAGED\n",
      SKIP,
      "templates/base/.gitignore.jinja",
    );
    expect(ownership).toEqual({
      class: "split",
      marker: "# BEGIN REPO-PLATFORM MANAGED",
      managed: "below",
    });
  });

  test(".gitignore without its managed-section marker throws", () => {
    expect(() =>
      classifyTemplateSource(".gitignore", "stuff\n", SKIP, "templates/base/.gitignore.jinja"),
    ).toThrow(/BEGIN REPO-PLATFORM MANAGED/);
  });

  test("everything else is managed, with the header flag reported", () => {
    const withHeader = classifyTemplateSource(
      ".yamllint",
      "# This file is managed by {{ github_username }}/repo-platform.\nrules: {}\n",
      SKIP,
      "templates/base/.yamllint.jinja",
    );
    expect(withHeader).toEqual({ ownership: { class: "managed" }, hasHeader: true });
    const without = classifyTemplateSource(
      ".bun-version",
      "1.3.14\n",
      SKIP,
      "templates/bun/.bun-version",
    );
    expect(without).toEqual({ ownership: { class: "managed" }, hasHeader: false });
  });

  test("a split file that also opens with the header still classifies split", () => {
    const { ownership, hasHeader } = classifyTemplateSource(
      "AGENTS.md",
      "<!-- This file is managed by {{ github_username }}/repo-platform. -->\n<!-- repo-platform:local-section -->\n",
      SKIP,
      "templates/agents/AGENTS.md.jinja",
    );
    expect(ownership.class).toBe("split");
    expect(hasHeader).toBe(true);
  });
});
