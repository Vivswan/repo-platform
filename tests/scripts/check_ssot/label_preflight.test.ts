// The label-preflight pin (scripts/check/ssot/label_preflight.ts): the
// workflow-shape judge over synthetic jobs, and the argv pin over an
// injected builder.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LayerStepFacts } from "../../../.github/scripts/fleet/settings_layer_step.ts";
import {
  invokesPreflightLeg,
  labelPreflightArgvMismatches,
  labelPreflightFileMismatches,
  labelPreflightJobMismatches,
  layerStepReadsNoFiles,
  PREFLIGHT_APPLY_JOB_KEYS,
  PREFLIGHT_APPLY_RUNS_ON,
  PREFLIGHT_APPLY_WITH,
  PREFLIGHT_ARGV_FACTS,
  PREFLIGHT_ARGV_ROWS,
  PREFLIGHT_EXPECTED_ARGV,
  PREFLIGHT_EXPECTED_RUN,
  PREFLIGHT_FORBIDDEN_RUN_TOKENS,
  PREFLIGHT_JOB_ENV_KEYS,
  PREFLIGHT_STEP_ENV_PINS,
  PREFLIGHT_STEP_KEYS,
  type PreflightArgvRow,
} from "../../../scripts/check/ssot/label_preflight.ts";

const OPERATOR = ".github/workflows/settings-repos.yml";
const SCRIPTS = join(import.meta.dir, "../../../.github/scripts");

describe("invokesPreflightLeg", () => {
  test("recognizes the labels leg at any position; a quoted path or another leg is not it", () => {
    expect(invokesPreflightLeg("bun .github/scripts/fleet/settings_layer_step.ts labels")).toBe(
      true,
    );
    expect(
      invokesPreflightLeg(
        "bun x.ts && bun .github/scripts/fleet/settings_layer_step.ts labels || true",
      ),
    ).toBe(true);
    expect(invokesPreflightLeg("bun .github/scripts/fleet/settings_layer_step.ts merge")).toBe(
      false,
    );
    expect(invokesPreflightLeg('bun ".github/scripts/fleet/settings_layer_step.ts" labels')).toBe(
      false,
    );
    expect(invokesPreflightLeg("bun .github/scripts/fleet/settings_layer_step.ts labelsx")).toBe(
      false,
    );
  });
});

