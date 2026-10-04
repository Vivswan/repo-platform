// A gitignored checkout (the docs-check job's `.skills/`) once failed the typography check while git itself never
// judged it; the script is run as the action runs it, so the file source is under test, not a mock of it.

import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { fixtureGit, fixtureGitEnv } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const SCRIPT = resolve(import.meta.dir, "../../../actions/check-typography/check-typography.ts");
// Escapes, not literals: the suite is itself a tracked file the check judges.
const CURLY = "a \u201Cquoted\u201D word\n";

test("judges tracked and untracked files alike, and never an ignored untracked one", () => {
  const root = temp.dir("check-typography-");
  fixtureGit(root, ["init", "-q"]);
  const files: Record<string, string> = {
    ".gitignore": "/.skills/\n",
    "README.md": "plain ascii\n",
    "notes.md": CURLY,
    ".skills/docs/vale.md": CURLY,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  fixtureGit(root, ["add", ".gitignore", "README.md"]);

  const proc = boundedSpawnSync(["bun", SCRIPT, root], { env: fixtureGitEnv() });
  expect({ exitCode: proc.exitCode, stderr: proc.stderr }).toEqual({
    exitCode: 1,
    stderr: [
      "Typographic look-alike characters found:",
      "",
      "  notes.md:1 curly quote (use ' or \")",
      "  notes.md:1 curly quote (use ' or \")",
      "",
      "2 occurrence(s). Replace them with plain ASCII equivalents.",
      "",
    ].join("\n"),
  });
});
