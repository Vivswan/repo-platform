// The two Copilot actions carry BYTE-IDENTICAL copies of identity.ts (who
// Copilot is, and how the review list is fetched) and runtime.ts (the
// helper slice both use). That is forced, not chosen: a composite action is
// published to the template branch and runs from its own directory, so
// neither can import the other's file or the repository's shared/ tree.
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
});
