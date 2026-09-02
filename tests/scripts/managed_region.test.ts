// The shared managed-region slicers (actions/shared/grammar.ts) have two
// writers slicing EXISTING files: build_gitignore's self-output
// regeneration and the sync carry. cleanManagedRegion is their single
// accept/reject definition; these tests pin that a malformed file is
// rejected by BOTH the same way, never sliced differently.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryManagedRegion } from "../../.github/scripts/sync/preserve_local_content";
import {
  cleanManagedRegion,
  HASH_REGION_MARKERS,
  splitManagedRegion,
} from "../../actions/shared/grammar";
import { existingLocalSides } from "../../scripts/build_gitignore";

const HB = HASH_REGION_MARKERS.begin;
const HE = HASH_REGION_MARKERS.end;

const RENDER = `# local patterns go here\n\n${HB}\n*.new\n${HE}\n`;
const CLEAN = `# local patterns go here\n/repo-local-cache/\n\n${HB}\n*.old\n${HE}\nbelow-side\n`;
const MALFORMED: Record<string, string> = {
  "duplicated BEGIN line": `${HB}\n/a/\n${HB}\n${HE}\n`,
  "duplicated END line": `${HB}\n/a/\n${HE}\n${HE}\n`,
  "marker text buried mid-line": `dir/${HB}\n${HB}\n/a/\n${HE}\n`,
  "reversed markers": `${HE}\n/a/\n${HB}\n`,
  "a missing BEGIN": `/a/\n${HE}\n`,
  "a missing END": `${HB}\n/a/\n`,
  "no markers at all": "/a/\n*.old\n",
};

function onDisk(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "gitignore-region-")), ".gitignore");
  writeFileSync(path, content);
  return path;
}

describe("splitManagedRegion / cleanManagedRegion", () => {
  test("accepts the exactly-once clean shape and slices all three parts", () => {
    const slice = cleanManagedRegion(CLEAN, HASH_REGION_MARKERS);
    expect(slice?.above).toBe("# local patterns go here\n/repo-local-cache/\n\n");
    expect(slice?.region).toBe(`${HB}\n*.old\n${HE}\n`);
    expect(slice?.below).toBe("below-side\n");
  });

  test("the raw slicer and the clean slicer agree on a clean file", () => {
    expect(splitManagedRegion(CLEAN, HASH_REGION_MARKERS)).toEqual(
      cleanManagedRegion(CLEAN, HASH_REGION_MARKERS),
    );
  });

  for (const [shape, content] of Object.entries(MALFORMED)) {
    test(`cleanManagedRegion rejects ${shape}`, () => {
      expect(cleanManagedRegion(content, HASH_REGION_MARKERS)).toBeNull();
    });
  }
});

describe("the two writers agree on the shared accept/reject", () => {
  const entry = { path: ".gitignore", grammar: "managed-region", begin: HB, end: HE } as const;

  test("a clean file: the regenerator and the sync carry keep the same sides", () => {
    const sides = existingLocalSides(onDisk(CLEAN));
    expect(sides.above).toBe("# local patterns go here\n/repo-local-cache/\n\n");
    expect(sides.below).toBe("below-side\n");
    const carry = carryManagedRegion(RENDER, CLEAN, entry, undefined);
    expect(carry?.kind).toBe("sides-restored");
    expect(carry?.content).toContain("/repo-local-cache/\n");
    expect(carry?.content).toContain("below-side\n");
  });

  test("a file that does not exist yet gets the regenerator's default seed", () => {
    const sides = existingLocalSides(
      join(mkdtempSync(join(tmpdir(), "gitignore-region-")), "none"),
    );
    expect(sides.above).toContain("Repository-specific ignore patterns go outside");
    expect(sides.below).toBe("");
  });

  for (const [shape, content] of Object.entries(MALFORMED)) {
    test(`a file with ${shape}: both writers reject, neither slices`, () => {
      expect(() => existingLocalSides(onDisk(content))).toThrow(
        "clean REPO-PLATFORM MANAGED region",
      );
      expect(carryManagedRegion(RENDER, content, entry, undefined)?.kind).toBe("appendix");
    });
  }
});
