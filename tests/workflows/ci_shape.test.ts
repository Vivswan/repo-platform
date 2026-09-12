// repo-platform's own ci.yml validates this repository's skills catalog through Vivswan/skills' action, one job per mode:
// structure is offline, discovery needs the npm registry, and each gates a merge (the all-green-roster rule holds the needs list).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { ALL_GREEN_ROSTER } from "../../scripts/check/ssot/all_green.ts";
import { extractUsesPins } from "../../scripts/check/ssot/delivery_pins.ts";

interface Step {
  uses?: string;
  with?: Record<string, string>;
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
