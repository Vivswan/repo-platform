// The script is run as the action runs it, so the file source and the reporting are under test, not a mock of them.
// The fixtures' refused characters are escapes, not literals: the suite is itself a tracked file the check judges.

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { checkout } from "../../shared/fixture_checkout.ts";
import { fixtureGitEnv } from "../../shared/fixture_git.ts";
import { readGithubOutput } from "../../shared/github_output.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const SCRIPT = resolve(import.meta.dir, "../../../actions/check-typography/check-typography.ts");
const CURLY = "a \u201Cquoted\u201D word\n";
const REMEDY =
  "Replace each with its plain ASCII form, or exempt the path in .typography-allow.local.";

/** The whole of what a run leaves: its exit, its log, and what it wrote for the runner. */
function run(root: string): { exitCode: number; log: string; summary: string; report: string } {
  const runner = temp.dir("check-typography-runner-");
  const summary = join(runner, "summary.md");
  const output = join(runner, "output");
  writeFileSync(summary, "");
  writeFileSync(output, "");
  const proc = boundedSpawnSync(["bun", SCRIPT, root], {
    env: { ...fixtureGitEnv(), GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output },
  });
  return {
    exitCode: proc.exitCode,
    log: proc.stdout + proc.stderr,
    summary: readFileSync(summary, "utf-8"),
    report: readGithubOutput(output).report,
  };
}

// Three incidents in one checkout. A gitignored `.skills/` checkout once failed the check while git never judged it.
// A table of extensions once decided what was text, so `main.go` and a suffixed Dockerfile holding a bidi control passed
// unread. And the findings once reached the log alone, with no annotation and no step summary.
test("judges every file git reads as text, whatever its name, and reports each finding where a reviewer looks", () => {
  const root = checkout(
    temp,
    "check-typography-",
    {
      ".gitignore": "/.skills/\n",
      ".typography-allow.local": "# upstream text, kept byte for byte\nupstream/\n",
      "README.md": "plain ascii\n",
      "main.go": "// \u202Ereversed\n",
      "Dockerfile`[x](evil.example)`.dev": "FROM scratch\nRUN echo \u2026\n",
      "upstream/NOTICE": CURLY,
      "blob.dat": `\u0000${CURLY}`,
    },
    { "notes.md": CURLY, ".skills/docs/vale.md": CURLY },
  );
  // An ignore rule written after the file was tracked: git still tracks main.go, so the check still judges it.
  writeFileSync(join(root, ".gitignore"), "/.skills/\n/main.go\n");

  expect(run(root)).toEqual({
    exitCode: 1,
    log: [
      "::error file=notes.md,line=1::notes.md:1 curly quote (use ' or \")",
      "::error file=notes.md,line=1::notes.md:1 curly quote (use ' or \")",
      '::error file=Dockerfile`[x](evil.example)`.dev,line=2::Dockerfile`[x](evil.example)`.dev:2 ellipsis (use "...")',
      "::error file=main.go,line=1::main.go:1 bidi control character (delete it)",
      `4 occurrence(s). ${REMEDY}`,
      "",
    ].join("\n"),
    summary: [
      "## Typography check",
      "",
      `4 occurrence(s) in 6 text file(s). ${REMEDY}`,
      "",
      "| Where | Character |",
      "| --- | --- |",
      "| `notes.md:1` | curly quote (use ' or \") |",
      "| `notes.md:1` | curly quote (use ' or \") |",
      '| ``Dockerfile`[x](evil.example)`.dev:2`` | ellipsis (use "...") |',
      "| `main.go:1` | bidi control character (delete it) |",
      "",
    ].join("\n"),
    report: "findings",
  });
});

// A run that read no file passes exactly like one that read them all, unless the pass says how many it read.
test("a clean run says how many text files it judged, a binary file not among them", () => {
  const root = checkout(temp, "check-typography-clean-", {
    "README.md": "plain ascii\n",
    Makefile: "all:\n\ttrue\n",
    "blob.dat": `\u0000${CURLY}`,
  });

  expect(run(root)).toEqual({
    exitCode: 0,
    log: "Typography check passed (2 text file(s) judged).\n",
    summary: "## Typography check\n\nNo look-alike or invisible character in 2 text file(s).\n",
    report: "clean",
  });
});
