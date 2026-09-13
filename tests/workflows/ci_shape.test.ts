// repo-platform's own ci.yml: the skills catalog is validated through Vivswan/skills' action, one job per mode (structure is
// offline, discovery needs the npm registry), and every third-party pin is judged by pinact in the actionlint job, which is
// the job holding the written fleet trees; each gates a merge (the all-green-roster rule holds the needs list).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ALL_GREEN_ROSTER } from "../../scripts/check/ssot/all_green.ts";
import { DELIVERY_REF, extractUsesPins } from "../../scripts/check/ssot/delivery_pins.ts";

interface Step {
  name?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  run?: string;
}

const SKILLS_ACTION = "Vivswan/skills/.github/actions/validate-skills";
const source = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");
const ci = parseYaml(source) as { jobs: Record<string, { steps?: Step[] }> };

test("the skills legs call Vivswan/skills' validate-skills action at one sha, structure and discovery, both gating", () => {
  const calls = Object.entries(ci.jobs).flatMap(([job, { steps = [] }]) =>
    steps
      .filter((step) => step.uses?.startsWith(`${SKILLS_ACTION}@`))
      .map((step) => ({
        job,
        mode: step.with?.mode ?? "structure",
        gating: ALL_GREEN_ROSTER.includes(job),
      })),
  );
  expect(calls).toEqual([
    { job: "validate-skills", mode: "structure", gating: true },
    { job: "skills-discovery", mode: "discovery", gating: true },
  ]);
  const pins = extractUsesPins(source, "ci.yml").filter((pin) => pin.action === "Vivswan/skills");
  expect(pins).toHaveLength(2);
  expect(new Set(pins.map((pin) => `${pin.ref} # ${pin.version}`)).size).toBe(1);
  expect(pins[0].ref).toMatch(/^[0-9a-f]{40}$/);
  expect(pins[0].version).toBe("main");
});

// Networked, so the pin gate lives in ci.yml only, never in the offline check chain.
test("the actionlint job installs one checksummed pinact release and verifies every pin in the checkout and each written tree", () => {
  const steps = ci.jobs.actionlint.steps ?? [];
  const named = (name: string) => steps.find((step) => step.name === name);
  expect(named("Install the pinned pinact release")).toEqual({
    name: "Install the pinned pinact release",
    env: {
      PINACT_VERSION: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      PINACT_SHA256: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
    run: expect.stringContaining(
      '"https://github.com/suzuki-shunsuke/pinact/releases/download/v${PINACT_VERSION}/pinact_linux_amd64.tar.gz"',
    ),
  });
  expect(named("Install the pinned pinact release")?.run).toContain("| sha256sum --check --strict");
  expect(named("Verify every pin in the checkout and the written workflows")).toEqual({
    name: "Verify every pin in the checkout and the written workflows",
    env: {
      GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      PINACT_CONFIG: "${{ github.workspace }}/.github/pinact.yaml",
    },
    run: [
      'for root in . "$RUNNER_TEMP"/fleet-lint/*/; do',
      '  (cd "$root" && pinact run -check -verify-comment)',
      "done",
      "",
    ].join("\n"),
  });
  // Skipped by shape, never by name alone: the platform's own stems at exactly the delivery ref (a mistyped ref is judged
  // and refused) and Vivswan/skills at a full sha (its `main` comment is no version comment to pinact, so the test above
  // holds it).
  expect(
    parseYaml(readFileSync(join(import.meta.dir, "../../.github/pinact.yaml"), "utf8")),
  ).toEqual({
    version: 3,
    rules: [
      {
        ignore: true,
        conditions: [
          { expr: `ActionRepoName == "repo-platform" && ActionVersion == "${DELIVERY_REF}"` },
        ],
      },
      {
        ignore: true,
        conditions: [
          {
            expr: 'ActionRepoFullName == "Vivswan/skills" && ActionVersion matches "^[0-9a-f]{40}$"',
          },
        ],
      },
    ],
  });
  // The written trees exist only after the writer step, in the same job.
  expect(steps.map((step) => step.name ?? step.uses?.split("@")[0])).toEqual([
    "actions/checkout",
    "raven-actions/actionlint",
    "oven-sh/setup-bun",
    "Install dependencies",
    "Write the fleet's workflows",
    "actionlint the written workflows",
    "Install the pinned pinact release",
    "Verify every pin in the checkout and the written workflows",
  ]);
});
