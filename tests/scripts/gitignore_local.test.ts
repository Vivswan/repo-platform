// The shared LOCAL-region grammar (scripts/gitignore_local.ts) has two
// writers slicing EXISTING files: build_gitignore's self-output
// regeneration and the sync carry. cleanLocalRegion is their single
// accept/reject definition; these tests pin that a malformed file is
// rejected by BOTH the same way, never sliced differently.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carryLocalRegion } from "../../.github/scripts/sync/preserve_local_content";
import { existingLocalBody } from "../../scripts/build_gitignore";
import {
  cleanLocalRegion,
  GITIGNORE_REGION,
  LOCAL_BEGIN,
  LOCAL_END,
  MANAGED_BEGIN,
  MANAGED_END,
} from "../../scripts/gitignore_local";

const RENDER = `${LOCAL_BEGIN}\n# default body\n${LOCAL_END}\n\n${MANAGED_BEGIN}\n*.new\n${MANAGED_END}\n`;
const CLEAN = `${LOCAL_BEGIN}\n/repo-local-cache/\n${LOCAL_END}\n\n${MANAGED_BEGIN}\n*.old\n${MANAGED_END}\n`;
const MALFORMED: Record<string, string> = {
  "duplicated BEGIN line": `${LOCAL_BEGIN}\n/a/\n${LOCAL_BEGIN}\n${LOCAL_END}\n`,
  "duplicated END line": `${LOCAL_BEGIN}\n/a/\n${LOCAL_END}\n${LOCAL_END}\n`,
  "marker text buried mid-line": `dir/${LOCAL_BEGIN}\n${LOCAL_BEGIN}\n/a/\n${LOCAL_END}\n`,
  "reversed markers": `${LOCAL_END}\n/a/\n${LOCAL_BEGIN}\n`,
  "a missing BEGIN": `/a/\n${LOCAL_END}\n`,
  "a missing END": `${LOCAL_BEGIN}\n/a/\n`,
  "no markers at all": `/a/\n${MANAGED_BEGIN}\n*.old\n${MANAGED_END}\n`,
  "MANAGED marker text inside the body": `${LOCAL_BEGIN}\npath/${MANAGED_BEGIN}\n${LOCAL_END}\n`,
};

function onDisk(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "gitignore-local-")), ".gitignore");
  writeFileSync(path, content);
  return path;
}

describe("cleanLocalRegion", () => {
  test("accepts the exactly-once clean shape and slices the body", () => {
    expect(cleanLocalRegion(CLEAN)?.body).toBe("/repo-local-cache/\n");
  });

  for (const [shape, content] of Object.entries(MALFORMED)) {
    test(`rejects ${shape}`, () => {
      expect(cleanLocalRegion(content)).toBeNull();
    });
  }
});

describe("the two writers agree on the shared accept/reject", () => {
  test("a clean file: the regenerator and the sync carry use the same body", () => {
    expect(existingLocalBody(onDisk(CLEAN))).toBe("/repo-local-cache/\n");
    const carry = carryLocalRegion(RENDER, CLEAN, GITIGNORE_REGION);
    expect(carry?.disposition).toBe("spliced");
    expect(carry?.content).toContain("/repo-local-cache/\n");
  });

  test("a file that does not exist yet gets the regenerator's default body", () => {
    expect(existingLocalBody(join(mkdtempSync(join(tmpdir(), "gitignore-local-")), "none"))).toBe(
      "# Add repository-specific ignore patterns in this section only.\n",
    );
  });

  for (const [shape, content] of Object.entries(MALFORMED)) {
    test(`a file with ${shape}: both writers reject, neither slices`, () => {
      expect(() => existingLocalBody(onDisk(content))).toThrow("clean REPOSITORY LOCAL region");
      expect(carryLocalRegion(RENDER, content, GITIGNORE_REGION)?.disposition).toBe("appendix");
    });
  }
});
