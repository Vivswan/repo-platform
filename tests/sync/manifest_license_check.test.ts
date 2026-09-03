import { describe, expect, test } from "bun:test";
import { checkManifests, manifestSummary } from "../../.github/scripts/sync/manifest_license_check";

// checkManifests emits fixed strings, so every case pins the whole
// problems array: the count AND the exact diagnosis.
const NPM_LICENSE = (claim: string) =>
  `\`package.json\`: \`"license": ${claim}\` - set it to \`"SEE LICENSE IN LICENSE.md"\``;
const NPM_LEGACY =
  '`package.json`: the legacy `"licenses"` field claims a license - delete it and set `"license": "SEE LICENSE IN LICENSE.md"`';
const NPM_UNPARSEABLE = "`package.json`: unparseable, license claim unknown";
const CARGO_LICENSE_KEY = (section: string) =>
  `\`Cargo.toml\`: \`[${section}]\` has a \`license\` key - delete it and set \`license-file = "LICENSE.md"\``;
const CARGO_LICENSE_FILE = (section: string, file: string) =>
  `\`Cargo.toml\`: \`[${section}] license-file\` points at "${file}" - point it at \`"LICENSE.md"\``;
const CARGO_UNPARSEABLE = "`Cargo.toml`: unparseable, license claim unknown";
const PY_SPDX =
  '`pyproject.toml`: `license =` claims an SPDX license - use a single `LicenseRef-` expression or `{ file = "LICENSE.md" }`';
const PY_TABLE =
  '`pyproject.toml`: the `license` table claims something other than the LICENSE.md file - use `{ file = "LICENSE.md" }`';
const PY_CLASSIFIER =
  "`pyproject.toml`: a `License ::` trove classifier claims a listed license - delete it (no classifier exists for the fleet license)";
const PY_UNPARSEABLE = "`pyproject.toml`: unparseable, license claim unknown";

describe("checkManifests", () => {
  test("clean when no manifests exist", () => {
    expect(checkManifests({})).toEqual([]);
  });

  test("flags an SPDX claim in package.json", () => {
    expect(checkManifests({ packageJson: '{"license": "MIT"}' })).toEqual([NPM_LICENSE('"MIT"')]);
  });

  test("accepts the npm custom-license convention", () => {
    expect(checkManifests({ packageJson: '{"license": "SEE LICENSE IN LICENSE.md"}' })).toEqual([]);
  });

  test("a package.json without a license field makes no false claim", () => {
    expect(checkManifests({ packageJson: '{"name": "x"}' })).toEqual([]);
  });

  test("flags npm's legacy licenses array", () => {
    expect(checkManifests({ packageJson: '{"licenses": [{"type": "MIT", "url": "x"}]}' })).toEqual([
      NPM_LEGACY,
    ]);
  });

  test("flags unparseable package.json instead of skipping it", () => {
    expect(checkManifests({ packageJson: "{nope" })).toEqual([NPM_UNPARSEABLE]);
  });

  test("flags a Cargo.toml license key but accepts license-file = LICENSE", () => {
    expect(
      checkManifests({ cargoToml: '[package]\nname = "x"\nlicense = "Apache-2.0"\n' }),
    ).toEqual([CARGO_LICENSE_KEY("package")]);
    expect(
      checkManifests({ cargoToml: '[package]\nname = "x"\nlicense-file = "LICENSE.md"\n' }),
    ).toEqual([]);
  });

  test("flags a license-file pointing anywhere but LICENSE", () => {
    expect(checkManifests({ cargoToml: '[package]\nlicense-file = "LICENSE-MIT"\n' })).toEqual([
      CARGO_LICENSE_FILE("package", "LICENSE-MIT"),
    ]);
  });

  test.each([
    {
      reason: "a [workspace.package] license default",
      cargoToml: '[workspace.package]\nlicense = "MIT"\n',
      section: "workspace.package",
    },
    {
      reason: "a [package] license inherited from the workspace",
      cargoToml: "[package]\nlicense.workspace = true\n",
      section: "package",
    },
  ])("flags a Cargo license declared at the workspace level: $reason", ({ cargoToml, section }) => {
    expect(checkManifests({ cargoToml })).toEqual([CARGO_LICENSE_KEY(section)]);
  });

  test("a license key outside the package sections does not count", () => {
    expect(
      checkManifests({ cargoToml: '[package]\nname = "x"\n\n[other]\nlicense = "MIT"\n' }),
    ).toEqual([]);
  });

  test("flags unparseable Cargo.toml instead of skipping it", () => {
    expect(checkManifests({ cargoToml: '[package]\nlicense = "unterminated' })).toEqual([
      CARGO_UNPARSEABLE,
    ]);
  });

  test("parses CRLF manifests", () => {
    // The exact message matters here: an "unparseable" problem would also
    // be one problem, and would mean CRLF broke the parse.
    expect(checkManifests({ cargoToml: '[package]\r\nlicense = "MIT"\r\n' })).toEqual([
      CARGO_LICENSE_KEY("package"),
    ]);
  });

  test("flags a pyproject SPDX string but accepts LicenseRef and the LICENSE file table", () => {
    expect(checkManifests({ pyprojectToml: '[project]\nlicense = "MIT"\n' })).toEqual([PY_SPDX]);
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
    ).toEqual([PY_SPDX]);
  });

  test.each([
    { reason: "a license text table", license: '{ text = "MIT" }' },
    { reason: "a file table pointing elsewhere", license: '{ file = "COPYING" }' },
    {
      reason: "a file table pointing elsewhere that also carries a text claim",
      license: '{ file = "LICENSE", text = "MIT" }',
    },
    {
      reason: "the right file plus a smuggled text claim (the one-key rule)",
      license: '{ file = "LICENSE.md", text = "MIT" }',
    },
  ])("flags a pyproject license table: $reason", ({ license }) => {
    expect(checkManifests({ pyprojectToml: `[project]\nlicense = ${license}\n` })).toEqual([
      PY_TABLE,
    ]);
  });

  test("flags a License trove classifier, including inline arrays", () => {
    expect(
      checkManifests({
        pyprojectToml: '[project]\nclassifiers = ["License :: OSI Approved :: MIT License"]\n',
      }),
    ).toEqual([PY_CLASSIFIER]);
  });

  test("an unrelated string mentioning License :: elsewhere is not a classifier", () => {
    expect(
      checkManifests({
        pyprojectToml: '[project]\nname = "x"\n\n[tool.notes]\ntext = "License :: whatever"\n',
      }),
    ).toEqual([]);
  });

  test("flags unparseable pyproject.toml instead of skipping it", () => {
    expect(checkManifests({ pyprojectToml: '[project]\nlicense = "unterminated' })).toEqual([
      PY_UNPARSEABLE,
    ]);
  });

  test("collects problems across all three manifests, in manifest order", () => {
    expect(
      checkManifests({
        packageJson: '{"license": "MIT"}',
        cargoToml: '[package]\nlicense = "MIT"\n',
        pyprojectToml: '[project]\nlicense = "MIT"\n',
      }),
    ).toEqual([NPM_LICENSE('"MIT"'), CARGO_LICENSE_KEY("package"), PY_SPDX]);
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
