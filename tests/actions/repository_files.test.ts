// The git fact every `git ls-files` check rests on, which nothing in this repository enforces: a nested checkout inside
// the root (fleet-ci.yml's platform checkout) is one `<dir>/` entry to `--others`, never its files, so the typography,
// shell-complexity, and file-size checks and the validator's writer comparison need no exclusion for it.

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_CHECKOUT_DIR } from "../../actions/shared/platform.ts";
import { repositoryFiles } from "../../actions/shared/repository_files.ts";
import { fixtureGit } from "../shared/fixture_git.ts";
import { tempDirs } from "../shared/temp_dir.ts";

const temp = tempDirs();

test("a nested checkout's files are listed neither as tracked nor as untracked; the root's untracked files still are", () => {
  const root = temp.dir("repository-files-nested-");
  fixtureGit(root, ["init", "-q"]);
  writeFileSync(join(root, "tracked.md"), "tracked\n");
  fixtureGit(root, ["add", "tracked.md"]);
  fixtureGit(root, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  writeFileSync(join(root, "untracked.md"), "untracked\n");
  const nested = join(root, PLATFORM_CHECKOUT_DIR);
  mkdirSync(join(nested, "actions"), { recursive: true });
  fixtureGit(nested, ["init", "-q"]);
  writeFileSync(join(nested, "actions", "inner.md"), "inner\n");
  fixtureGit(nested, ["add", "actions/inner.md"]);
  expect({
    tracked: repositoryFiles(root, { untracked: false }),
    withUntracked: repositoryFiles(root, { untracked: true }).sort(),
  }).toEqual({ tracked: ["tracked.md"], withUntracked: ["tracked.md", "untracked.md"] });
});
