// referenced_labels.ts: the sync-side warning that every label the
// target's issue forms and workflows reference exists in the MERGED
// settings label roster. Script-level tests build a post-update target
// tree (registration + answers + settings.yml, the shape the sync leg
// hands the check) and assert the report in both directions, the
// not-applicable skips, and the fail-open-with-a-section error path.
// Uses the REAL fleet layers and manifests, like the render's own tests.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REFERENCED_LABELS_NAME } from "../../.github/scripts/sync/section_files.ts";

const script = join(import.meta.dir, "../../.github/scripts/sync/referenced_labels.ts");

const REGISTRATION = "modules:\n  - settings-sync\n";
const ANSWERS = "_commit: build@sha\nprivate: false\n";
const SETTINGS = "repository:\n  private: false\n";

function makeTarget(files: Record<string, string>): string {
  const root = join(mkdtempSync(join(tmpdir(), "referenced-labels-")), "target");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function runScript(root: string, env: Record<string, string> = {}) {
  const report = join(root, "..", REFERENCED_LABELS_NAME);
  const proc = Bun.spawnSync(["bun", script, "--root", root, "--report", report], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    report: readFileSync(report, "utf-8"),
  };
}

describe("referenced_labels", () => {
  test("a referenced label missing from the merged roster writes the warning section", () => {
    const root = makeTarget({
      ".repo-platform.yml": REGISTRATION,
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": SETTINGS,
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["definitely-not-declared-xyz"]\n',
      ".github/workflows/close.yml":
        "jobs:\n  x:\n    if: github.event.label.name == 'definitely-not-declared-xyz'\n",
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0); // warn, never fail: a quirk must not block the PR
    expect(r.report).toContain("REFERENCED LABELS MISSING FROM THE SETTINGS ROSTER");
    expect(r.report).toContain('"definitely-not-declared-xyz"');
    expect(r.report).toContain(".github/ISSUE_TEMPLATE/bug.yml");
    expect(r.report).toContain(".github/workflows/close.yml");
    expect(r.output).toContain("::warning::");
    expect(r.output).toContain("definitely-not-declared-xyz");
  });

  test("a hidden target's log line carries no label names (the report keeps them)", () => {
    const root = makeTarget({
      ".repo-platform.yml": REGISTRATION,
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": SETTINGS,
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["definitely-not-declared-xyz"]\n',
    });
    const proc = Bun.spawnSync(
      [
        "bun",
        script,
        "--root",
        root,
        "--report",
        join(root, "..", "report.md"),
        "--hide-details",
        "true",
      ],
      { env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
    );
    const output = proc.stdout.toString() + proc.stderr.toString();
    expect(proc.exitCode).toBe(0);
    expect(output).not.toContain("definitely-not-declared-xyz");
    expect(output).toContain("names hidden: private repository");
    expect(readFileSync(join(root, "..", "report.md"), "utf-8")).toContain(
      "definitely-not-declared-xyz",
    );
  });

  test("labels covered by the roster (baseline or the repo's own layer) write no section", () => {
    const root = makeTarget({
      ".repo-platform.yml": REGISTRATION,
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": `${SETTINGS}labels:\n  - name: answered\n    color: aabbcc\n`,
      // "bug" comes from the fleet baseline, "ANSWERED" (case-folded) from
      // the repo layer.
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["bug", "ANSWERED"]\n',
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
    expect(r.output).toContain("every referenced label is declared");
  });

  test("a new_name rename of a referenced label warns: only the final name is declared", () => {
    // The repo layer renames the baseline's "bug" to "defect" (the union
    // replaces a same-name label entry wholesale, so new_name rides
    // through the merge). A reference to the renamed-away source must
    // warn - the rename removes the old name exactly like a deletion.
    const root = makeTarget({
      ".repo-platform.yml": REGISTRATION,
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": `${SETTINGS}labels:\n  - name: bug\n    new_name: defect\n    color: d73a4a\n`,
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["bug"]\n',
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toContain('"bug"');
    expect(r.report).toContain("REFERENCED LABELS MISSING FROM THE SETTINGS ROSTER");

    // The rename TARGET is the post-apply name: referencing it is clean.
    const covered = makeTarget({
      ".repo-platform.yml": REGISTRATION,
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": `${SETTINGS}labels:\n  - name: bug\n    new_name: defect\n    color: d73a4a\n`,
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["defect"]\n',
    });
    const clean = runScript(covered);
    expect(clean.report).toBe("");
    expect(clean.output).toContain("every referenced label is declared");
  });

  test("not applicable without the settings-sync module (nothing reconciles labels)", () => {
    const root = makeTarget({
      ".repo-platform.yml": "modules: []\n",
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": SETTINGS,
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["definitely-not-declared-xyz"]\n',
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
    expect(r.output).toContain("not applicable");
  });

  test("not applicable without a settings.yml (the apply skips, deleting nothing)", () => {
    const root = makeTarget({
      ".repo-platform.yml": REGISTRATION,
      ".copier-answers.yml": ANSWERS,
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["definitely-not-declared-xyz"]\n',
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
    expect(r.output).toContain("no settings.yml to merge");
  });

  test("not applicable when the repo layer opts labels out (no key survives the merge)", () => {
    // labels: null is the dialect's opt-out: the merged document carries
    // no labels key at all, so the apply never reconciles labels and no
    // reference can be deleted out from under a file.
    const root = makeTarget({
      ".repo-platform.yml": REGISTRATION,
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": `${SETTINGS}labels: null\n`,
      ".github/ISSUE_TEMPLATE/bug.yml": 'labels: ["definitely-not-declared-xyz"]\n',
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0);
    expect(r.report).toBe("");
    expect(r.output).toContain("declares no labels key");
  });

  test("unreadable facts write the could-not-verify section instead of failing or passing", () => {
    const root = makeTarget({
      ".repo-platform.yml": "modules: not-a-list\n",
      ".copier-answers.yml": ANSWERS,
      ".github/settings.yml": SETTINGS,
    });
    const r = runScript(root);
    expect(r.exitCode).toBe(0); // fail open is how the incidents happened; fail hard blocks delivery
    expect(r.report).toContain("REFERENCED-LABEL CHECK COULD NOT RUN");
    expect(r.report).toContain("modules");
    expect(r.output).toContain("::warning::");
  });
});
