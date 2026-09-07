// The label-preflight invocation grammar (scripts/check/ssot/label_preflight.ts).

import { describe, expect, test } from "bun:test";
import {
  labelPreflightFileMismatches,
  labelPreflightJobMismatches,
  PREFLIGHT_APPLY_JOB_KEYS,
  PREFLIGHT_APPLY_RUNS_ON,
  PREFLIGHT_APPLY_WITH,
  PREFLIGHT_EXPECTED_RUN,
  PREFLIGHT_FORBIDDEN_RUN_TOKENS,
  PREFLIGHT_JOB_ENV_KEYS,
  PREFLIGHT_STEP_KEYS,
  preflightArgs,
  preflightInvocation,
  shellSegments,
} from "../../../scripts/check/ssot/label_preflight.ts";

describe("shellSegments", () => {
  test("drops comment lines and trailing comments, joins continuations", () => {
    const run = [
      "# a lead comment naming fleet/label_preflight.ts",
      "bun x \\",
      "  --flag v # trailing comment",
      "echo done",
    ].join("\n");
    expect(shellSegments(run)).toEqual(["bun x    --flag v ", "echo done"]);
    // The join itself, isolated: a backslash-newline splices the next
    // line into the same segment instead of opening a new one.
    expect(shellSegments("a \\\nb")).toEqual(["a  b"]);
    expect(shellSegments("a \nb")).toEqual(["a ", "b"]);
  });

  test("splits compound commands at ;, &&, and ||", () => {
    expect(shellSegments("a; b && c || d")).toEqual(["a", " b ", " c ", " d"]);
  });

  test("a commented-out continuation line breaks its command chain", () => {
    const run = [
      'bun run_hidden.ts "x" -- \\',
      "# bun fleet/label_preflight.ts \\",
      "  --merged y",
    ].join("\n");
    // The comment swallows the joined tail; the invocation is gone.
    expect(shellSegments(run)).toEqual(['bun run_hidden.ts "x" --  ']);
  });

  test("quote-aware: a #, ;, &&, or || inside a quoted string is data, not a split or comment", () => {
    expect(shellSegments('echo "a # b"')).toEqual(['echo "a # b"']);
    expect(shellSegments('echo "a; b && c"')).toEqual(['echo "a; b && c"']);
    expect(shellSegments('echo "a || b"')).toEqual(['echo "a || b"']);
  });

  test("heredoc bodies are dropped as text; openers stay executable", () => {
    expect(shellSegments(["cat <<EOF", "body line", "EOF", "echo after"].join("\n"))).toEqual([
      "cat <<EOF",
      "echo after",
    ]);
    // Quoted and tab-indented delimiter spellings; content past each
    // terminator survives, so a never-closing mutant diverges here.
    expect(shellSegments(['cat <<"END"', "body", "END", "echo after"].join("\n"))).toEqual([
      'cat <<"END"',
      "echo after",
    ]);
    expect(shellSegments(["cat <<-EOF", "\tbody", "\tEOF", "echo after"].join("\n"))).toEqual([
      "cat <<-EOF",
      "echo after",
    ]);
  });

  test("an indented terminator look-alike is still body for <<WORD; only <<- strips tabs", () => {
    const segments = shellSegments(
      [
        "cat <<EOF",
        " EOF",
        "bun .github/scripts/fleet/label_preflight.ts --merged x",
        "EOF",
        "echo after",
      ].join("\n"),
    );
    expect(segments).toEqual(["cat <<EOF", "echo after"]);
  });

  test("multiple heredocs on one line close in POSIX order", () => {
    const segments = shellSegments(
      [
        "cat <<A <<B",
        "a-body",
        "A",
        "b-body: bun .github/scripts/fleet/label_preflight.ts --merged x",
        "B",
        "echo done",
      ].join("\n"),
    );
    expect(segments).toEqual(["cat <<A <<B", "echo done"]);
  });

  test("a non-word heredoc delimiter is still a heredoc; its body is text", () => {
    const segments = shellSegments(
      ["cat <<@", "bun .github/scripts/fleet/label_preflight.ts --merged x", "@"].join("\n"),
    );
    expect(segments).toEqual(["cat <<@"]);
  });
});

