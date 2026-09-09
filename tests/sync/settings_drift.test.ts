import { describe, expect, test } from "bun:test";
import {
  type Drift,
  detectDrift,
  driftSummary,
  driftWarnings,
} from "../../.github/scripts/sync/settings_drift";

const ANSWERS = {
  project_name: "Demo",
  description: "One-line demo description.",
  private: false,
};

const NOT_BOOLEAN = (recorded: string) =>
  `the recorded private answer must be a boolean, got ${recorded} - ` +
  "visibility drift cannot be detected until it is fixed";

describe("detectDrift", () => {
  test.each<{
    reason: string;
    answers: Record<string, unknown>;
    livePrivate: string;
    liveDescription: string;
    expected: ReturnType<typeof detectDrift>;
  }>([
    {
      reason: "no drift when live values match the recorded answers",
      answers: ANSWERS,
      livePrivate: "false",
      liveDescription: "One-line demo description.",
      expected: { drifts: [], errors: [] },
    },
    {
      reason: "flags a private flip",
      answers: ANSWERS,
      livePrivate: "true",
      liveDescription: "One-line demo description.",
      expected: { drifts: [{ field: "private", recorded: "false", live: "true" }], errors: [] },
    },
    {
      reason: "flags a description change and keeps quotes intact",
      answers: { ...ANSWERS, description: 'He said "hello" to the fleet' },
      livePrivate: "false",
      liveDescription: 'She said "goodbye" to the fleet',
      expected: {
        drifts: [
          {
            field: "description",
            recorded: 'He said "hello" to the fleet',
            live: 'She said "goodbye" to the fleet',
          },
        ],
        errors: [],
      },
    },
    {
      reason: "a trailing newline on the live description is transport noise, not drift",
      answers: ANSWERS,
      livePrivate: "false",
      liveDescription: "One-line demo description.\n",
      expected: { drifts: [], errors: [] },
    },
    {
      reason: "an interior newline in the live description is drift",
      answers: ANSWERS,
      livePrivate: "false",
      liveDescription: "line one\nline two",
      expected: {
        drifts: [
          {
            field: "description",
            recorded: "One-line demo description.",
            live: "line one\nline two",
          },
        ],
        errors: [],
      },
    },
    {
      reason: "both fields can drift at once, private first",
      answers: ANSWERS,
      livePrivate: "true",
      liveDescription: "rewritten",
      expected: {
        drifts: [
          { field: "private", recorded: "false", live: "true" },
          { field: "description", recorded: "One-line demo description.", live: "rewritten" },
        ],
        errors: [],
      },
    },
    {
      reason: "adopts fields the answers file does not record",
      answers: { project_name: "Demo" },
      livePrivate: "true",
      liveDescription: "anything",
      expected: { drifts: [], errors: [] },
    },
    {
      reason: "a null recorded description reads as empty: no drift against an empty live one",
      answers: { description: null },
      livePrivate: "false",
      liveDescription: "",
      expected: { drifts: [], errors: [] },
    },
    {
      reason: "a null recorded description reads as empty: drift against a live one",
      answers: { description: null },
      livePrivate: "false",
      liveDescription: "added later",
      expected: {
        drifts: [{ field: "description", recorded: "", live: "added later" }],
        errors: [],
      },
    },
    // A recorded private of the wrong type is an error, never a silent
    // skip: comparing nothing is how the ratification bug worked.
    {
      reason: "a recorded private that is a string is an error",
      answers: { private: "true" },
      livePrivate: "true",
      liveDescription: "",
      expected: { drifts: [], errors: [NOT_BOOLEAN('"true"')] },
    },
    {
      reason: "a recorded private that is null is an error",
      answers: { private: null },
      livePrivate: "true",
      liveDescription: "",
      expected: { drifts: [], errors: [NOT_BOOLEAN("null")] },
    },
    {
      reason: "a recorded private that is a number is an error",
      answers: { private: 1 },
      livePrivate: "true",
      liveDescription: "",
      expected: { drifts: [], errors: [NOT_BOOLEAN("1")] },
    },
    {
      reason: "a live private value that is not true or false is an error",
      answers: ANSWERS,
      livePrivate: "null",
      liveDescription: "One-line demo description.",
      expected: {
        drifts: [],
        errors: ['--live-private must be "true" or "false", got "null"'],
      },
    },
  ])("$reason", ({ answers, livePrivate, liveDescription, expected }) => {
    expect(detectDrift(answers, livePrivate, liveDescription)).toEqual(expected);
  });
});

