// What holds repo-platform's own third-party pins together and pinact cannot: pinact reads a branch comment as no comment,
// so nothing else ties the two Vivswan/skills lines to one sha (docs/fleet-guidelines.md names this test), and the two
// ignore rules in .github/pinact.yaml are cross-file facts (the delivery ref lives in actions/shared/platform.ts).

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DELIVERY_REF } from "../../actions/shared/platform.ts";
import { extractUsesPins } from "../shared/uses_pins.ts";

interface Step {
  name?: string;
  uses?: string;
  run?: string;
}

const ROOT = join(import.meta.dir, "../..");
const source = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const ci = parseYaml(source) as { jobs: Record<string, { steps?: Step[] }> };

test("the two skills pins share one sha and the `# main` comment, pinact skips only that shape and the delivery ref, and verifies comments after the writer", () => {
  const pins = extractUsesPins(source, "ci.yml").filter((pin) => pin.action === "Vivswan/skills");
  expect(new Set(pins.map((pin) => `${pin.ref} # ${pin.version}`)).size).toBe(1);
  expect(pins).toHaveLength(2);
  expect(pins[0].ref).toMatch(/^[0-9a-f]{40}$/);
  expect(pins[0].version).toBe("main");
  expect(parseYaml(readFileSync(join(ROOT, ".github/pinact.yaml"), "utf8"))).toEqual({
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
  // The written trees exist only after the writer step, in the same job: swapped, pinact judges the checkout alone and every
  // fleet pin passes unread.
  const steps = ci.jobs.actionlint.steps ?? [];
  const at = (predicate: (step: Step) => boolean) => steps.findIndex(predicate);
  const writer = at((step) => (step.run ?? "").includes("write_fleet_lint_tree.ts"));
  const verify = at((step) => (step.run ?? "").includes("pinact run"));
  expect(writer).toBeGreaterThanOrEqual(0);
  expect(verify).toBeGreaterThan(writer);
  // -verify-comment is what resolves each version comment's tag and compares it with the sha (pinact code 001); without it
  // a stale or lying comment passes, and delivery_pins judges comment shape alone.
  const commands = (steps[verify].run ?? "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
  expect(commands.join("\n")).toMatch(/\bpinact run -check -verify-comment\)?$/m);
});
