import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  heldRunNoticeMismatches,
  NOTICE_SOURCES,
  type NoticeKind,
  OUTPUT_LINE,
  POSTED_IF,
  POSTED_MESSAGE,
  WARNING_LINE,
} from "../../../scripts/check/ssot/held_run_notice.ts";

describe("held-run-notice", () => {
  const SCRIPT = "actions/dedupe-bun-lockfile/dedupe-bun-lockfile.ts";
  const WORKFLOW = "files/base/.github/workflows/auto-format.yml";
  const FACT =
    "GitHub holds the new head's pull_request run for approval, so its checks stay unreported. " +
    "Approve the run from the PR's merge box or the Actions tab, or push a commit to this branch.";
  const STICKY =
    "        uses: marocchino/sticky-pull-request-comment@5770ad5eb8f42dd2c4f34da00c94c5381e49af88 # v3.0.5";
  const source = (rel: string, kind: NoticeKind, text: string) => ({ rel, kind, text });
  type Sources = Parameters<typeof heldRunNoticeMismatches>[0];

  // The script's notice is a + chain, as a formatter leaves a long string.
  const script = (notice: string) =>
    `const PUSHED_NOTICE =\n  ${JSON.stringify(notice.slice(0, 70))} +\n  ${JSON.stringify(notice.slice(70))};\n`;
  interface Shape {
    /** The folded NOTICE scalar's source lines. */
    notice: string[];
    run?: string[];
    /** The sticky step's message value, then its continuation lines. */
    message?: string[];
    stickyIf?: string;
    /** Extra source lines after the sticky step. */
    tail?: string[];
  }
  const workflow = ({
    notice,
    run = [OUTPUT_LINE, WARNING_LINE],
    message = [POSTED_MESSAGE],
    stickyIf = POSTED_IF,
    tail = [],
  }: Shape) =>
    [
      "name: Auto Format",
      "on:",
      "  pull_request:",
      "    types: [labeled]",
      "jobs:",
      "  format:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
      "      - name: Commit and push changes",
      "        id: push",
      "        env:",
      "          NOTICE: >-",
      ...notice.map((line) => `            ${line}`),
      "        run: |",
      "          git push origin HEAD",
      ...run.map((line) => `          ${line}`),
      "      - name: Comment how to release the held run",
      `        if: ${stickyIf}`,
      STICKY,
      "        with:",
      "          header: repo-platform/auto-format",
      `          message: ${message[0]}`,
      ...message.slice(1).map((line) => `            ${line}`),
      ...tail,
    ].join("\n");
  const scriptNotice = `Lockfile dedupe commit pushed with the workflow token: ${FACT}`;
  const formatNotice = `Formatting commit pushed with the workflow token: ${FACT}`;
  const [head, rest] = [
    formatNotice.slice(0, formatNotice.indexOf(", so")),
    formatNotice.slice(formatNotice.indexOf(", so") + 1).trimStart(),
  ];
  const pair = (shape: Shape): Sources => [
    source(SCRIPT, "script", script(scriptNotice)),
    source(WORKFLOW, "workflow", workflow(shape)),
  ];

  test("the roster names one script and one workflow", () => {
    expect(NOTICE_SOURCES).toEqual([
      { rel: SCRIPT, kind: "script" },
      { rel: WORKFLOW, kind: "workflow" },
    ]);
  });

  test.each([
    { shape: "one line", sources: pair({ notice: [formatNotice] }) },
    {
      shape: "the notice folded over two source lines",
      sources: pair({ notice: [`${head},`, rest] }),
    },
    {
      shape: "the wiring lines among others in the run",
      sources: pair({
        notice: [formatNotice],
        run: ["# a note", OUTPUT_LINE, "echo done", WARNING_LINE],
      }),
    },
  ])("the same fact after the seam, wired through: $shape", ({ sources }) => {
    expect(heldRunNoticeMismatches(sources)).toEqual([]);
  });

  test.each<{ reason: string; sources: Sources; mismatches: Mismatch[] }>([
    {
      reason: "the workflow's fact drifted",
      sources: pair({ notice: [formatNotice.replace("a commit", "an empty commit")] }),
      mismatches: [
        {
          file: WORKFLOW,
          expected: `${SCRIPT}'s: ${FACT}`,
          got: FACT.replace("a commit", "an empty commit"),
        },
      ],
    },
    {
      reason: "a literal sticky message beside the NOTICE env, as a folded block scalar",
      sources: pair({ notice: [formatNotice], message: [">", `${head},`, rest] }),
      mismatches: [
        {
          file: WORKFLOW,
          expected: `with.message: ${POSTED_MESSAGE}`,
          got: `with.message: ${formatNotice}\n`,
        },
      ],
    },
    {
      reason: "a literal sticky message single-quoted with '' escapes, equal to NOTICE once parsed",
      sources: pair({
        notice: [formatNotice],
        message: [`'${formatNotice.replaceAll("'", "''")}'`],
      }),
      mismatches: [
        {
          file: WORKFLOW,
          expected: `with.message: ${POSTED_MESSAGE}`,
          got: `with.message: ${formatNotice}`,
        },
      ],
    },
    {
      reason: "the stale sticky message restored beside a corrected NOTICE",
      sources: pair({
        notice: [formatNotice],
        message: [
          ">",
          "Pushed a formatting commit with the default workflow token, which starts no workflows,",
          "so the new head's `pull_request` run waits for approval.",
          "Open it in the Actions tab and choose **Approve and run**, or push an empty commit.",
        ],
      }),
      mismatches: [
        {
          file: WORKFLOW,
          expected: `with.message: ${POSTED_MESSAGE}`,
          got:
            "with.message: Pushed a formatting commit with the default workflow token, which starts no workflows, " +
            "so the new head's `pull_request` run waits for approval. " +
            "Open it in the Actions tab and choose **Approve and run**, or push an empty commit.\n",
        },
      ],
    },
    {
      reason: "the warning echoes its own text and the sticky step keys on a flag output",
      sources: pair({
        notice: [formatNotice],
        run: ['echo "no_retrigger=true" >> "$GITHUB_OUTPUT"', `echo "::warning::${head}."`],
        stickyIf: "steps.push.outputs.no_retrigger == 'true'",
      }),
      mismatches: [
        { file: WORKFLOW, expected: `the push step running ${OUTPUT_LINE}`, got: "no such line" },
        { file: WORKFLOW, expected: `the push step running ${WARNING_LINE}`, got: "no such line" },
        {
          file: WORKFLOW,
          expected: `if: ${POSTED_IF}`,
          got: "if: steps.push.outputs.no_retrigger == 'true'",
        },
      ],
    },
    {
      reason: "a notice with no seam is shapeless, so it is not compared",
      sources: pair({ notice: ["Formatting commit pushed; approve the run."] }),
      mismatches: [
        {
          file: WORKFLOW,
          expected:
            "a notice shaped `<what was pushed> with the workflow token: <the fact and the way out>`",
          got: "Formatting commit pushed; approve the run.",
        },
      ],
    },
  ])("$reason -> the whole mismatch list", ({ sources, mismatches }) => {
    expect(heldRunNoticeMismatches(sources)).toEqual(mismatches);
  });

  const OTHER_JOB = ["  post:", "    runs-on: ubuntu-latest", "    steps:"];

  test.each([
    {
      reason: "a push step whose env carries no NOTICE",
      text: workflow({ notice: [] }).replace("          NOTICE: >-\n", "          FLAG: yes\n"),
      lost: "no NOTICE env on the push step",
    },
    {
      reason: "no step with id push",
      text: workflow({ notice: [formatNotice] }).replace("        id: push\n", ""),
      lost: "0 jobs with a step id push",
    },
    {
      reason: "a second job with its own push step writing the output the sticky step reads",
      text: workflow({
        notice: [formatNotice],
        tail: [
          ...OTHER_JOB,
          "      - id: push",
          '        run: echo "notice=stale" >> "$GITHUB_OUTPUT"',
        ],
      }),
      lost: "2 jobs with a step id push",
    },
    {
      reason: "no sticky comment step",
      text: workflow({ notice: [formatNotice] }).replace(
        STICKY,
        "        uses: actions/github-script@v7",
      ),
      lost: "0 sticky comment steps",
    },
    {
      reason: "the sticky step in another job, where the push step's output does not reach",
      text: workflow({
        notice: [formatNotice],
        tail: [...OTHER_JOB, `      -${STICKY.slice(7)}`],
      }).replace(STICKY, "        uses: actions/github-script@v7"),
      lost: "0 sticky comment steps",
    },
    {
      reason: "two sticky comment steps",
      text: workflow({ notice: [formatNotice], tail: [`      -${STICKY.slice(7)}`] }),
      lost: "2 sticky comment steps",
    },
  ])("$reason -> anchor lost", ({ text, lost }) => {
    expect(() =>
      heldRunNoticeMismatches([
        source(SCRIPT, "script", script(scriptNotice)),
        source(WORKFLOW, "workflow", text),
      ]),
    ).toThrow(`${WORKFLOW}: anchor for the held-run notice not found (${lost})`);
  });

  test("a single source has nothing to compare against", () => {
    expect(() => heldRunNoticeMismatches([source(SCRIPT, "script", script(scriptNotice))])).toThrow(
      "anchor lost",
    );
  });
});
