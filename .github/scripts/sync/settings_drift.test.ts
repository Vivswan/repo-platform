import { describe, expect, test } from "bun:test";
import { detectDrift, driftSummary, driftWarnings } from "./settings_drift";

const ANSWERS = {
  project_name: "Demo",
  description: "One-line demo description.",
  private: false,
};

describe("detectDrift", () => {
  test("no drift when live values match the recorded answers", () => {
    expect(detectDrift(ANSWERS, "false", "One-line demo description.")).toEqual({
      drifts: [],
      errors: [],
    });
  });

  test("flags a private flip", () => {
    const { drifts, errors } = detectDrift(ANSWERS, "true", "One-line demo description.");
    expect(errors).toEqual([]);
    expect(drifts).toEqual([{ field: "private", recorded: "false", live: "true" }]);
  });

  test("flags a description change and keeps quotes intact", () => {
    const answers = { ...ANSWERS, description: 'He said "hello" to the fleet' };
    const { drifts } = detectDrift(answers, "false", 'She said "goodbye" to the fleet');
    expect(drifts).toEqual([
      {
        field: "description",
        recorded: 'He said "hello" to the fleet',
        live: 'She said "goodbye" to the fleet',
      },
    ]);
  });

  test("a trailing newline on the live description is transport noise, not drift", () => {
    expect(detectDrift(ANSWERS, "false", "One-line demo description.\n").drifts).toEqual([]);
  });

  test("an interior newline in the live description is drift", () => {
    const { drifts } = detectDrift(ANSWERS, "false", "line one\nline two");
    expect(drifts).toEqual([
      { field: "description", recorded: "One-line demo description.", live: "line one\nline two" },
    ]);
  });

  test("both fields can drift at once", () => {
    const { drifts } = detectDrift(ANSWERS, "true", "rewritten");
    expect(drifts.map((d) => d.field)).toEqual(["private", "description"]);
  });

  test("adopts fields the answers file does not record", () => {
    expect(detectDrift({ project_name: "Demo" }, "true", "anything")).toEqual({
      drifts: [],
      errors: [],
    });
  });

  test("treats a null recorded description as empty", () => {
    expect(detectDrift({ description: null }, "false", "").drifts).toEqual([]);
    expect(detectDrift({ description: null }, "false", "added later").drifts).toEqual([
      { field: "description", recorded: "", live: "added later" },
    ]);
  });

  test("a recorded private that is not a boolean is an error, never a silent skip", () => {
    for (const recorded of ["true", null, 1]) {
      const { drifts, errors } = detectDrift({ private: recorded }, "true", "");
      expect(drifts).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("must be a boolean");
    }
  });

  test("a live private value that is not true or false is an error", () => {
    const { drifts, errors } = detectDrift(ANSWERS, "null", "One-line demo description.");
    expect(drifts).toEqual([]);
    expect(errors).toEqual(['--live-private must be "true" or "false", got "null"']);
  });
});

describe("driftSummary", () => {
  test("empty when nothing drifted", () => {
    expect(driftSummary("Vivswan/demo", [], "in-repo")).toBe("");
  });

  test("names the repo, the field, and both values", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "private", recorded: "false", live: "true" }],
      "in-repo",
    );
    expect(summary).toContain("> [!WARNING]");
    expect(summary).toContain("Vivswan/demo");
    expect(summary).toContain('`private`: "false" -> "true" (recorded -> live)');
    expect(summary).toContain("RATIFIES");
    expect(summary).toContain("`.github/settings.yml` is what the nightly settings heal enforces");
    expect(summary).toContain("Auto-merge is off");
    expect(summary).toContain("settings-repos heal");
    expect(summary).not.toContain("centrally homed");
  });

  test("keeps a multiline description value on one body line", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "description", recorded: "old", live: "line one\nline two" }],
      "in-repo",
    );
    expect(summary).toContain('`description`: "old" -> "line one\\nline two"');
  });

  test("tells a centrally homed repo the merge does not become the enforced truth", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "private", recorded: "false", live: "true" }],
      "central",
    );
    expect(summary).toContain("centrally homed");
    expect(summary).toContain("`settings/repos/demo.yml`");
    expect(summary).toContain("does NOT make them the enforced");
    expect(summary).toContain("Auto-merge is off");
    // The ratification and heal claims belong to the in-repo wording only.
    expect(summary).not.toContain("RATIFIES");
    expect(summary).not.toContain("heal enforces");
  });

  test("tells a repo with no settings home that nothing enforces the values", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "private", recorded: "false", live: "true" }],
      "none",
    );
    expect(summary).toContain("no settings home");
    expect(summary).toContain("Nothing enforces them either way");
    expect(summary).toContain("flip the setting back in the GitHub UI");
    // No apply run targets this repo, so the heal is not a way back.
    expect(summary).not.toContain("settings-repos heal");
    expect(summary).not.toContain("RATIFIES");
  });

  test("every body line is blockquoted so the section survives concatenation", () => {
    for (const home of ["central", "in-repo", "none"] as const) {
      const summary = driftSummary(
        "Vivswan/demo",
        [{ field: "private", recorded: "false", live: "true" }],
        home,
      );
      for (const line of summary.split("\n")) {
        expect(line).toStartWith(">");
      }
    }
  });
});

describe("driftWarnings", () => {
  test("one single-line warning per drifted field", () => {
    const warnings = driftWarnings("Vivswan/demo", [
      { field: "private", recorded: "false", live: "true" },
      { field: "description", recorded: "old", live: "new" },
    ]);
    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning).toStartWith("::warning::Vivswan/demo: ");
      expect(warning).not.toContain("\n");
      // Home-dependent consequences live in the PR body alone.
      expect(warning).not.toContain("ratifies");
      expect(warning).toContain("the PR body explains what merging does");
    }
    expect(warnings[0]).toContain('private changed out of band: "false" -> "true"');
  });

  test("escapes workflow-command data", () => {
    const [warning] = driftWarnings("Vivswan/demo", [
      { field: "description", recorded: "50% done", live: "done" },
    ]);
    expect(warning).toContain("50%25 done");
  });
});
