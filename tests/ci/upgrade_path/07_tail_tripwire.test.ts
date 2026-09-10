// Tail tripwire end-to-end (workflow step -> report -> open_pr): the
// post-stamp tripwire chain runs nowhere else end-to-end. A repo-owned tail
// line that vanished from the working tree after the stamp must produce the
// RUNNER_TEMP report, land as a PR-body section, and force the manual-review
// path (auto-merge off). Renders from the NEW build (no extra tag); gh is
// stubbed, so open_pr.ts's body and arm decisions are observable without a
// network.

import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dropLinesContaining, editText, linesOf } from "./edits";
import {
  appendText,
  commitAll,
  copierCopy,
  describeLeg,
  type Fixture,
  ghStub,
  git,
  isEmptyFile,
  legTest,
  openPr,
  readText,
  syncScript,
  upgradePathHarness,
} from "./fixture";

const harness = upgradePathHarness();

const TAIL_LINE = "trip-local tail line";
const WARNING_HEADING = "TAIL TRIPWIRE";

describeLeg("07 tail tripwire", () => {
  let fx: Fixture;
  let project: string;
  let work: string;
  let report: string;

  legTest(
    "the committed repo-owned tail line vanishes from the working tree after the stamp",
    () => {
      fx = harness.fixture();
      project = fx.path("upgrade-trip");
      work = fx.mkdir("upgrade-trip-work");
      report = join(work, "tail-shrank.md");
      copierCopy(project, fx.new.tag, {
        projectName: "Tripwire",
        description: "Tripwire project",
        modules: [],
        private: false,
      });
      const agents = join(project, "AGENTS.md");
      appendText(agents, `\n## Local agent docs\n\n${TAIL_LINE}\n`);
      git(project, "init", "-q", "-b", "main");
      commitAll(project, "chore: init with tail");
      expect(readText(agents)).toContain(TAIL_LINE);
      // The sync bug the tripwire exists for: the line vanishes AFTER the
      // stamp (the manifest still declares the split, HEAD still holds it).
      editText(agents, (text) => dropLinesContaining(text, TAIL_LINE));
      expect(readText(agents)).not.toContain(TAIL_LINE);
    },
  );

  legTest("the tripwire reports the shrunk tail under RUNNER_TEMP with the missing line", () => {
    syncScript("tail_tripwire", { RUNNER_TEMP: work }, ["--root", project]);
    expect(existsSync(report)).toBe(true);
    expect(isEmptyFile(report)).toBe(false);
    const text = readText(report);
    expect(text).toContain(WARNING_HEADING);
    expect(text).toContain(TAIL_LINE);
  });

  legTest("open_pr appends the tripwire section and leaves auto-merge off", () => {
    const stub = ghStub(work);
    const out = openPr(work, stub, "Vivswan/tripwire");
    expect(out).toContain("auto-merge left off");
    const calls = linesOf(readText(stub.calls));
    expect(calls.some((line) => /^gh pr create .* --body-file /.test(line))).toBe(true);
    expect(readText(join(work, "pr-body.md"))).toContain(WARNING_HEADING);
    expect(calls.filter((line) => line.startsWith("gh pr merge"))).toEqual([]);
  });
});
