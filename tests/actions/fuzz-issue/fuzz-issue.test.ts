// The body assembly is covered whole, through the script the composite runs; the gh plumbing lives in action.yml and its own test.

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  blockTitle,
  buildBody,
  buildGenericBody,
  capChars,
  closeComment,
  failureDirs,
  head,
  type Stream,
} from "../../../actions/fuzz-issue/fuzz-issue.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();

const env = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
} as NodeJS.ProcessEnv;
const RUN = "Run: https://github.com/o/r/actions/runs/42";

/**
 * Every body under test stamps the UTC day at call time, so the clock is
 * frozen for the whole file and the expected date is a literal (a date read
 * once at module load would race midnight against the source's own read).
 */
const date = "2026-03-04";
beforeAll(() => setSystemTime(new Date(`${date}T12:00:00Z`)));
afterAll(() => setSystemTime());

const reportDir = (root: string, name: string, report?: string): void => {
  mkdirSync(join(root, name), { recursive: true });
  if (report !== undefined) writeFileSync(join(root, name, "report.md"), report);
};

describe("the cuts", () => {
  // A head that split a line would lose a URL silently; the marker is reserved at the largest count it can name, so
  // adding it never overflows the character cap, and a first line wider than the cap is kept whole for capChars.
  const five = ["1", "2", "3", "4", "5"].join("\n");
  test.each<{ cut: () => string; expected: string; reason: string }>([
    { cut: () => head("a\nb\nc", 5, 100), expected: "a\nb\nc", reason: "within both limits" },
    {
      cut: () => head("1\n2\n3\n", 3, 100),
      expected: "1\n2\n3",
      reason: "a single trailing newline is not a line",
    },
    { cut: () => head(five, 2, 100), expected: "1\n2\n... (3 more lines)", reason: "the line cap" },
    {
      cut: () => head(five, 10, 9),
      expected: five,
      reason: "text that exactly fills the character cap needs no marker",
    },
    {
      // Two lines (21 chars) plus the reserved "\n... (5 more lines)" marker (19) fit; a third would not.
      cut: () => head(Array(5).fill("abcdefghij").join("\n"), 10, 45),
      expected: "abcdefghij\nabcdefghij\n... (3 more lines)",
      reason: "the character cap keeps whole lines and counts the cut ones",
    },
    {
      cut: () => head(`${"x".repeat(50)}\nshort`, 10, 20),
      expected: `${"x".repeat(50)}\n... (1 more lines)`,
      reason: "a first line over the cap is kept whole for capChars",
    },
    { cut: () => capChars("short", 100), expected: "short", reason: "capChars within the cap" },
    {
      // 50 - 16 (the marker) = 34 kept characters; the return is exactly 50.
      cut: () => capChars("abcdefghij".repeat(100), 50),
      expected: `${"abcdefghij".repeat(3)}abcd\n... (truncated)`,
      reason: "capChars counts the marker inside max",
    },
  ])("$reason", ({ cut, expected }) => {
    expect(cut()).toBe(expected);
  });
});

test("failureDirs: a directory named outside the docs/fuzzer.md contract is dropped without a word, as is a missing root", () => {
  const root = temp.dir("dirs-");
  mkdirSync(join(root, "good_target-1.x"));
  mkdirSync(join(root, "bad name with spaces"));
  writeFileSync(join(root, "stray-file"), "not a dir");
  expect([
    failureDirs(root).map((d) => d.split("/").pop()),
    failureDirs("/nonexistent/nowhere"),
  ]).toEqual([["good_target-1.x"], []]);
});

describe("blockTitle", () => {
  // The title is the issue's only index into a night's failures: the fallbacks decide whether a present report reads
  // "(no report.md)" and whether a blank first line hides the heading below it, and nothing else reads the report's head.
  test.each([
    {
      report: "# fuzz: target crashed\n\nbody",
      title: "fuzz: target crashed",
      reason: "an h1 first line",
    },
    {
      report: "## fuzz: target crashed\n",
      title: "fuzz: target crashed",
      reason: "every leading marker is stripped, not one",
    },
    {
      report: "",
      title: "target (no report.md)",
      reason: "an absent report names the directory and says so",
    },
    {
      report: "\nsome body",
      title: "target",
      reason: "a blank first line is not a missing report",
    },
  ])("$reason", ({ report, title }) => {
    expect(blockTitle("/x/target", report)).toBe(title);
  });
});

