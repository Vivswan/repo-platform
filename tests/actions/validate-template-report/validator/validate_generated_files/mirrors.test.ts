// The declared mirror copies a render must carry: a target the sync
// recorded is manifest_parity's to hold; one it never recorded must hold
// its source's bytes, so a declaration whose copy was never written is red
// until the copy exists (by a sync or by hand).

import { describe, expect, test } from "bun:test";
import { tempDirs } from "../../../../shared/temp_dir.ts";
import {
  BASELINE,
  MANIFEST,
  manifestOf,
  shaLatin1,
  stampedEntries,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

const SOURCE = BASELINE["AGENTS.md"];
const REGISTRATION = `${BASELINE[".repo-platform.yml"]}mirrors:\n  - {source: AGENTS.md, targets: [copies/AGENTS.md, skills/*/AGENTS.md]}\n`;
const DECLARED = "copies/AGENTS.md: declared in .repo-platform.yml as a mirror of 'AGENTS.md'";
const NEVER_WRITTEN =
  `and unrecorded in ${MANIFEST} - the copy was never written; run a template sync, or copy the ` +
  "source there yourself (the next sync adopts a copy holding the source's bytes)";

function run(extra: Record<string, string>, recorded = false) {
  const tree: Record<string, string> = {
    ...BASELINE,
    ".repo-platform.yml": REGISTRATION,
    ...extra,
  };
  const entries = stampedEntries(tree);
  if (recorded) {
    entries["copies/AGENTS.md"] =
      `{"class": "mirror", "hash": "${shaLatin1(tree["copies/AGENTS.md"] ?? "")}"}`;
  }
  return runValidator({ ...tree, [MANIFEST]: manifestOf(entries) });
}

describe("declared mirror targets", () => {
  test.each<{ reason: string; extra: Record<string, string>; recorded?: boolean }>([
    { reason: "a recorded copy", extra: { "copies/AGENTS.md": SOURCE }, recorded: true },
    {
      reason: "an unrecorded copy holding the source's bytes",
      extra: { "copies/AGENTS.md": SOURCE },
    },
  ])("$reason passes", ({ extra, recorded }) => {
    const { exitCode, stderr } = run(extra, recorded);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test.each<{ reason: string; extra: Record<string, string>; error: string }>([
    {
      reason: "a target never written",
      extra: {},
      error: `${DECLARED} but missing from the repo ${NEVER_WRITTEN}`,
    },
    {
      reason: "a directory at the target",
      extra: { "copies/AGENTS.md/inner.md": "" },
      error: `${DECLARED} but a directory ${NEVER_WRITTEN}`,
    },
    {
      reason: "an unrecorded copy that differs from the source",
      extra: { "copies/AGENTS.md": "hand-made copy\n" },
      error:
        `${DECLARED} but unrecorded in ${MANIFEST} and its content differs from the source - a copy ` +
        "made outside a sync that drifted; run a template sync to rewrite and record it",
    },
  ])("$reason is the run's one error", ({ extra, error }) => {
    const { exitCode, stderr } = run(extra);
    expect(exitCode).toBe(1);
    expect(stderr).toBe(`error: ${error}\n\n1 error(s).\n`);
  });

  test("a recorded copy is judged by its record alone: bytes matching the record pass whatever the source holds", () => {
    const { exitCode, stderr } = run({ "copies/AGENTS.md": "the previous copy\n" }, true);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a symbolic link at the target, or a link loop above it, is named as such, never as absence", () => {
    const tree: Record<string, string> = { ...BASELINE, ".repo-platform.yml": REGISTRATION };
    const links = { "copies/AGENTS.md": "../AGENTS.md" };
    const linked = runValidator({ ...tree, [MANIFEST]: manifestOf(stampedEntries(tree)) }, [], {
      links,
    });
    expect(linked.exitCode).toBe(1);
    expect(linked.stderr).toBe(
      `error: ${DECLARED} but a symbolic link ${NEVER_WRITTEN}\n\n1 error(s).\n`,
    );
    const loop = runValidator({ ...tree, [MANIFEST]: manifestOf(stampedEntries(tree)) }, [], {
      links: { copies: "copies" },
    });
    expect(loop.exitCode).toBe(1);
    expect(loop.stderr).toBe(
      `error: ${DECLARED} but not readable (ELOOP) ${NEVER_WRITTEN}\n\n1 error(s).\n`,
    );
  });

  test("a source that is not a regular file is named once, whatever its targets; globs and unclean paths are skipped", () => {
    const tree = {
      ...BASELINE,
      ".repo-platform.yml": `${BASELINE[".repo-platform.yml"]}mirrors:\n  - {source: nope.md, targets: [a, b, c/*]}\n  - {source: AGENTS.md, targets: [../x, docs/*/AGENTS.md]}\n`,
    };
    const { exitCode, stderr } = runValidator({
      ...tree,
      [MANIFEST]: manifestOf(stampedEntries(tree)),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toBe(
      "error: .repo-platform.yml: mirror source 'nope.md' is missing from the repo, so its " +
        "copies cannot be judged - the source must be a file files.yml writes here (the plan job rejects " +
        "any other); fix the declaration\n\n1 error(s).\n",
    );
  });
});
