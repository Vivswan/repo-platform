// Unit tests for the verdict's expected-set computation - the pure twin
// (shared/all_green.ts expectedSetGaps/isBotAuthor) of the inline jq/bash
// in reusable-all-green.yml, whose side the ci/ verify_verdict_judgment.sh
// harness pins. Synthetic fixtures throughout: every scenario builds its
// own runs and check runs, including the healthy shape next to each gap,
// so a vacuously-empty result cannot pass.

import { describe, expect, test } from "bun:test";
import {
  COPILOT_CHECK_NAME,
  type ExpectedSetInput,
  expectedSetGaps,
  expectedSetRefusal,
  isBotAuthor,
  type ShaCheckRun,
  type ShaWorkflowRun,
} from "../../.github/scripts/shared/all_green.ts";

function run(overrides: Partial<ShaWorkflowRun> = {}): ShaWorkflowRun {
  return {
    id: 1,
    name: "Extra Suite",
    path: ".github/workflows/extra.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function copilotCheck(overrides: Partial<ShaCheckRun> = {}): ShaCheckRun {
  return {
    name: COPILOT_CHECK_NAME,
    status: "completed",
    conclusion: "success",
    appSlug: "github-actions",
    ...overrides,
  };
}

function input(overrides: Partial<ExpectedSetInput> = {}): ExpectedSetInput {
  return {
    event: "pull_request",
    conditionalWorkflows: [],
    requireCopilotReview: false,
    authorIsBot: false,
    runsAtSha: [],
    // The default registry registers the run() helper's identity, so the
    // state-focused tests exercise state; the identity tests (unknown
    // name, wrong path, collisions) override registry or path explicitly.
    workflowRegistry: [
      { name: "Extra Suite", path: ".github/workflows/extra.yml" },
      { name: "Ghost Workflow", path: ".github/workflows/ghost.yml" },
    ],
    checkRunsAtSha: [],
    ...overrides,
  };
}

describe("isBotAuthor", () => {
  test("the Bot type is a bot regardless of login", () => {
    expect(isBotAuthor("anything", "Bot")).toBe(true);
  });

  test("a [bot] login suffix is a bot regardless of type", () => {
    expect(isBotAuthor("dependabot[bot]", "User")).toBe(true);
  });

  test("a human is neither", () => {
    expect(isBotAuthor("vivswan", "User")).toBe(false);
  });

  test("[bot] must be a suffix, not a mention anywhere in the login", () => {
    expect(isBotAuthor("not[bot]really", "User")).toBe(false);
  });
});

describe("expectedSetRefusal", () => {
  test("push and PR events are always judgeable - push owes only CI, PR events judge the set", () => {
    for (const event of ["push", "pull_request", "pull_request_target"]) {
      expect(expectedSetRefusal(event, ["Extra Suite"], true)).toBeNull();
    }
  });

  test("other events with nothing declared stay judgeable (a CI-only judgment is complete)", () => {
    for (const event of ["workflow_dispatch", "schedule", "merge_group"]) {
      expect(expectedSetRefusal(event, [], false)).toBeNull();
    }
  });

  test("other events refuse while a roster exists - a dispatch at a PR head must not mint green over a red conditional", () => {
    expect(expectedSetRefusal("workflow_dispatch", ["Extra Suite"], false)).toContain(
      "'workflow_dispatch' run cannot judge",
    );
  });

  test("other events refuse while Copilot is required, roster or not", () => {
    expect(expectedSetRefusal("schedule", [], true)).toContain("'schedule' run cannot judge");
  });

  test("an event type unknown today lands on the refusal, not on an accidental green", () => {
    expect(expectedSetRefusal("brand_new_event", ["Extra Suite"], false)).toContain(
      "cannot judge the declared expected set",
    );
  });
});

describe("expectedSetGaps", () => {
  test("nothing declared, nothing required: no gaps", () => {
    expect(expectedSetGaps(input())).toEqual({ missing: [], failed: [] });
  });

  test("non-PR events carry no gaps - push owes only CI; dispatch/schedule with declarations never reach here (expectedSetRefusal refuses them first)", () => {
    for (const event of ["push", "schedule", "workflow_dispatch", "merge_group"]) {
      const gaps = expectedSetGaps(
        input({
          event,
          conditionalWorkflows: ["Extra Suite"],
          requireCopilotReview: true,
          runsAtSha: [],
          checkRunsAtSha: [],
        }),
      );
      expect(gaps).toEqual({ missing: [], failed: [] });
    }
  });

  test("pull_request_target is a PR event too", () => {
    const gaps = expectedSetGaps(
      input({ event: "pull_request_target", conditionalWorkflows: ["Extra Suite"] }),
    );
    expect(gaps.missing).toEqual(["Extra Suite has no pull_request_target run at this sha"]);
  });

  describe("conditional workflows", () => {
    test("a completed successful run satisfies the member", () => {
      const gaps = expectedSetGaps(
        input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [run()] }),
      );
      expect(gaps).toEqual({ missing: [], failed: [] });
    });

    test("a skipped run stands down, like a skipped job", () => {
      const gaps = expectedSetGaps(
        input({
          conditionalWorkflows: ["Extra Suite"],
          runsAtSha: [run({ conclusion: "skipped" })],
        }),
      );
      expect(gaps).toEqual({ missing: [], failed: [] });
    });

    test("a registered workflow with no run at the sha is MISSING, never green", () => {
      const gaps = expectedSetGaps(
        input({
          conditionalWorkflows: ["Ghost Workflow"],
          runsAtSha: [run()], // a different workflow's healthy run does not vouch
        }),
      );
      expect(gaps.missing).toEqual(["Ghost Workflow has no pull_request run at this sha"]);
      expect(gaps.failed).toEqual([]);
    });

    test("a name the registry does not know FAILS closed, even with a same-named green run - the decoy hole", () => {
      // Without the owner binding, a PR could path-filter the real
      // workflow away and add a same-named decoy; its green run was the
      // only candidate and satisfied the roster.
      for (const registry of [
        [] as { name: string; path: string }[],
        [{ name: "Something Else", path: ".github/workflows/else.yml" }],
      ]) {
        const gaps = expectedSetGaps(
          input({
            conditionalWorkflows: ["Extra Suite"],
            runsAtSha: [run({ path: ".github/workflows/decoy.yml" })],
            workflowRegistry: registry,
          }),
        );
        expect(gaps.failed).toEqual([
          "Extra Suite is not a workflow this repository knows - fix the roster, or land the workflow on the default branch first",
        ]);
        expect(gaps.missing).toEqual([]);
      }
    });

    test("a sole run from a path other than the registered owner FAILS closed, green or not", () => {
      for (const conclusion of ["success", "failure"]) {
        const gaps = expectedSetGaps(
          input({
            conditionalWorkflows: ["Extra Suite"],
            runsAtSha: [run({ path: ".github/workflows/decoy.yml", conclusion })],
          }),
        );
        expect(gaps.failed).toEqual([
          "Extra Suite ran from .github/workflows/decoy.yml, not its registered workflow .github/workflows/extra.yml",
        ]);
        expect(gaps.missing).toEqual([]);
      }
    });

    test("an unknown name with NO run at all is FAILED, not pending - waiting cannot repair identity", () => {
      const gaps = expectedSetGaps(
        input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [], workflowRegistry: [] }),
      );
      expect(gaps.failed).toEqual([
        "Extra Suite is not a workflow this repository knows - fix the roster, or land the workflow on the default branch first",
      ]);
      expect(gaps.missing).toEqual([]);
    });

    test("an uncompleted run is MISSING, naming its status", () => {
      for (const status of ["queued", "in_progress", "waiting"]) {
        const gaps = expectedSetGaps(
          input({
            conditionalWorkflows: ["Extra Suite"],
            runsAtSha: [run({ status, conclusion: null })],
          }),
        );
        expect(gaps.missing).toEqual([`Extra Suite is still ${status}`]);
        expect(gaps.failed).toEqual([]);
      }
    });

    test("every completed non-success, non-skipped conclusion FAILS the member", () => {
      for (const conclusion of [
        "failure",
        "cancelled",
        "timed_out",
        "neutral",
        "action_required",
        "stale",
      ]) {
        const gaps = expectedSetGaps(
          input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [run({ conclusion })] }),
        );
        expect(gaps.failed).toEqual([`Extra Suite concluded ${conclusion}`]);
        expect(gaps.missing).toEqual([]);
      }
    });

    test("a completed run with a null conclusion fails closed, spelled out", () => {
      const gaps = expectedSetGaps(
        input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [run({ conclusion: null })] }),
      );
      expect(gaps.failed).toEqual(["Extra Suite concluded null"]);
    });

    test("only runs of the judged event count - a green push run never satisfies a PR member", () => {
      const gaps = expectedSetGaps(
        input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [run({ event: "push" })] }),
      );
      expect(gaps.missing).toEqual(["Extra Suite has no pull_request run at this sha"]);
    });

    test("the NEWEST run (highest id) is the judged one, in either order", () => {
      const stale = run({ id: 1, conclusion: "failure" });
      const fresh = run({ id: 2, conclusion: "success" });
      expect(
        expectedSetGaps(
          input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [stale, fresh] }),
        ),
      ).toEqual({ missing: [], failed: [] });
      expect(
        expectedSetGaps(
          input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [fresh, stale] }),
        ),
      ).toEqual({ missing: [], failed: [] });
    });

    test("tied ids judge the LAST record, matching the engine's jq max_by (a shifting --paginate window can serve one run twice, in differing states)", () => {
      const asFailure = run({ id: 7, conclusion: "failure" });
      const asSuccess = run({ id: 7, conclusion: "success" });
      expect(
        expectedSetGaps(
          input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [asFailure, asSuccess] }),
        ),
      ).toEqual({ missing: [], failed: [] });
      expect(
        expectedSetGaps(
          input({ conditionalWorkflows: ["Extra Suite"], runsAtSha: [asSuccess, asFailure] }),
        ).failed,
      ).toEqual(["Extra Suite concluded failure"]);
    });

    test("a re-triggered member resets to MISSING while its newer run is in flight", () => {
      const gaps = expectedSetGaps(
        input({
          conditionalWorkflows: ["Extra Suite"],
          runsAtSha: [run({ id: 1 }), run({ id: 2, status: "in_progress", conclusion: null })],
        }),
      );
      expect(gaps.missing).toEqual(["Extra Suite is still in_progress"]);
    });

    test("one display name spanning two workflow PATHS at the sha fails closed, even with a success among them, paths sorted", () => {
      const gaps = expectedSetGaps(
        input({
          conditionalWorkflows: ["Extra Suite"],
          runsAtSha: [run({ id: 1, path: ".github/workflows/other.yml" }), run({ id: 2 })],
        }),
      );
      expect(gaps.failed).toEqual([
        "Extra Suite is two different workflows at this sha (.github/workflows/extra.yml, .github/workflows/other.yml)",
      ]);
      expect(gaps.missing).toEqual([]);
    });

    test("a name the workflow registry resolves to two paths fails closed, even when only one ran green", () => {
      const gaps = expectedSetGaps(
        input({
          conditionalWorkflows: ["Extra Suite"],
          runsAtSha: [run()],
          workflowRegistry: [
            { name: "Extra Suite", path: ".github/workflows/other.yml" },
            { name: "Extra Suite", path: ".github/workflows/extra.yml" },
          ],
        }),
      );
      expect(gaps.failed).toEqual([
        "Extra Suite is claimed by 2 workflows (.github/workflows/extra.yml, .github/workflows/other.yml)",
      ]);
      expect(gaps.missing).toEqual([]);
    });

    test("a single-owner registry entry and other names' entries change nothing", () => {
      const gaps = expectedSetGaps(
        input({
          conditionalWorkflows: ["Extra Suite"],
          runsAtSha: [run()],
          workflowRegistry: [
            { name: "Extra Suite", path: ".github/workflows/extra.yml" },
            { name: "CI", path: ".github/workflows/ci.yml" },
            { name: "CI", path: ".github/workflows/ci-legacy.yml" },
          ],
        }),
      );
      expect(gaps).toEqual({ missing: [], failed: [] });
    });

    test("a duplicated roster entry is judged once", () => {
      const gaps = expectedSetGaps(
        input({ conditionalWorkflows: ["Ghost Workflow", "Ghost Workflow"], runsAtSha: [] }),
      );
      expect(gaps.missing).toEqual(["Ghost Workflow has no pull_request run at this sha"]);
    });

    test("independent members gap independently, reported name-sorted", () => {
      const gaps = expectedSetGaps(
        input({
          conditionalWorkflows: ["Red Suite", "Ghost Workflow", "Extra Suite"],
          runsAtSha: [
            run(),
            run({
              id: 2,
              name: "Red Suite",
              path: ".github/workflows/red.yml",
              conclusion: "failure",
            }),
          ],
          workflowRegistry: [
            { name: "Extra Suite", path: ".github/workflows/extra.yml" },
            { name: "Ghost Workflow", path: ".github/workflows/ghost.yml" },
            { name: "Red Suite", path: ".github/workflows/red.yml" },
          ],
        }),
      );
      expect(gaps.missing).toEqual(["Ghost Workflow has no pull_request run at this sha"]);
      expect(gaps.failed).toEqual(["Red Suite concluded failure"]);
    });
  });

  describe("the Copilot review member", () => {
    const required = { requireCopilotReview: true };

    test("not required: no expectation even with no check present", () => {
      expect(expectedSetGaps(input({ checkRunsAtSha: [] }))).toEqual({ missing: [], failed: [] });
    });

    test("required on a human PR with no check run: MISSING", () => {
      const gaps = expectedSetGaps(input({ ...required, checkRunsAtSha: [] }));
      expect(gaps.missing).toEqual([
        `Copilot's ${COPILOT_CHECK_NAME} check run has not been created`,
      ]);
    });

    test("a bot AUTHOR stands the expectation down (the author, never a run actor, is the key)", () => {
      const gaps = expectedSetGaps(input({ ...required, authorIsBot: true, checkRunsAtSha: [] }));
      expect(gaps).toEqual({ missing: [], failed: [] });
    });

    test("an unknown author (mapped to false) keeps the expectation armed - unknown can disarm nothing", () => {
      const gaps = expectedSetGaps(input({ ...required, authorIsBot: false, checkRunsAtSha: [] }));
      expect(gaps.missing).toEqual([
        `Copilot's ${COPILOT_CHECK_NAME} check run has not been created`,
      ]);
    });

    test("a completed successful check satisfies it", () => {
      const gaps = expectedSetGaps(input({ ...required, checkRunsAtSha: [copilotCheck()] }));
      expect(gaps).toEqual({ missing: [], failed: [] });
    });

    test("a success among stale attempts satisfies it (a re-requested review)", () => {
      const gaps = expectedSetGaps(
        input({
          ...required,
          checkRunsAtSha: [copilotCheck({ conclusion: "failure" }), copilotCheck()],
        }),
      );
      expect(gaps).toEqual({ missing: [], failed: [] });
    });

    test("a check still running is MISSING (pending), not failed", () => {
      const gaps = expectedSetGaps(
        input({
          ...required,
          checkRunsAtSha: [copilotCheck({ status: "in_progress", conclusion: null })],
        }),
      );
      expect(gaps.missing).toEqual([
        `Copilot's ${COPILOT_CHECK_NAME} check run is still in progress`,
      ]);
      expect(gaps.failed).toEqual([]);
    });

    test("all attempts completed without a success FAILS, naming the conclusion", () => {
      const gaps = expectedSetGaps(
        input({ ...required, checkRunsAtSha: [copilotCheck({ conclusion: "failure" })] }),
      );
      expect(gaps.failed).toEqual([`the ${COPILOT_CHECK_NAME} check run concluded failure`]);
      expect(gaps.missing).toEqual([]);
    });

    test("look-alike checks never vouch: wrong name, wrong app, app-less", () => {
      for (const lookAlike of [
        copilotCheck({ name: "copilot-pull-request-reviewer-ish" }),
        copilotCheck({ appSlug: "some-other-app" }),
        copilotCheck({ appSlug: null }),
      ]) {
        const gaps = expectedSetGaps(input({ ...required, checkRunsAtSha: [lookAlike] }));
        expect(gaps.missing).toEqual([
          `Copilot's ${COPILOT_CHECK_NAME} check run has not been created`,
        ]);
      }
    });
  });

  test("both kinds of gap surface together - nothing masks anything", () => {
    const gaps = expectedSetGaps(
      input({
        conditionalWorkflows: ["Ghost Workflow"],
        requireCopilotReview: true,
        runsAtSha: [],
        checkRunsAtSha: [],
      }),
    );
    expect(gaps.missing).toEqual([
      "Ghost Workflow has no pull_request run at this sha",
      `Copilot's ${COPILOT_CHECK_NAME} check run has not been created`,
    ]);
  });
});
