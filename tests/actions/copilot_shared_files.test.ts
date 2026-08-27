// The two Copilot actions carry BYTE-IDENTICAL copies of identity.ts (who
// Copilot is, and how the review list is fetched) and runtime.ts (the
// helper slice both use). That is forced, not chosen: a composite action is
// published on the `actions` branch - the fleet's extraction-safe delivery
// channel, deliberately separate from the composed template tree - and runs
// from its own directory, so neither can import the other's file or the
// repository's shared/ tree.
//
// The copies are what this repository spent eight review rounds paying for
// under the old two-implementation gate, so they are pinned here rather
// than trusted. A login rename, a schema field, a changed pagination
// budget: whichever copy is edited, this fails until the other matches.
// The fix is always the same - copy the file across, do not re-type it.
//
// This is deliberately NOT the drift suite it replaced. That one ran two
// independent implementations against parallel cases and still let fixes
// land on one side only. Byte equality cannot.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ACTIONS = join(import.meta.dir, "../../actions");
const SHARED = ["identity.ts", "runtime.ts"];

describe("the Copilot actions' shared files", () => {
  for (const name of SHARED) {
    test(`${name} is identical in copilot-review-gate and copilot-rearm`, () => {
      const gate = readFileSync(join(ACTIONS, "copilot-review-gate", name), "utf8");
      const rearm = readFileSync(join(ACTIONS, "copilot-rearm", name), "utf8");
      expect(rearm).toBe(gate);
    });
  }

  // The operator's rerun workflow and the fleet twin deliberately diverge
  // in DELIVERY (local-path action off a default-branch checkout vs
  // @actions with no checkout - each file's comments name the divergence)
  // but must never diverge on RELEVANCE: the job-level `if:` is what keeps
  // an irrelevant event from starting a runner at all, and it drifted once
  // (a step-level env filter survived on the operator side).
  test("the rerun job's relevance condition is identical in the operator and fleet workflows", () => {
    const relevance = (text: string, file: string): string => {
      const match = text.match(/\n {4}if: >-\n([\s\S]*?)\n {4}runs-on:/);
      if (match === null) throw new Error(`${file}: no job-level if ahead of runs-on`);
      return match[1]
        .replaceAll("{% raw %}", "")
        .replaceAll("{% endraw %}", "")
        .replace(/\s+/g, " ")
        .trim();
    };
    const operator = join(import.meta.dir, "../../.github/workflows/rerun-copilot-gate.yml");
    const fleet = join(
      import.meta.dir,
      "../../templates/base/.github/workflows/rerun-copilot-gate.yml.jinja",
    );
    expect(relevance(readFileSync(operator, "utf8"), operator)).toBe(
      relevance(readFileSync(fleet, "utf8"), fleet),
    );
  });
});