describe("labelPreflightArgvMismatches", () => {
  // The suite's OWN copy of the pinned argv, asserted equal to the export:
  // an edit to the rule's table breaks this equality, not just the live
  // script's luck. Four rows: both target kinds in both modes.
  const HEAD = [
    "bun",
    join(SCRIPTS, "sync/run_hidden.ts"),
    "settings labels",
    "--",
    "bun",
    join(SCRIPTS, "fleet/label_preflight.ts"),
    "--merged",
    "/runner/_temp/merged-settings.yml",
  ];
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const OPERATOR_ROW = [...HEAD, "--repo", "Vivswan/repo-platform", "--target-dir", "."];
  const TARGET_ROW = [...HEAD, "--repo", "Vivswan/managed", "--ref", SHA];
  test("the exported argv pin equals the suite's copy, and the rows' facts match their keys", () => {
    expect(PREFLIGHT_ARGV_ROWS).toEqual([
      "operator-apply",
      "operator-check",
      "target-apply",
      "target-check",
    ]);
    expect(PREFLIGHT_EXPECTED_ARGV).toEqual({
      "operator-apply": [...OPERATOR_ROW, "--mode", "apply"],
      "operator-check": [...OPERATOR_ROW, "--mode", "check"],
      "target-apply": [...TARGET_ROW, "--mode", "apply"],
      "target-check": [...TARGET_ROW, "--mode", "check"],
    });
    for (const row of PREFLIGHT_ARGV_ROWS) {
      const [kind, mode] = row.split("-");
      expect(PREFLIGHT_ARGV_FACTS[row].operator).toBe(kind === "operator");
      expect(PREFLIGHT_ARGV_FACTS[row].mode).toBe(mode);
      expect(PREFLIGHT_ARGV_FACTS[row].pinned).toBe(SHA);
    }
  });

  test("the live builder judges clean (positive control)", () => {
    expect(labelPreflightArgvMismatches()).toEqual([]);
  });

  test("a layer step that reads files fires the trust boundary; the live source passes", () => {
    const live = readFileSync(join(SCRIPTS, "fleet/settings_layer_step.ts"), "utf-8");
    expect(layerStepReadsNoFiles(live)).toBe(true);
    for (const reader of [
      'import { readFileSync } from "node:fs";\n',
      'import { readFile } from "node:fs/promises";\n',
      'const mode = await Bun.file(".mode").text();\n',
    ]) {
      const fired = labelPreflightArgvMismatches(
        (facts) => PREFLIGHT_EXPECTED_ARGV[rowOf(facts)],
        `${reader}${live}`,
      );
      expect(fired.map((m) => m.got)).toEqual(["a node:fs import or Bun.file call"]);
    }
  });

  const rowOf = (facts: LayerStepFacts): PreflightArgvRow =>
    `${facts.operator ? "operator" : "target"}-${facts.mode}` as PreflightArgvRow;
  const report = (mutate: (argv: string[], facts: LayerStepFacts) => string[]) =>
    labelPreflightArgvMismatches((facts) =>
      mutate([...PREFLIGHT_EXPECTED_ARGV[rowOf(facts)]], facts),
    )
      .map((m) => `${m.file}: ${m.expected} => ${m.got}`)
      .join("\n");

  test("an extra --sections flag fires the argv pin on every row", () => {
    const fired = report((argv) => [
      ...argv.slice(0, -2),
      "--sections",
      "issues",
      ...argv.slice(-2),
    ]);
    for (const row of PREFLIGHT_ARGV_ROWS) expect(fired).toContain(`labels leg, ${row} row`);
    expect(fired).toContain("first difference at element 12");
  });

  test("an unwrapped leg fires: the wrapper is part of the pin", () => {
    expect(report((argv) => argv.slice(4))).toContain("first difference at element 1");
  });

  test("a builder folding apply into check fires only the apply rows", () => {
    const fired = report((argv) => argv.map((word) => (word === "apply" ? "check" : word)));
    expect(fired).toContain("operator-apply row");
    expect(fired).toContain("target-apply row");
    expect(fired).not.toContain("operator-check row");
    expect(fired).not.toContain("target-check row");
  });

  test("a fetched row reading the checkout fires only the target rows", () => {
    const fired = report((argv, facts) =>
      facts.operator ? argv : argv.map((word) => (word === "--ref" ? "--target-dir" : word)),
    );
    expect(fired).toContain("target-apply row");
    expect(fired).toContain("target-check row");
    expect(fired).not.toContain("operator-");
  });
});

