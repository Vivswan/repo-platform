// The site-config parity model (scripts/check/ssot/site_config.ts).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { canonical, type Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import { siteConfigMismatches } from "../../../scripts/check/ssot/site_config.ts";

const CONFIG =
  '{"site_title": "repo-platform", "docs_path": "docs", "include": [], "link_rot_label": "docs-link-rot"}';

const ci = (checkConfig: string, deployConfig: string) =>
  parseYaml(
    [
      "jobs:",
      "  docs-check:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@sha",
      "      - uses: ./actions/pages-site",
      "        with:",
      '          check: "true"',
      `          config: '${checkConfig}'`,
      "  site:",
      "    uses: ./.github/workflows/reusable-site.yml",
      "    with:",
      "      sha: ${{ github.sha }}",
      `      config: '${deployConfig}'`,
      "",
    ].join("\n"),
  ) as Record<string, unknown>;

const script = (config: string) =>
  [
    "import { x } from 'y';",
    "",
    `const SITE_CONFIG = '${config}';`,
    "",
    "x(SITE_CONFIG);",
    "",
  ].join("\n");

describe("siteConfigMismatches", () => {
  test("three equal copies pass, key order aside", () => {
    expect(siteConfigMismatches(ci(CONFIG, CONFIG), script(CONFIG))).toEqual([]);
    const reordered =
      '{"docs_path": "docs", "site_title": "repo-platform", "link_rot_label": "docs-link-rot", "include": []}';
    expect(siteConfigMismatches(ci(reordered, CONFIG), script(CONFIG))).toEqual([]);
  });

  const mismatch = (file: string, config: string) => ({
    file,
    expected: `the site job's config ${canonical(JSON.parse(CONFIG))}`,
    got: canonical(JSON.parse(config)),
  });
  const withInclude = CONFIG.replace('"include": []', '"include": ["skills"]');
  const otherPath = CONFIG.replace('"docs_path": "docs"', '"docs_path": "guide"');
  const cases: { reason: string; check: string; local: string; expected: Mismatch[] }[] = [
    {
      reason: "an extra include on the check alone",
      check: withInclude,
      local: CONFIG,
      expected: [mismatch(".github/workflows/ci.yml docs-check", withInclude)],
    },
    {
      reason: "a different docs path in the local script alone",
      check: CONFIG,
      local: otherPath,
      expected: [mismatch("scripts/docs_check.ts", otherPath)],
    },
    {
      reason: "both copies drifting from the deploy",
      check: withInclude,
      local: otherPath,
      expected: [
        mismatch(".github/workflows/ci.yml docs-check", withInclude),
        mismatch("scripts/docs_check.ts", otherPath),
      ],
    },
  ];

  test.each(cases)(
    "a copy that differs from the deploy goes red naming it and both values ($reason)",
    ({ check, local, expected }) => {
      expect(siteConfigMismatches(ci(check, CONFIG), script(local))).toEqual(expected);
    },
  );

  test("a lost anchor throws instead of passing vacuously", () => {
    const noStep = parseYaml(
      "jobs:\n  docs-check:\n    steps:\n      - run: true\n  site:\n    with:\n      config: '{}'\n",
    ) as Record<string, unknown>;
    expect(() => siteConfigMismatches(noStep, script(CONFIG))).toThrow("pages-site step");
    const noDeploy = parseYaml(
      "jobs:\n  docs-check:\n    steps:\n      - uses: ./actions/pages-site\n        with:\n          config: '{}'\n  site:\n    with: {}\n",
    ) as Record<string, unknown>;
    expect(() => siteConfigMismatches(noDeploy, script(CONFIG))).toThrow("config input");
    expect(() => siteConfigMismatches(ci(CONFIG, CONFIG), "const OTHER = 'x';\n")).toThrow(
      "SITE_CONFIG",
    );
    expect(() => siteConfigMismatches(ci("not json", CONFIG), script(CONFIG))).toThrow("not JSON");
  });

  test("the live copies are ARMED: the rule's exact judgment holds on the real sources", () => {
    expect(
      siteConfigMismatches(
        parseYaml(readFileSync(".github/workflows/ci.yml", "utf-8")) as Record<string, unknown>,
        readFileSync("scripts/docs_check.ts", "utf-8"),
      ),
    ).toEqual([]);
  });
});
