// render_golden replaces its destination whole, so the destination guard is
// the difference between a review aid and a checkout wipe: every path inside
// the checkout other than the golden directory is refused, alias spellings
// included, and an outside path passes.

import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { destProblem } from "../../scripts/render_golden";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

describe("destProblem", () => {
  const root = temp.dir("render-golden-dest-");
  const repo = join(root, "real", "repo");
  const golden = join(repo, "tests", "golden-renders", "all-modules");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, ".github"), { recursive: true });
  mkdirSync(golden, { recursive: true });
  symlinkSync(join(root, "real"), join(root, "alias"));

  test.each([
    [join(repo, ".git"), "the .git directory"],
    [join(repo, ".github"), "a tracked directory"],
    [join(root, "alias", "repo", ".git"), ".git through a symlink alias of the checkout"],
    [join(repo, "tests", "golden-renders"), "the golden directory's parent"],
    [repo, "the checkout itself"],
    [root, "an ancestor of the checkout"],
    [join(repo, "not", "yet", "there"), "a path inside the checkout that does not exist yet"],
  ])("refuses %s (%s)", (dest) => {
    expect(destProblem(dest, repo, golden)).toContain("inside the checkout");
  });

  test.each([
    [join(root, "out"), "a sibling outside the checkout"],
    [join(root, "real", "repo-scratch"), "a sibling whose name extends the checkout's"],
    [golden, "the default golden directory"],
    [
      join(root, "alias", "repo", "tests", "golden-renders", "all-modules"),
      "the golden directory through an alias",
    ],
  ])("allows %s (%s)", (dest) => {
    expect(destProblem(dest, repo, golden)).toBeNull();
  });
});