describe("buildBody", () => {
  let root: string;

  beforeAll(() => {
    root = temp.dir("failures-");
    reportDir(
      root,
      "nm_frame",
      [
        "# fuzz: nm_frame crashed",
        "",
        "Reproduce:",
        "",
        "```bash",
        "cargo +nightly fuzz run nm_frame fuzz/artifacts/nm_frame/crash-abc",
        "```",
        "",
      ].join("\n"),
    );
    // A failure dir the producer could not write a report for.
    reportDir(root, "mcp_jsonrpc");
    // failureDirs orders by mtime; two mkdirs can tie, so pin nm_frame older.
    utimesSync(join(root, "nm_frame"), new Date(1_000_000), new Date(1_000_000));
    utimesSync(join(root, "mcp_jsonrpc"), new Date(2_000_000), new Date(2_000_000));
  });

  const blocks = [
    "## fuzz: nm_frame crashed",
    "",
    "Reproduce:",
    "",
    "```bash",
    "cargo +nightly fuzz run nm_frame fuzz/artifacts/nm_frame/crash-abc",
    "```",
    "",
    "## mcp_jsonrpc (no report.md)",
    "",
  ];
  const noReport = (stream: Stream) => [
    "Nothing wrote a report: the failure may sit outside the " +
      (stream === "fuzz" ? "fuzz" : "reporting") +
      " step",
    `(setup, cache, artifact upload), or the ${stream === "fuzz" ? "fuzzer" : "producer"} died before it could`,
    "write one. See the run log.",
    "",
    RUN,
  ];

  // Oldest first is the reading order of a night's failures; the artifact sentence exists only when an artifact does.
  test.each<{
    dirs: boolean;
    stream: Stream;
    artifactName: string;
    body: string[];
    reason: string;
  }>([
    {
      dirs: true,
      stream: "fuzz",
      artifactName: "fuzz-failures-1",
      body: [
        `Nightly fuzz run on ${date} produced 2 failure report(s).`,
        "",
        ...blocks,
        "The full failure artifacts (crashing inputs, logs) are attached to the run as `fuzz-failures-1`.",
        RUN,
      ],
      reason: "oldest first, then the artifact sentence and the run",
    },
    {
      dirs: true,
      stream: "fuzz",
      artifactName: "",
      body: [`Nightly fuzz run on ${date} produced 2 failure report(s).`, "", ...blocks, RUN],
      reason: "no artifact, no sentence pointing at one",
    },
    {
      dirs: true,
      stream: "generic",
      artifactName: "trivy-findings-1",
      body: [
        `Nightly run on ${date} produced 2 report(s).`,
        "",
        ...blocks,
        "The full reports are attached to the run as `trivy-findings-1`.",
        RUN,
      ],
      reason: "the generic stream words the same body without fuzz notions",
    },
    {
      dirs: false,
      stream: "fuzz",
      artifactName: "a",
      body: [`Nightly fuzz run on ${date} failed with no failure report.`, "", ...noReport("fuzz")],
      reason: "no failure dirs is a bare notice",
    },
    {
      dirs: false,
      stream: "generic",
      artifactName: "a",
      body: [`Nightly run on ${date} failed with no report.`, "", ...noReport("generic")],
      reason: "the generic bare notice",
    },
  ])("$reason", ({ dirs, stream, artifactName, body }) => {
    expect(buildBody(dirs ? failureDirs(root) : [], env, artifactName, stream)).toBe(
      body.join("\n"),
    );
  });

  // The link-rot shape: one report listing every broken URL with its referring page, 83 lines for 40 URLs, more than the
  // 60-line summary head. reusable-site.yml calls this action with no artifact, so the issue is the only record: a head
  // cut there would drop 23 report lines silently.
  const linkRotReport = (urls: number) => [
    `# ${urls} broken external links`,
    "",
    "The nightly link check found external links in the deployed site that no longer resolve.",
    "The site still deployed; fix or remove the links in the source markdown.",
    "",
    ...Array.from({ length: urls }, (_, i) => [
      `- https://gone.example/page-${i} (status 404)`,
      `  - linked from /docs/page-${i}.html`,
    ]).flat(),
    "",
  ];
  const linkRotRoot = (urls: number) => {
    const root = temp.dir("link-rot-");
    reportDir(root, "external-links", linkRotReport(urls).join("\n"));
    return root;
  };

  test.each<{ artifactName: string; reason: string; body: (report: string[]) => string[] }>([
    {
      artifactName: "",
      reason: "no artifact: the body is the only record and carries all 40",
      body: (report) => [...report.slice(1, -1), "", RUN],
    },
    {
      artifactName: "link-rot-1",
      reason: "an artifact: the 60-line head, the count, and the artifact sentence",
      body: (report) => [
        ...report.slice(1, 62),
        "... (23 more lines)",
        "",
        "The full reports are attached to the run as `link-rot-1`.",
        RUN,
      ],
    },
  ])("a 40-URL link-rot report ($reason)", ({ artifactName, body }) => {
    const report = linkRotReport(40);
    expect(buildBody(failureDirs(linkRotRoot(40)), env, artifactName, "generic")).toBe(
      [
        `Nightly run on ${date} produced 1 report(s).`,
        "",
        "## 40 broken external links",
        ...body(report),
      ].join("\n"),
    );
  });

  // The honesty invariant under GitHub's 65,536-character body limit: nothing vanishes uncounted, and the filing itself
  // never fails on size. Each row is a report shape the budget meets differently; the outcome is the same shape.
  interface Budget {
    lengthWithin: [number, number];
    omittedNotice: boolean;
    truncatedMarker: boolean;
    moreLinesMarker: boolean;
    artifactSentence: boolean;
  }
  const budgetOf = (body: string, lengthWithin: [number, number]): Budget => ({
    lengthWithin,
    omittedNotice: body.includes("omitted to stay under the GitHub body limit"),
    truncatedMarker: body.includes("... (truncated)"),
    moreLinesMarker: body.includes("more lines"),
    artifactSentence: body.includes("artifact"),
  });
  const fill = (
    count: number,
    report: (i: number) => string,
    name = (i: number) => `target-${i}`,
  ) => {
    const root = temp.dir("budget-");
    for (let i = 0; i < count; i++) reportDir(root, name(i), report(i));
    return root;
  };
  const line = "x".repeat(68);
  interface BudgetRow {
    reason: string;
    root: () => string;
    artifactName: string;
    stream: Stream;
    budget: Budget;
    also?: (body: string) => void;
  }
  test.each<BudgetRow>([
    {
      reason: "one report past the limit, no artifact: cut at whole lines with an honest count",
      root: () => linkRotRoot(1500),
      artifactName: "",
      stream: "generic",
      // The whole 60,000-char budget is used, less than one report line spare: the 8,000-char summary cap would leave a
      // body a seventh this size.
      budget: {
        lengthWithin: [59_800, 60_000],
        omittedNotice: false,
        truncatedMarker: false,
        moreLinesMarker: true,
        artifactSentence: false,
      },
      also: (body) => {
        const cut = /\n\.\.\. \((\d+) more lines\)\n\nRun: /.exec(body);
        const kept = body.split("\n").filter((l) => l.startsWith("- https://")).length;
        const shown = body
          .split("\n")
          .filter((l) => l.startsWith("- ") || l.startsWith("  - ")).length;
        // Every URL is either in the body or counted; the parent lines are the rest of the count.
        expect([kept > 0, kept < 1500, shown + Number(cut?.[1])]).toEqual([true, true, 3000]);
      },
    },
    {
      reason:
        "40 large reports with an artifact: the body stays under the limit and says how many were omitted",
      root: () =>
        fill(40, (i) => `# target-${i} crashed\n\n${"x".repeat(5000)}\n${"x".repeat(5000)}\n`),
      artifactName: "a",
      stream: "fuzz",
      budget: {
        lengthWithin: [0, 65_535],
        omittedNotice: true,
        truncatedMarker: false,
        moreLinesMarker: true,
        artifactSentence: true,
      },
    },
    {
      // 100 reports of ~700 chars: a bare share of the budget (~600 chars each) would cut every one, so the share floors
      // at the summary cap and the budget runs out on whole blocks instead.
      reason:
        "many small reports, no artifact: whole blocks until the budget ends, the rest counted",
      root: () =>
        fill(
          100,
          (i) => `# report ${i}\n\n${Array(10).fill(line).join("\n")}\n`,
          (i) => `r${String(i).padStart(3, "0")}`,
        ),
      artifactName: "",
      stream: "generic",
      budget: {
        lengthWithin: [59_000, 60_000],
        omittedNotice: true,
        truncatedMarker: false,
        moreLinesMarker: false,
        artifactSentence: false,
      },
      also: (body) => {
        const shown = (body.match(/^## report \d+$/gm) ?? []).length;
        expect([shown > 0, shown < 100]).toEqual([true, true]);
        expect(body.split("\n").filter((candidate) => candidate === line)).toHaveLength(shown * 10);
        expect(body).toEndWith(
          `\n${100 - shown} more report(s) omitted to stay under the GitHub body limit.\n${RUN}`,
        );
      },
    },
    ...(["a", ""] as const).map(
      (artifactName): BudgetRow => ({
        reason: `a single 70,000-char line, which line cuts cannot shorten (artifact ${JSON.stringify(artifactName)})`,
        root: () =>
          fill(
            1,
            () => `# handshake crashed\n${"x".repeat(70_000)}`,
            () => "handshake",
          ),
        artifactName,
        stream: "fuzz",
        budget: {
          lengthWithin: [0, 65_535],
          omittedNotice: false,
          truncatedMarker: true,
          moreLinesMarker: false,
          artifactSentence: artifactName !== "",
        },
        also: (body) => expect(body).toContain("## handshake crashed"),
      }),
    ),
  ])("$reason", ({ root, artifactName, stream, budget, also }) => {
    const body = buildBody(failureDirs(root()), env, artifactName, stream);
    const [min, max] = budget.lengthWithin;
    expect(budgetOf(body, [Math.min(min, body.length), Math.max(max, body.length)])).toEqual(
      budget,
    );
    also?.(body);
  });
});

describe("buildGenericBody", () => {
  test.each([
    {
      reason: "full context names the workflow, commit, and run",
      bodyEnv: { ...env, GITHUB_WORKFLOW: "Nightly", GITHUB_SHA: "abc1234def" },
      expected: [
        `\`Nightly\` failed on ${date}.`,
        "",
        "This stream writes no failure reports; the run log names the failing",
        "step(s). Repeat failures update this issue until a green night closes it.",
        "",
        "Commit: abc1234def",
        RUN,
      ],
    },
    {
      reason: "missing context degrades to prose, not to empty backticks or a facts block",
      bodyEnv: {},
      expected: [
        `The nightly workflow failed on ${date}.`,
        "",
        "This stream writes no failure reports; the run log names the failing",
        "step(s). Repeat failures update this issue until a green night closes it.",
      ],
    },
  ])("points at the run log, never at artifacts ($reason)", ({ bodyEnv, expected }) => {
    expect(buildGenericBody(bodyEnv as NodeJS.ProcessEnv)).toBe(expected.join("\n"));
  });
});

describe("closeComment", () => {
  test.each<{ reason: string; stream: Stream; commentEnv: NodeJS.ProcessEnv; comment: string[] }>([
    {
      reason: "the fuzz stream hedges on unpinned regression seeds",
      stream: "fuzz",
      commentEnv: env,
      comment: [
        `Nightly fuzz passed on ${date}. ${RUN}`,
        "",
        "Closing. If the crashing inputs reported here were pinned as regression",
        "seeds, this pass replayed them; for anything not pinned, a green night is",
        "weaker evidence, and the next red night opens a fresh issue.",
      ],
    },
    {
      reason: "the generic stream names the run and carries no fuzz notions",
      stream: "generic",
      commentEnv: env,
      comment: [
        `Nightly run passed on ${date}. ${RUN}`,
        "",
        "Closing; the next failing night opens a fresh issue.",
      ],
    },
    {
      // runUrl needs all three of server, repository and run id; guarding on fewer prints "undefined" into the link.
      reason: "a partial env (the server alone) is no run URL: the first line carries no link",
      stream: "generic",
      commentEnv: { GITHUB_SERVER_URL: "https://github.com" } as NodeJS.ProcessEnv,
      comment: [
        `Nightly run passed on ${date}.`,
        "",
        "Closing; the next failing night opens a fresh issue.",
      ],
    },
  ])("$reason", ({ stream, commentEnv, comment }) => {
    expect(closeComment(commentEnv, stream)).toBe(comment.join("\n"));
  });
});

describe("the script", () => {
  const SCRIPT = resolve(import.meta.dir, "../../../actions/fuzz-issue/fuzz-issue.ts");
  // The child keeps its own clock, so dates are matched by shape.
  const DAY = String.raw`\d{4}-\d{2}-\d{2}`;

  const run = (vars: Record<string, string | undefined>) => {
    const root = temp.dir("fuzz-issue-script-");
    const outputs = join(root, "outputs.txt");
    writeFileSync(outputs, "");
    const proc = boundedSpawnSync(["bun", SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME,
        ...env,
        LABEL: "fuzz-nightly",
        RUNNER_TEMP: root,
        GITHUB_OUTPUT: outputs,
        ...vars,
      },
    });
    const file = readFileSync(outputs, "utf8").match(/^file=(.+)$/m)?.[1];
    return {
      ...proc,
      root,
      file,
      text: file === undefined ? undefined : readFileSync(file, "utf8"),
    };
  };

  /** Report mode's required tuple; the action.yml steps consume it, the script only checks it is there. */
  const REPORT_TUPLE = {
    MODE: "report",
    TITLE: "Nightly fuzz failures",
    LABEL_COLOR: "B60205",
    LABEL_DESCRIPTION: "Automated nightly fuzz failure",
  };

  const failures = () => {
    const dir = temp.dir("fuzz-issue-script-failures-");
    reportDir(
      dir,
      "nm_frame",
      "# fuzz: nm_frame crashed\n\n```bash\ncargo fuzz run nm_frame crash-abc\n```\n",
    );
    return dir;
  };

  // The `file` output is what action.yml's issue and close steps read; the body lands under RUNNER_TEMP.
  const dated = (text: string | undefined) => text?.replace(new RegExp(DAY), date);
  test.each<{ reason: string; vars: () => Record<string, string>; body: string[] }>([
    {
      reason: "report mode with an artifacts dir writes the failure-report body",
      vars: () => ({
        ...REPORT_TUPLE,
        STREAM: "fuzz",
        ARTIFACTS_DIR: failures(),
        ARTIFACT_NAME: "fuzz-failures-1",
      }),
      body: [
        `Nightly fuzz run on ${date} produced 1 failure report(s).`,
        "",
        "## fuzz: nm_frame crashed",
        "",
        "```bash",
        "cargo fuzz run nm_frame crash-abc",
        "```",
        "",
        "The full failure artifacts (crashing inputs, logs) are attached to the run as `fuzz-failures-1`.",
        RUN,
      ],
    },
    {
      reason: "report mode without an artifacts dir writes the generic body",
      vars: () => ({ ...REPORT_TUPLE, STREAM: "generic", GITHUB_WORKFLOW: "Nightly" }),
      body: [
        `\`Nightly\` failed on ${date}.`,
        "",
        "This stream writes no failure reports; the run log names the failing",
        "step(s). Repeat failures update this issue until a green night closes it.",
        "",
        RUN,
      ],
    },
    {
      reason: "resolve mode writes the stream's close comment",
      vars: () => ({ MODE: "resolve", STREAM: "generic" }),
      body: [
        `Nightly run passed on ${date}. ${RUN}`,
        "",
        "Closing; the next failing night opens a fresh issue.",
      ],
    },
  ])("$reason", ({ vars, body }) => {
    const result = run(vars());
    expect([result.exitCode, result.stderr, dated(result.text)]).toEqual([0, "", body.join("\n")]);
    expect(result.file).toStartWith(join(result.root, "fuzz-issue-"));
  });

  // A composite's `required: true` only documents, so an omitted input reaches the script as an empty string; without
  // the check resolve mode lists every open issue under an empty label and closes them all.
  test.each([
    { vars: {}, error: "the mode input is required" },
    { vars: { MODE: "" }, error: "the mode input is required" },
    {
      vars: { MODE: "comment" },
      error: "unknown MODE 'comment' (expected report or resolve)",
    },
    { vars: { MODE: "resolve", LABEL: undefined }, error: "the label input is required" },
    { vars: { MODE: "resolve" }, error: "the stream input is required" },
    {
      vars: { MODE: "resolve", STREAM: "ci" },
      error: "unknown STREAM 'ci' (expected fuzz or generic)",
    },
    {
      vars: { ...REPORT_TUPLE, STREAM: "fuzz", RUNNER_TEMP: undefined },
      error: "RUNNER_TEMP and GITHUB_OUTPUT are required",
    },
    ...(["TITLE", "LABEL_COLOR", "LABEL_DESCRIPTION"] as const).map((variable) => ({
      vars: { ...REPORT_TUPLE, STREAM: "fuzz", [variable]: undefined },
      error: `the ${variable.toLowerCase().replace("_", "-")} input is required`,
    })),
  ])("refuses $vars and writes nothing", ({ vars, error }) => {
    const result = run(vars);
    expect([result.exitCode, result.file]).toEqual([1, undefined]);
    expect(result.stderr).toContain(error);
  });
});
