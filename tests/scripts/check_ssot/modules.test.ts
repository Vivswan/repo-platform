// The module-manifest rules (scripts/check/ssot/modules.ts) on the real tree.

import { describe, expect, test } from "bun:test";
import { moduleRules } from "../../../scripts/check/ssot/modules.ts";

describe("files-modules", () => {
  test("files.yml's modules block names the manifests' modules in their order", () => {
    const rule = moduleRules.find((candidate) => candidate.name === "files-modules");
    if (rule === undefined) throw new Error("no files-modules rule");
    expect(rule.run()).toEqual([]);
  });
});
