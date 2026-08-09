import { describe, expect, test } from "bun:test";
import { checkManifests, manifestSummary } from "../../.github/scripts/sync/manifest_license_check";

describe("checkManifests", () => {
  test("clean when no manifests exist", () => {
    expect(checkManifests({})).toEqual([]);
  });

  test("flags an SPDX claim in package.json", () => {
    const problems = checkManifests({ packageJson: '{"license": "MIT"}' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"MIT"');
    expect(problems[0]).toContain("SEE LICENSE IN LICENSE.md");
  });

  test("accepts the npm custom-license convention", () => {
    expect(checkManifests({ packageJson: '{"license": "SEE LICENSE IN LICENSE.md"}' })).toEqual([]);
  });

  test("a package.json without a license field makes no false claim", () => {
    expect(checkManifests({ packageJson: '{"name": "x"}' })).toEqual([]);
  });

  test("flags npm's legacy licenses array", () => {
    const problems = checkManifests({
      packageJson: '{"licenses": [{"type": "MIT", "url": "x"}]}',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("legacy");
  });

  test("flags unparseable package.json instead of skipping it", () => {
    const problems = checkManifests({ packageJson: "{nope" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unparseable");
  });

  test("flags a Cargo.toml license key but accepts license-file = LICENSE", () => {
    expect(
      checkManifests({ cargoToml: '[package]\nname = "x"\nlicense = "Apache-2.0"\n' }),
    ).toHaveLength(1);
    expect(
      checkManifests({ cargoToml: '[package]\nname = "x"\nlicense-file = "LICENSE.md"\n' }),
    ).toEqual([]);
  });

  test("flags a license-file pointing anywhere but LICENSE", () => {
    const problems = checkManifests({
      cargoToml: '[package]\nlicense-file = "LICENSE-MIT"\n',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("LICENSE-MIT");
  });

  test("flags workspace-inherited Cargo licenses", () => {
    expect(checkManifests({ cargoToml: '[workspace.package]\nlicense = "MIT"\n' })).toHaveLength(1);
    expect(checkManifests({ cargoToml: "[package]\nlicense.workspace = true\n" })).toHaveLength(1);
  });

  test("a license key outside the package sections does not count", () => {
    expect(
      checkManifests({ cargoToml: '[package]\nname = "x"\n\n[other]\nlicense = "MIT"\n' }),
    ).toEqual([]);
  });

  test("flags unparseable Cargo.toml instead of skipping it", () => {
    expect(checkManifests({ cargoToml: '[package]\nlicense = "unterminated' })[0]).toContain(
      "unparseable",
    );
  });

  test("parses CRLF manifests", () => {
    expect(checkManifests({ cargoToml: '[package]\r\nlicense = "MIT"\r\n' })).toHaveLength(1);
  });

  test("flags a pyproject SPDX string but accepts LicenseRef and the LICENSE file table", () => {
    expect(checkManifests({ pyprojectToml: '[project]\nlicense = "MIT"\n' })).toHaveLength(1);
    expect(
      checkManifests({
        pyprojectToml:
          '[project]\nlicense = "LicenseRef-Individual-Small-Organization-License-1.0.0"\n',
      }),
    ).toEqual([]);
    expect(
      checkManifests({ pyprojectToml: '[project]\nlicense = { file = "LICENSE.md" }\n' }),
    ).toEqual([]);
  });

  test("flags a compound expression smuggling a listed license past LicenseRef", () => {
    expect(
      checkManifests({ pyprojectToml: '[project]\nlicense = "LicenseRef-X OR MIT"\n' }),
    ).toHaveLength(1);
  });

  test("flags a license text table and a file table pointing elsewhere", () => {
    expect(
      checkManifests({ pyprojectToml: '[project]\nlicense = { text = "MIT" }\n' }),
    ).toHaveLength(1);
    expect(
      checkManifests({ pyprojectToml: '[project]\nlicense = { file = "COPYING" }\n' }),
    ).toHaveLength(1);
    expect(
      checkManifests({
        pyprojectToml: '[project]\nlicense = { file = "LICENSE", text = "MIT" }\n',
      }),
    ).toHaveLength(1);
  });

  test("flags a License trove classifier, including inline arrays", () => {
    const problems = checkManifests({
      pyprojectToml: '[project]\nclassifiers = ["License :: OSI Approved :: MIT License"]\n',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("classifier");
  });

  test("an unrelated string mentioning License :: elsewhere is not a classifier", () => {
    expect(
      checkManifests({
        pyprojectToml: '[project]\nname = "x"\n\n[tool.notes]\ntext = "License :: whatever"\n',
      }),
    ).toEqual([]);
  });

  test("flags unparseable pyproject.toml instead of skipping it", () => {
    expect(checkManifests({ pyprojectToml: '[project]\nlicense = "unterminated' })[0]).toContain(
      "unparseable",
    );
  });

  test("collects problems across all three manifests", () => {
    const problems = checkManifests({
      packageJson: '{"license": "MIT"}',
      cargoToml: '[package]\nlicense = "MIT"\n',
      pyprojectToml: '[project]\nlicense = "MIT"\n',
    });
    expect(problems).toHaveLength(3);
  });
});

describe("manifestSummary", () => {
  test("empty for no problems", () => {
    expect(manifestSummary([])).toBe("");
  });

  test("wraps problems in a warning block", () => {
    const summary = manifestSummary(["`package.json`: bad"]);
    expect(summary).toContain("[!WARNING]");
    expect(summary).toContain("- `package.json`: bad");
  });
});