describe("labelPreflightJobMismatches", () => {
  const MODE = "${{ inputs.check_only && 'check' || 'apply' }}";
  const TOKEN = "${{ secrets.REPO_PLATFORM_TOKEN }}";
  const PINNED = "${{ steps.render.outputs.ref }}";
  type Job = { steps: Record<string, unknown>[]; [key: string]: unknown };
  const operatorJob = (): Job => ({
    "runs-on": "ubuntu-latest",
    steps: [
      {
        name: "Preflight labels the target still references",
        id: "labels",
        if: "steps.freshness.outputs.moved == 'false'",
        env: { GH_TOKEN: TOKEN, TARGET: "${{ steps.resolve.outputs.repo }}", MODE, PINNED },
        run: PREFLIGHT_EXPECTED_RUN[OPERATOR],
      },
      {
        name: "Report a stood-down label preflight",
        if: "steps.labels.outputs.not_applicable == 'true'",
        run: 'echo "::notice::label preflight stood down for ${{ matrix.repo }}: ${{ steps.labels.outputs.reason }}"\n',
      },
      {
        id: "apply",
        if: "steps.freshness.outputs.moved == 'false'",
        uses: "Vivswan/github-settings-as-code@sha",
        with: {
          token: TOKEN,
          mode: MODE,
          repository: "${{ steps.resolve.outputs.repo }}",
          "settings-file": "${{ runner.temp }}/merged-settings.yml",
          "private-repos": "redact",
          "private-report": "issue",
          "on-missing-permission": "fail",
        },
      },
    ],
  });
  const judged = (rel: string, job: Job) =>
    labelPreflightJobMismatches(rel, "apply", job)
      .mismatches.map((m) => `${m.expected} => ${m.got}`)
      .join("\n");
  const env = (job: Job) => job.steps[0].env as Record<string, string>;

  test("the landed shape judges clean (positive control)", () => {
    expect(labelPreflightJobMismatches(OPERATOR, "apply", operatorJob())).toEqual({
      applies: 1,
      mismatches: [],
    });
  });

  test("a `|| true` suppression appended to the run line fires the byte pin", () => {
    const job = operatorJob();
    job.steps[0].run = `${PREFLIGHT_EXPECTED_RUN[OPERATOR]} || true`;
    expect(judged(OPERATOR, job)).toContain("byte-identical");
  });

  test("a run block that wraps the pinned line in other commands fires the byte pin", () => {
    const job = operatorJob();
    job.steps[0].run = `echo start\n${PREFLIGHT_EXPECTED_RUN[OPERATOR]}\n`;
    expect(judged(OPERATOR, job)).toContain("byte-identical");
  });

  // The suite's OWN copies of the census and allowlist tables, asserted
  // equal to the exports: dropping an entry from the source (say
  // "BASH_ENV") breaks this equality, not just the live files' luck, and
  // every entry below gets its own mutation test driven from the copy.
  const FORBIDDEN_TOKENS = ["GITHUB_ENV", "BASH_ENV", "GITHUB_PATH"];
  const OPERATOR_CENSUS = {
    token: { parity: "GH_TOKEN", value: TOKEN },
    mode: { parity: "MODE", value: MODE },
    repository: { parity: "TARGET", value: "${{ steps.resolve.outputs.repo }}" },
    "settings-file": { pinnedElsewhere: true },
    "private-repos": { literal: "redact" },
    "private-report": { literal: "issue" },
    "on-missing-permission": { literal: "fail" },
  } as const;

  test("the exported census and allowlist tables equal the suite's copies", () => {
    expect(PREFLIGHT_APPLY_WITH).toEqual({ [OPERATOR]: OPERATOR_CENSUS });
    expect(PREFLIGHT_STEP_ENV_PINS).toEqual({ [OPERATOR]: { PINNED } });
    expect<readonly string[]>(PREFLIGHT_FORBIDDEN_RUN_TOKENS).toEqual(FORBIDDEN_TOKENS);
    expect(PREFLIGHT_STEP_KEYS).toEqual({
      [OPERATOR]: new Set(["name", "id", "if", "env", "run"]),
    });
    expect(PREFLIGHT_JOB_ENV_KEYS).toEqual({
      [OPERATOR]: new Set(["HIDE_DETAILS", "SETTINGS_REPORT_TITLE"]),
    });
    expect(PREFLIGHT_APPLY_JOB_KEYS).toEqual({
      [OPERATOR]: new Set([
        "name",
        "needs",
        "if",
        "strategy",
        "env",
        "runs-on",
        "timeout-minutes",
        "steps",
      ]),
    });
    expect(PREFLIGHT_APPLY_RUNS_ON).toBe("ubuntu-latest");
    expect(PREFLIGHT_EXPECTED_RUN).toEqual({
      [OPERATOR]: "bun .github/scripts/fleet/settings_layer_step.ts labels",
    });
  });

  // One mutation test per census entry and per forbidden token, driven
  // from the suite-side copies above.
  const CENSUS_CASES = [[OPERATOR, operatorJob, OPERATOR_CENSUS, 2]] as const;
  for (const [rel, build, census, applyIndex] of CENSUS_CASES) {
    const applyWith = (job: Job) => job.steps[applyIndex].with as Record<string, string>;
    for (const [key, expectation] of Object.entries(census) as [
      string,
      { parity?: string; literal?: string; pinnedElsewhere?: true },
    ][]) {
      if (expectation.parity !== undefined) {
        test(`${rel}: drifting with.${key} off the pinned expression fires`, () => {
          const job = build();
          applyWith(job)[key] = "${{ github.action }}";
          expect(judged(rel, job)).toContain(`with.${key}:`);
        });
        test(`${rel}: drifting env ${expectation.parity} off the pinned expression fires`, () => {
          const job = build();
          env(job)[expectation.parity as string] = "${{ github.action }}";
          expect(judged(rel, job)).toContain(`preflight env ${expectation.parity}:`);
        });
      } else if (expectation.literal !== undefined) {
        test(`${rel}: drifting the literal with.${key} fires`, () => {
          const job = build();
          applyWith(job)[key] = "drifted";
          expect(judged(rel, job)).toContain(`with.${key}:`);
        });
      } else {
        test(`${rel}: dropping with.${key} fires presence`, () => {
          const job = build();
          delete applyWith(job)[key];
          expect(judged(rel, job)).toContain(`with.${key} present`);
        });
      }
    }
    for (const token of FORBIDDEN_TOKENS) {
      test(`${rel}: a run block mentioning ${token} fires the persisted-environment pin`, () => {
        const job = build();
        job.steps.unshift({ name: "setup", run: `echo ${token}\n` });
        expect(judged(rel, job)).toContain("persisted environment");
      });
    }
  }

  test("a drifted or dropped PINNED fires the value pin (the fetched row reads its files at it)", () => {
    const drifted = operatorJob();
    env(drifted).PINNED = "${{ github.sha }}";
    expect(judged(OPERATOR, drifted)).toContain("preflight env PINNED:");
    const dropped = operatorJob();
    delete env(dropped).PINNED;
    expect(judged(OPERATOR, dropped)).toContain("preflight env PINNED:");
  });

  test("the same context-dependent expression on BOTH sides fires the value pin (text parity alone would pass it)", () => {
    const drifted = "${{ startsWith(github.action, '__run') && 'check' || 'apply' }}";
    const job = operatorJob();
    env(job).MODE = drifted;
    (job.steps[2].with as Record<string, string>).mode = drifted;
    const report = judged(OPERATOR, job);
    expect(report).toContain("with.mode:");
    expect(report).toContain("preflight env MODE:");
  });

  test("a shell: key fires the step-key allowlist (`shell: true {0}` never runs the script)", () => {
    const job = operatorJob();
    job.steps[0].shell = "true {0}";
    expect(judged(OPERATOR, job)).toContain("pinned step keys");
  });

  test("working-directory and continue-on-error are the same rerouting class", () => {
    const moved = operatorJob();
    moved.steps[0]["working-directory"] = "/tmp";
    expect(judged(OPERATOR, moved)).toContain("pinned step keys");
    const softened = operatorJob();
    softened.steps[0]["continue-on-error"] = true;
    expect(judged(OPERATOR, softened)).toContain("pinned step keys");
  });

  test("an env var outside the census and the pins fires the env-key allowlist (BASH_ENV class)", () => {
    const job = operatorJob();
    env(job).BASH_ENV = "evil.sh";
    expect(judged(OPERATOR, job)).toContain("pinned env keys");
  });

  test("a job-level defaults: fires (defaults.run.shell reroutes every run step)", () => {
    const job = { ...operatorJob(), defaults: { run: { shell: "bash" } } };
    expect(judged(OPERATOR, job)).toContain("no defaults:");
  });

  test("an apply input outside the census fires", () => {
    const extra = operatorJob();
    (extra.steps[2].with as Record<string, string>).sections = "labels";
    expect(judged(OPERATOR, extra)).toContain("input outside the census");
  });

  test("workflow-level defaults and env fire the inherited-state checks", () => {
    const viaDefaults = labelPreflightJobMismatches(OPERATOR, "apply", operatorJob(), {
      defaults: { run: { shell: "true {0}" } },
    });
    expect(viaDefaults.mismatches.map((m) => m.expected).join("\n")).toContain(
      "no workflow-level defaults:",
    );
    const viaEnv = labelPreflightJobMismatches(OPERATOR, "apply", operatorJob(), {
      env: { BASH_ENV: "evil.sh" },
    });
    expect(viaEnv.mismatches.map((m) => m.expected).join("\n")).toContain("no workflow-level env:");
  });

  test("a job-level env var outside the pinned set fires; the landed HIDE_DETAILS pair passes", () => {
    const allowed = { ...operatorJob(), env: { HIDE_DETAILS: "x", SETTINGS_REPORT_TITLE: "y" } };
    expect(labelPreflightJobMismatches(OPERATOR, "apply", allowed).mismatches).toEqual([]);
    const smuggled = { ...operatorJob(), env: { BASH_ENV: "evil.sh" } };
    expect(judged(OPERATOR, smuggled)).toContain("pinned job-level env keys");
  });

  test("a container: or services: job key fires the execution-context census", () => {
    // A container image's env (BASH_ENV again) and PATH arrive under
    // every step-level pin's sight, so the job's keys are allowlisted.
    const contained = { ...operatorJob(), container: { image: "evil:latest" } };
    expect(judged(OPERATOR, contained)).toContain("pinned job keys");
    const serviced = { ...operatorJob(), services: { db: { image: "evil:latest" } } };
    expect(judged(OPERATOR, serviced)).toContain("pinned job keys");
  });

  test("a drifted or missing runs-on fires the hosted-runner pin", () => {
    const selfHosted = { ...operatorJob(), "runs-on": "self-hosted" };
    expect(judged(OPERATOR, selfHosted)).toContain("runs-on: ubuntu-latest");
    const { "runs-on": _, ...rest } = operatorJob();
    expect(judged(OPERATOR, rest as Job)).toContain("no runs-on");
  });

  test("a defaults: key reports once, through its dedicated check, not the key census too", () => {
    const job = { ...operatorJob(), defaults: { run: { shell: "bash" } } };
    const report = judged(OPERATOR, job);
    expect(report).toContain("no defaults:");
    expect(report).not.toContain("pinned job keys");
  });

  test("degenerate jobs judge clean with zero applies", () => {
    expect(labelPreflightJobMismatches(OPERATOR, "select", {})).toEqual({
      applies: 0,
      mismatches: [],
    });
    expect(
      labelPreflightJobMismatches(OPERATOR, "select", { steps: [{ run: "echo hi" }] }),
    ).toEqual({ applies: 0, mismatches: [] });
  });

  test("an apply-free document throws anchor-lost at the file level; the landed shape judges clean there", () => {
    expect(() =>
      labelPreflightFileMismatches(OPERATOR, { jobs: { select: { steps: [{ run: "echo hi" }] } } }),
    ).toThrow("anchor lost");
    expect(labelPreflightFileMismatches(OPERATOR, { jobs: { apply: operatorJob() } })).toEqual([]);
  });

  test("a missing preflight fires; a mention without the labels leg gets its own message", () => {
    const gone = operatorJob();
    gone.steps.splice(0, 1);
    expect(judged(OPERATOR, gone)).toContain("no such step");
    const quoted = operatorJob();
    quoted.steps[0].run = 'bun ".github/scripts/fleet/settings_layer_step.ts" labels\n';
    expect(judged(OPERATOR, quoted)).toContain("unexpected invocation form");
    const direct = operatorJob();
    direct.steps[0].run = "bun .github/scripts/fleet/label_preflight.ts --merged x\n";
    expect(judged(OPERATOR, direct)).toContain("unexpected invocation form");
  });

  test("a second preflight step fires exactly-one", () => {
    const job = operatorJob();
    job.steps.unshift({ ...operatorJob().steps[0] });
    expect(judged(OPERATOR, job)).toContain("exactly one label-preflight step");
  });

  test("a preflight after the apply fires ordering", () => {
    const job = operatorJob();
    job.steps.reverse();
    expect(judged(OPERATOR, job)).toContain("BEFORE the settings apply");
  });

  test("a drifted condition fires the trim-normalized equality", () => {
    const job = operatorJob();
    job.steps[0].if = "steps.render.outputs.skipped == 'false'";
    expect(judged(OPERATOR, job)).toContain("identical (after trimming) to the apply step's");
  });

  test("a renamed operator step id fires the stood-down-notice coupling", () => {
    const job = operatorJob();
    job.steps[0].id = "labelz";
    expect(judged(OPERATOR, job)).toContain("id: labels");
  });

  test("a second apply step fires exactly-one (a later apply would sit outside the guarded gap)", () => {
    const job = operatorJob();
    job.steps.push({ run: "echo tamper" }, { ...operatorJob().steps[2] });
    expect(judged(OPERATOR, job)).toContain("exactly one settings apply step");
  });

  test("an intervening step between preflight and apply fires the gap pin", () => {
    const job = operatorJob();
    job.steps.splice(1, 0, { run: "echo tamper" });
    expect(judged(OPERATOR, job)).toContain("between the preflight and the apply");
  });

  test("a drifted or over-keyed gap step fires the gap pin", () => {
    const drifted = operatorJob();
    drifted.steps[1].run = 'echo "::notice::something else"\n';
    expect(judged(OPERATOR, drifted)).toContain("matching the pinned stood-down notice");
    const overKeyed = operatorJob();
    overKeyed.steps[1].env = { X: "y" };
    expect(judged(OPERATOR, overKeyed)).toContain("exactly the keys [if, name, run]");
  });

  test("a prior step writing persisted environment fires", () => {
    const job = operatorJob();
    job.steps.unshift({
      name: "Innocent setup",
      run: 'echo "BASH_ENV=/tmp/hook" >> "$GITHUB_ENV"\n',
    });
    const report = judged(OPERATOR, job);
    expect(report).toContain("persisted environment");
    expect(report).toContain("GITHUB_ENV");
  });

  test("an unknown rel throws instead of judging vacuously", () => {
    expect(() => labelPreflightJobMismatches("other.yml", "j", { steps: [] })).toThrow(
      "no pinned preflight shape",
    );
  });
});