describe("driftSummary", () => {
  test("empty when nothing drifted", () => {
    expect(driftSummary("Vivswan/demo", [], true)).toBe("");
  });

  test("names the repo, the field, and both values", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "private", recorded: "false", live: "true" }],
      true,
    );
    expect(summary).toContain("> [!WARNING]");
    expect(summary).toContain("Vivswan/demo");
    expect(summary).toContain('`private`: "false" -> "true" (recorded -> live)');
    // Merging never decides the enforced settings, and the text must
    // describe the file this BRANCH leaves behind - the same sync may
    // have just created it from the live values - not the pre-sync one.
    // All three outcomes have to be named: declared (heal enforces the
    // declaration), omitted (live value left alone), absent (apply skips).
    const flat = summary.replace(/\n> /g, " ").replace(/\s+/g, " ");
    expect(flat).toContain("does NOT decide the");
    expect(flat).toContain("the sync may have created it here");
    expect(flat).toContain("the heal enforces THAT value");
    expect(flat).toContain("omits the key");
    expect(flat).toContain("leaves the live value alone");
    expect(flat).toContain("no settings.yml at all");
    expect(flat).toContain("skips this repository");
    expect(summary).toContain("Auto-merge is off");
    expect(summary).toContain("settings-repos heal");
  });

  test("branch mode: the section names the branch's PR and claims no disarm (none happens there)", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "private", recorded: "false", live: "true" }],
      true,
      "branch",
    );
    expect(summary).toContain("Merging the PR this branch belongs to records the live values");
    expect(summary).toContain(
      "its PR's own auto-merge is untouched, so settle this before merging",
    );
    expect(summary).not.toContain("Auto-merge is off");
    expect(summary).not.toContain("Merging this PR");
    for (const line of summary.split("\n")) expect(line).toStartWith(">");
  });

  test("keeps a multiline description value on one body line", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "description", recorded: "old", live: "line one\nline two" }],
      true,
    );
    expect(summary).toContain('`description`: "old" -> "line one\\nline two"');
  });

  test("without a settings.yml the heal is not offered as the way back", () => {
    const summary = driftSummary(
      "Vivswan/demo",
      [{ field: "private", recorded: "false", live: "true" }],
      false,
    );
    // The heal skips a repository with no repo layer, so the UI is the
    // only revert; the consequence text still names all three outcomes.
    expect(summary).toContain("flip the setting back in the GitHub UI");
    expect(summary).toContain("the heal skips this repository until it");
    expect(summary).not.toContain("settings-repos heal");
    expect(summary).toContain("does NOT decide the");
  });

  test("every body line is blockquoted so the section survives concatenation", () => {
    for (const settingsPresent of [true, false]) {
      const summary = driftSummary(
        "Vivswan/demo",
        [{ field: "private", recorded: "false", live: "true" }],
        settingsPresent,
      );
      for (const line of summary.split("\n")) {
        expect(line).toStartWith(">");
      }
    }
  });
});

describe("driftWarnings", () => {
  // The log line never says what merging ratifies - that depends on the
  // opt-in and lives in the PR body alone.
  const TAIL = "Auto-merge is disabled; the PR body explains what merging does and how to revert.";

  const BRANCH_TAIL =
    "the sync's comment on the branch's PR explains what merging does and how to revert.";

  test.each<{
    reason: string;
    repo: string;
    drifts: Drift[];
    hideDetails: boolean;
    delivery?: "default" | "branch";
    expected: string[];
  }>([
    {
      reason: "branch mode: no disarm is claimed and the comment is the home, values shown",
      repo: "Vivswan/demo",
      drifts: [{ field: "private", recorded: "false", live: "true" }],
      hideDetails: false,
      delivery: "branch",
      expected: [
        `::warning::Vivswan/demo: private changed out of band: "false" -> "true". ${BRANCH_TAIL}`,
      ],
    },
    {
      reason: "branch mode, hidden: the field alone, the comment as the home",
      repo: "h**-s**r",
      drifts: [{ field: "description", recorded: "secret", live: "other" }],
      hideDetails: true,
      delivery: "branch",
      expected: [
        `::warning::h**-s**r: description changed out of band (values hidden: private repository; details in the sync's comment on the branch's PR). ${BRANCH_TAIL}`,
      ],
    },
    {
      reason: "one single-line warning per drifted field, values shown",
      repo: "Vivswan/demo",
      drifts: [
        { field: "private", recorded: "false", live: "true" },
        { field: "description", recorded: "old", live: "new" },
      ],
      hideDetails: false,
      expected: [
        `::warning::Vivswan/demo: private changed out of band: "false" -> "true". ${TAIL}`,
        `::warning::Vivswan/demo: description changed out of band: "old" -> "new". ${TAIL}`,
      ],
    },
    {
      reason: "escapes workflow-command data",
      repo: "Vivswan/demo",
      drifts: [{ field: "description", recorded: "50% done", live: "done" }],
      hideDetails: false,
      expected: [
        `::warning::Vivswan/demo: description changed out of band: "50%25 done" -> "done". ${TAIL}`,
      ],
    },
    {
      reason: "hideDetails names the field but never the values",
      repo: "h**-s**r",
      drifts: [
        { field: "private", recorded: "false", live: "true" },
        { field: "description", recorded: "secret words", live: "other secret words" },
      ],
      hideDetails: true,
      expected: [
        `::warning::h**-s**r: private changed out of band (values hidden: private repository; details in the PR body). ${TAIL}`,
        `::warning::h**-s**r: description changed out of band (values hidden: private repository; details in the PR body). ${TAIL}`,
      ],
    },
  ])("$reason", ({ repo, drifts, hideDetails, delivery, expected }) => {
    expect(driftWarnings(repo, drifts, hideDetails, delivery)).toEqual(expected);
  });
});
