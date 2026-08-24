// Unit tests for the forgotten-migration tripwire: landing-path
// normalization strips filename gates and the .jinja suffix, release-tag
// selection is semver-ordered (not lexical), and the verdict names both
// the retired path and the expected migration filename. The skip-list and
// protected-path filtering is retired_paths.ts's contract, covered by its
// own tests; one composition test here pins that check_migrations really
// consumes it.

import { describe, expect, test } from "bun:test";
import { retiredPaths } from "../../.github/scripts/sync/retired_paths";
import { landingPath, latestReleaseTag, migrationErrors } from "../../scripts/check_migrations";

describe("landingPath", () => {
  test("passes a plain path through", () => {
    expect(landingPath("README.md")).toBe("README.md");
    expect(landingPath(".github/workflows/checks.yml")).toBe(".github/workflows/checks.yml");
  });

  test("strips the .jinja suffix", () => {
    expect(landingPath(".github/workflows/ci.yml.jinja")).toBe(".github/workflows/ci.yml");
  });

  test("strips a module filename gate", () => {
    expect(landingPath("{% if 'uv' in modules %}pyproject.toml{% endif %}")).toBe("pyproject.toml");
  });

  test("strips a gate wrapping a .jinja file (suffix sits outside the gate)", () => {
    expect(landingPath("{% if not private %}CONTRIBUTING.md{% endif %}.jinja")).toBe(
      "CONTRIBUTING.md",
    );
  });

  test("strips a gated directory segment", () => {
    expect(
      landingPath(".claude/{% if 'skills' in modules %}skills{% endif %}/style/SKILL.md"),
    ).toBe(".claude/skills/style/SKILL.md");
  });
});

describe("latestReleaseTag", () => {
  test("orders numerically, not lexically", () => {
    expect(latestReleaseTag(["templates/v9.0.0", "templates/v10.0.0"])).toEqual({
      tag: "templates/v10.0.0",
      version: "10.0.0",
    });
  });

  test("ignores tags of any other shape", () => {
    expect(latestReleaseTag(["v1.0.0", "templates/staging", "templates/v1.2"])).toBeNull();
    expect(latestReleaseTag(["templates/v1.2.3-rc.1", "templates/v0.1.0"])).toEqual({
      tag: "templates/v0.1.0",
      version: "0.1.0",
    });
  });

  test("no tags at all: null (nothing released yet)", () => {
    expect(latestReleaseTag([])).toBeNull();
  });
});

describe("migrationErrors", () => {
  test("nothing retired: no errors either way", () => {
    expect(migrationErrors([], "0.3.1", false)).toEqual([]);
    expect(migrationErrors([], "0.3.1", true)).toEqual([]);
  });

  test("retired paths with the migration present: pass", () => {
    expect(migrationErrors([".yamllint"], "0.3.1", true)).toEqual([]);
  });

  test("retired path without the migration: names the path and the expected filename", () => {
    const errors = migrationErrors([".yamllint", "old.yml"], "0.3.1", false);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("'.yamllint'");
    expect(errors[0]).toContain("migrations/0.3.1.ts");
    expect(errors[1]).toContain("'old.yml'");
  });
});

describe("composition with retired_paths", () => {
  test("a landing path leaving the render is retired unless skip-listed", () => {
    const oldPaths = new Set(
      [
        "{% if 'uv' in modules %}.yamllint{% endif %}",
        ".github/workflows/checks.yml.jinja",
        "README.md",
      ].map(landingPath),
    );
    const newPaths = new Set(["README.md"].map(landingPath));
    expect(retiredPaths(oldPaths, newPaths, [".github/workflows/checks.yml"], [])).toEqual([
      ".yamllint",
    ]);
  });
});