describe("preflightInvocation", () => {
  const direct =
    '          bun platform/.github/scripts/fleet/label_preflight.ts --merged "$RUNNER_TEMP/merged-settings.yml"';
  const hidden =
    '            bun .github/scripts/sync/run_hidden.ts "settings labels" --   bun .github/scripts/fleet/label_preflight.ts   --merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --target-dir . --mode "$MODE"';

  test("recognizes the direct and the run_hidden-wrapped shapes", () => {
    expect(preflightInvocation(direct)).toBe("direct");
    expect(preflightInvocation(hidden)).toBe("hidden");
  });

  test("echoed and argument-position spoofs are not invocations", () => {
    expect(
      preflightInvocation("echo bun platform/.github/scripts/fleet/label_preflight.ts --merged x"),
    ).toBeNull();
    expect(
      preflightInvocation(
        'bun .github/scripts/sync/run_hidden.ts "settings labels" -- echo bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
  });

  test("a quoted script path is an unrecognized form, failing closed", () => {
    expect(
      preflightInvocation('bun ".github/scripts/fleet/label_preflight.ts" --merged x'),
    ).toBeNull();
  });

  test("a SUBSTITUTED wrapper is not the hidden form - only sync/run_hidden.ts wraps", () => {
    // The discriminator a wrapper-regex widening (any .ts, or any
    // run_hidden.ts path) would break: removing the wrapper is covered
    // elsewhere, but a DIFFERENT wrapper in the same position must fail
    // the grammar too, or a capture-less stand-in could swallow the
    // guard's output while every other pinned fact reads intact.
    expect(
      preflightInvocation(
        'bun .github/scripts/sync/other_wrapper.ts "settings labels" -- bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
    expect(
      preflightInvocation(
        'bun .github/scripts/fleet/run_hidden.ts "settings labels" -- bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
  });

  test("a stem glued to a preceding non-separator is a different tree's file, not the wrapper or script", () => {
    expect(
      preflightInvocation(
        'bun not-sync/run_hidden.ts "settings labels" -- bun .github/scripts/fleet/label_preflight.ts --merged x',
      ),
    ).toBeNull();
    expect(
      preflightInvocation("bun .github/scripts/myfleet/label_preflight.ts --merged x"),
    ).toBeNull();
    expect(
      preflightInvocation("bun .github/scripts/my.fleet/label_preflight.ts --merged x"),
    ).toBeNull();
    // The landed prefixed spellings still read as invocations.
    expect(
      preflightInvocation("bun platform/.github/scripts/fleet/label_preflight.ts --merged x"),
    ).toBe("direct");
  });

  test("an inline env-assignment prefix is an unrecognized form, failing closed", () => {
    expect(
      preflightInvocation("MODE=check bun .github/scripts/fleet/label_preflight.ts --merged x"),
    ).toBeNull();
  });

  test("an || suffix becomes its own segment at the grammar level (labelPreflightJobMismatches proves the byte pin rejects the suppression)", () => {
    const segments = shellSegments(
      "bun .github/scripts/fleet/label_preflight.ts --merged x || true",
    );
    expect(segments.map(preflightInvocation)).toEqual(["direct", null]);
  });

  test("the EXACT allowlisted command inside a heredoc body is not an invocation", () => {
    const segments = shellSegments(
      [
        "cat <<EOF",
        "bun platform/.github/scripts/fleet/label_preflight.ts --merged " +
          '"$RUNNER_TEMP/merged-settings.yml" --repo "$GITHUB_REPOSITORY" --target-dir . ' +
          '--sections "$SECTIONS" --required-sections "$REQUIRED_SECTIONS" --mode "$MODE" ' +
          '--on-missing-permission "$ON_MISSING_PERMISSION"',
        "EOF",
      ].join("\n"),
    );
    expect(segments.map(preflightInvocation)).toEqual([null]);
  });

  test("an exact command inside single-quoted data does not split into a phantom invocation", () => {
    const segments = shellSegments(
      "echo 'decoy; bun platform/.github/scripts/fleet/label_preflight.ts --merged x; ignored'",
    );
    expect(segments).toHaveLength(1);
    expect(segments.map(preflightInvocation)).toEqual([null]);
  });

  test("an exact command smuggled into run_hidden's quoted label is not the wrapped command", () => {
    // The label carries the full invocation text; the real separator
    // runs `true`. The label must be one CLOSED double-quoted argument
    // directly before `--`, so the smuggle is not an invocation.
    const intact =
      'bun .github/scripts/sync/run_hidden.ts "x -- bun .github/scripts/fleet/label_preflight.ts --merged x --repo y --target-dir . --mode apply" -- true';
    expect(preflightInvocation(intact)).toBeNull();
    // The ` #` variant: comment truncation leaves the label unterminated,
    // which the closed-quote anchor rejects too.
    const truncated = shellSegments(
      'bun .github/scripts/sync/run_hidden.ts "x -- bun .github/scripts/fleet/label_preflight.ts --merged x --repo y --target-dir . --mode apply #" -- true',
    );
    expect(truncated.map(preflightInvocation)).toEqual([null]);
  });
});

describe("preflightArgs", () => {
  test("normalizes whitespace across joined continuations", () => {
    expect(
      preflightArgs(
        '  bun .github/scripts/fleet/label_preflight.ts    --merged "$RUNNER_TEMP/merged-settings.yml"   --repo "$TARGET" --target-dir . --mode "$MODE"',
      ),
    ).toBe(
      '--merged "$RUNNER_TEMP/merged-settings.yml" --repo "$TARGET" --target-dir . --mode "$MODE"',
    );
  });

  test("keeps extra, repeated, and drifted flags visible in the normalized args (labelPreflightJobMismatches proves the allowlist rejects them)", () => {
    expect(preflightArgs("bun s/fleet/label_preflight.ts --merged x --sections issues")).toBe(
      "--merged x --sections issues",
    );
    expect(preflightArgs('bun s/fleet/label_preflight.ts --mode "$MODE" --mode check')).toBe(
      '--mode "$MODE" --mode check',
    );
    expect(preflightArgs('bun s/fleet/label_preflight.ts --target-dir "$RUNNER_TEMP"')).toBe(
      '--target-dir "$RUNNER_TEMP"',
    );
  });
});

describe("labelPreflightJobMismatches", () => {
  const OPERATOR = ".github/workflows/settings-repos.yml";
  const MODE = "${{ inputs.check_only && 'check' || 'apply' }}";
  const TOKEN = "${{ secrets.REPO_PLATFORM_TOKEN }}";
  type Job = { steps: Record<string, unknown>[]; [key: string]: unknown };
  const operatorJob = (): Job => ({
    "runs-on": "ubuntu-latest",
    steps: [
      {
        name: "Preflight labels the target still references",
        id: "labels",
        if: "steps.freshness.outputs.moved == 'false'",
        env: { GH_TOKEN: TOKEN, TARGET: "${{ steps.resolve.outputs.repo }}", MODE },
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

  test("a `|| true` suppression appended to the run block fires the byte pin", () => {
    const job = operatorJob();
    job.steps[0].run = `${PREFLIGHT_EXPECTED_RUN[OPERATOR].trimEnd()} || true\n`;
    expect(judged(OPERATOR, job)).toContain("byte-identical");
  });

  test("an extra --sections flag fires the argument allowlist", () => {
    const job = operatorJob();
    job.steps[0].run = PREFLIGHT_EXPECTED_RUN[OPERATOR].replace(
      '--mode "$MODE"',
      '--sections issues --mode "$MODE"',
    );
    expect(judged(OPERATOR, job)).toContain("argument lists");
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

  test("an env var outside the mirrored census fires the env-key allowlist (BASH_ENV class)", () => {
    const job = operatorJob();
    env(job).BASH_ENV = "evil.sh";
    expect(judged(OPERATOR, job)).toContain("mirrored env keys");
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

  test("a missing preflight fires; an unrecognized form gets its own message", () => {
    const gone = operatorJob();
    gone.steps.splice(0, 1);
    expect(judged(OPERATOR, gone)).toContain("no such step");
    const quoted = operatorJob();
    quoted.steps[0].run = 'bun ".github/scripts/fleet/label_preflight.ts" --merged x\n';
    expect(judged(OPERATOR, quoted)).toContain("unexpected invocation form");
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

  test("an unwrapped operator invocation fires the run_hidden requirement", () => {
    const job = operatorJob();
    job.steps[0].run = String(job.steps[0].run).replaceAll(
      /bun \.github\/scripts\/sync\/run_hidden\.ts "settings labels" -- \\\n {4}/g,
      "",
    );
    expect(judged(OPERATOR, job)).toContain("wrapped in run_hidden.ts");
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
