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
  runUrl,
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

/**
 * Every body under test stamps the UTC day at call time, so the clock is
 * frozen for the whole file and the expected date is a literal (a date read
 * once at module load would race midnight against the source's own read).
 */
const date = "2026-03-04";
beforeAll(() => setSystemTime(new Date(`${date}T12:00:00Z`)));
afterAll(() => setSystemTime());

describe("head", () => {
  const five = ["1", "2", "3", "4", "5"].join("\n");
  const cases: {
    text: string;
    lines: number;
    chars: number;
    expected: string;
    reason: string;
  }[] = [
    {
      text: "a\nb\nc",
      lines: 5,
      chars: 100,
      expected: "a\nb\nc",
      reason: "within both limits",
    },
    {
      text: `${["1", "2", "3"].join("\n")}\n`,
      lines: 3,
      chars: 100,
      expected: "1\n2\n3",
      reason: "a single trailing newline is not a line",
    },
    {
      text: five,
      lines: 2,
      chars: 100,
      expected: "1\n2\n... (3 more lines)",
      reason: "the line cap",
    },
    {
      text: five,
      lines: 10,
      chars: 9,
      expected: five,
      reason: "text that exactly fills the character cap needs no marker",
    },
    {
      text: Array(5).fill("abcdefghij").join("\n"),
      lines: 10,
      // Two lines (21 chars) plus the reserved "\n... (5 more lines)" marker (19) fit; a third would not.
      chars: 45,
      expected: "abcdefghij\nabcdefghij\n... (3 more lines)",
      reason: "the character cap keeps whole lines and counts the cut ones",
    },
    {
      text: `${"x".repeat(50)}\nshort`,
      lines: 10,
      chars: 20,
      expected: `${"x".repeat(50)}\n... (1 more lines)`,
      reason: "a first line over the cap is kept for capChars to cut",
    },
  ];

  test.each(cases)(
    "keeps the head within $lines lines and $chars chars ($reason)",
    ({ text, lines, chars, expected }) => {
      expect(head(text, lines, chars)).toBe(expected);
    },
  );
});

describe("capChars", () => {
  test("returns the text unchanged when within the cap", () => {
    expect(capChars("short", 100)).toBe("short");
  });

  test("keeps the head and counts the marker inside `max`", () => {
    // 50 - 16 (the marker) = 34 kept characters; the return is exactly 50.
    expect(capChars("abcdefghij".repeat(100), 50)).toBe(
      `${"abcdefghij".repeat(3)}abcd\n... (truncated)`,
    );
  });
});

describe("runUrl", () => {
  test("builds the Actions run URL from the standard env vars", () => {
    expect(runUrl(env)).toBe("https://github.com/o/r/actions/runs/42");
  });

  test("returns empty when any component is missing", () => {
    expect(runUrl({ GITHUB_SERVER_URL: "https://github.com" } as NodeJS.ProcessEnv)).toBe("");
  });
});

describe("failureDirs", () => {
  test("returns empty for a missing root", () => {
    expect(failureDirs("/nonexistent/nowhere")).toEqual([]);
  });

  test("ignores top-level files and non-contract names", () => {
    const root = temp.dir("dirs-");
    mkdirSync(join(root, "good_target-1.x"));
    mkdirSync(join(root, "bad name with spaces"));
    writeFileSync(join(root, "stray-file"), "not a dir");
    const dirs = failureDirs(root).map((d) => d.split("/").pop());
    expect(dirs).toEqual(["good_target-1.x"]);
  });
});

describe("blockTitle", () => {
  test.each([
    { report: "# fuzz: target crashed\n\nbody", reason: "an h1 first line" },
    {
      report: "## fuzz: target crashed\n",
      reason: "every leading marker is stripped, not one",
    },
  ])("uses the report's first heading ($reason)", ({ report }) => {
    expect(blockTitle("/x/target", report)).toBe("fuzz: target crashed");
  });

  test("falls back to the directory name when the report is absent", () => {
    expect(blockTitle("/x/nm_frame", "")).toBe("nm_frame (no report.md)");
  });

  test("a report with a blank first line is not called missing", () => {
    expect(blockTitle("/x/nm_frame", "\nsome body")).toBe("nm_frame");
  });
});

describe("buildBody", () => {
  let root: string;

  beforeAll(() => {
    root = temp.dir("failures-");
    const crash = join(root, "nm_frame");
    mkdirSync(crash, { recursive: true });
    writeFileSync(
      join(crash, "report.md"),
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
    const orphan = join(root, "mcp_jsonrpc");
    mkdirSync(orphan, { recursive: true });
    // failureDirs orders by mtime; two mkdirs can tie, so pin nm_frame older.
    utimesSync(crash, new Date(1_000_000), new Date(1_000_000));
    utimesSync(orphan, new Date(2_000_000), new Date(2_000_000));
  });

  const trailers: {
    artifactName: string;
    reason: string;
    trailer: string[];
  }[] = [
    {
      artifactName: "fuzz-failures-1",
      reason: "names the uploaded artifact",
      trailer: [
        "The full failure artifacts (crashing inputs, logs) are attached to the run as `fuzz-failures-1`.",
      ],
    },
    {
      artifactName: "",
      reason: "no artifact, no sentence pointing at one",
      trailer: [],
    },
  ];

  test.each(trailers)(
    "one block per failure, oldest first, then the artifacts note and run ($reason)",
    ({ artifactName, trailer }) => {
      expect(buildBody(failureDirs(root), env, artifactName)).toBe(
        [
          `Nightly fuzz run on ${date} produced 2 failure report(s).`,
          "",
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
          ...trailer,
          "Run: https://github.com/o/r/actions/runs/42",
        ].join("\n"),
      );
    },
  );

  // The link-rot shape: one report listing every broken URL with its
  // referring page, 83 lines for 40 URLs, more than the 60-line summary head.
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
    mkdirSync(join(root, "external-links"));
    writeFileSync(join(root, "external-links", "report.md"), linkRotReport(urls).join("\n"));
    return root;
  };

  const linkRotBodies: {
    artifactName: string;
    reason: string;
    body: (report: string[]) => string[];
  }[] = [
    {
      artifactName: "",
      reason: "no artifact: the body is the only record and carries all 40",
      body: (report: string[]) => [
        ...report.slice(1, -1),
        "",
        "Run: https://github.com/o/r/actions/runs/42",
      ],
    },
    {
      artifactName: "link-rot-1",
      reason: "an artifact: the 60-line head, the count, and the artifact sentence",
      body: (report: string[]) => [
        ...report.slice(1, 62),
        "... (23 more lines)",
        "",
        "The full reports are attached to the run as `link-rot-1`.",
        "Run: https://github.com/o/r/actions/runs/42",
      ],
    },
  ];

  test.each(linkRotBodies)("a 40-URL link-rot report ($reason)", ({ artifactName, body }) => {
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

  test("without an artifact a report past the body limit is cut at whole lines with an honest count and no artifact sentence", () => {
    const urls = 1500;
    const body = buildBody(failureDirs(linkRotRoot(urls)), env, "", "generic");
    // The whole 60,000-char budget is used, less than one report line spare:
    // the 8,000-char summary cap would leave a body a seventh this size.
    expect(body.length).toBeGreaterThan(59_800);
    expect(body.length).toBeLessThan(60_000);
    expect(body).not.toContain("artifact");
    expect(body).not.toContain("omitted");
    const cut = /\n\.\.\. \((\d+) more lines\)\n\nRun: /.exec(body);
    const kept = body.split("\n").filter((line) => line.startsWith("- https://")).length;
    // Every URL is either in the body or counted; the parent lines are the rest of the count.
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(urls);
    const shown = body
      .split("\n")
      .filter((line) => line.startsWith("- ") || line.startsWith("  - ")).length;
    expect(shown + Number(cut?.[1])).toBe(2 * urls);
  });

  test("caps the body under the GitHub limit and says how many were omitted", () => {
    const bigRoot = temp.dir("big-");
    const filler = "x".repeat(5000);
    for (let i = 0; i < 40; i++) {
      const dir = join(bigRoot, `target-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.md"), `# target-${i} crashed\n\n${filler}\n${filler}\n`);
    }
    const body = buildBody(failureDirs(bigRoot), env, "a");
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("omitted to stay under the GitHub body limit");
  });

  test("without an artifact many reports keep their content whole and the rest are counted as omitted", () => {
    // 100 reports of ~700 chars: a bare share of the budget (~600 chars each)
    // would cut every one, so the share floors at the summary cap and the
    // budget runs out on whole blocks instead.
    const manyRoot = temp.dir("many-");
    const line = "x".repeat(68);
    for (let i = 0; i < 100; i++) {
      const dir = join(manyRoot, `r${String(i).padStart(3, "0")}`);
      mkdirSync(dir);
      writeFileSync(
        join(dir, "report.md"),
        `# report ${i}\n\n${Array(10).fill(line).join("\n")}\n`,
      );
    }
    const body = buildBody(failureDirs(manyRoot), env, "", "generic");
    const shown = (body.match(/^## report \d+$/gm) ?? []).length;
    expect(body.length).toBeGreaterThan(59_000);
    expect(body.length).toBeLessThan(60_000);
    expect(body).not.toContain("more lines");
    expect(body).not.toContain("truncated");
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    expect(body.split("\n").filter((candidate) => candidate === line)).toHaveLength(shown * 10);
    expect(body).toEndWith(
      `\n${100 - shown} more report(s) omitted to stay under the GitHub body limit.\nRun: https://github.com/o/r/actions/runs/42`,
    );
  });

  test.each(["a", ""])(
    "a single giant single-line report still produces a body under the limit (artifact %j)",
    (artifactName) => {
      // One report that is a single 70,000-char line, which line truncation
      // cannot shorten. The character cap must keep the whole body under
      // GitHub's 65,536 limit so the filing itself does not fail.
      const giantRoot = temp.dir("giant-");
      const dir = join(giantRoot, "handshake");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.md"), `# handshake crashed\n${"x".repeat(70_000)}`);
      const body = buildBody(failureDirs(giantRoot), env, artifactName);
      expect(body.length).toBeLessThan(65_536);
      expect(body).toContain("## handshake crashed");
      expect(body).toContain("... (truncated)");
    },
  );

  test("files a bare notice when there are no failure dirs", () => {
    expect(buildBody([], env, "a")).toBe(
      [
        `Nightly fuzz run on ${date} failed with no failure report.`,
        "",
        "Nothing wrote a report: the failure may sit outside the fuzz step",
        "(setup, cache, artifact upload), or the fuzzer died before it could",
        "write one. See the run log.",
        "",
        "Run: https://github.com/o/r/actions/runs/42",
      ].join("\n"),
    );
  });

  test("the generic stream words the same body without fuzz notions", () => {
    const body = buildBody(failureDirs(root), env, "trivy-findings-1", "generic");
    expect(body).toStartWith(`Nightly run on ${date} produced 2 report(s).\n`);
    expect(body).toContain("## fuzz: nm_frame crashed");
    expect(body).toContain(
      "\nThe full reports are attached to the run as `trivy-findings-1`.\nRun: ",
    );
    expect(body).not.toContain("crashing inputs");
    expect(body).not.toContain("failure report");
    expect(buildBody([], env, "a", "generic")).toBe(
      [
        `Nightly run on ${date} failed with no report.`,
        "",
        "Nothing wrote a report: the failure may sit outside the reporting step",
        "(setup, cache, artifact upload), or the producer died before it could",
        "write one. See the run log.",
        "",
        "Run: https://github.com/o/r/actions/runs/42",
      ].join("\n"),
    );
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
        "Run: https://github.com/o/r/actions/runs/42",
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
  test.each([
    {
      reason:
        "the omitted stream is the pre-input default, pinned verbatim for fleet fuzzer starters",
      stream: undefined,
      comment: [
        `Nightly fuzz passed on ${date}. Run: https://github.com/o/r/actions/runs/42`,
        "",
        "Closing. If the crashing inputs reported here were pinned as regression",
        "seeds, this pass replayed them; for anything not pinned, a green night is",
        "weaker evidence, and the next red night opens a fresh issue.",
      ],
    },
    {
      reason: "the generic stream names the run and carries no fuzz notions",
      stream: "generic" as Stream,
      comment: [
        `Nightly run passed on ${date}. Run: https://github.com/o/r/actions/runs/42`,
        "",
        "Closing; the next failing night opens a fresh issue.",
      ],
    },
  ])("$reason", ({ stream, comment }) => {
    expect(closeComment(env, stream)).toBe(comment.join("\n"));
  });

  test("without a run URL the first line carries no link", () => {
    expect(closeComment({} as NodeJS.ProcessEnv, "generic")).toStartWith(
      `Nightly run passed on ${date}.\n`,
    );
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

  test("report mode with an artifacts dir writes the failure-report body under RUNNER_TEMP and outputs its path", () => {
    const failures = temp.dir("fuzz-issue-script-failures-");
    mkdirSync(join(failures, "nm_frame"));
    writeFileSync(
      join(failures, "nm_frame", "report.md"),
      "# fuzz: nm_frame crashed\n\n```bash\ncargo fuzz run nm_frame crash-abc\n```\n",
    );
    const result = run({
      MODE: "report",
      ARTIFACTS_DIR: failures,
      ARTIFACT_NAME: "fuzz-failures-1",
    });
    expect([result.exitCode, result.stderr]).toEqual([0, ""]);
    expect(result.file).toStartWith(join(result.root, "fuzz-issue-"));
    expect(result.text).toMatch(
      new RegExp(`^Nightly fuzz run on ${DAY} produced 1 failure report\\(s\\)\\.\n`),
    );
    expect(result.text).toContain(
      "## fuzz: nm_frame crashed\n\n```bash\ncargo fuzz run nm_frame crash-abc\n```",
    );
    expect(result.text).toEndWith(
      "\nThe full failure artifacts (crashing inputs, logs) are attached to the run as `fuzz-failures-1`.\nRun: https://github.com/o/r/actions/runs/42",
    );
  });

  test("report mode without an artifacts dir writes the generic body", () => {
    const result = run({
      MODE: "report",
      STREAM: "generic",
      GITHUB_WORKFLOW: "Nightly",
    });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(new RegExp(`^\`Nightly\` failed on ${DAY}\\.\n`));
    expect(result.text).toEndWith("\n\nRun: https://github.com/o/r/actions/runs/42");
  });

  test("resolve mode writes the stream's close comment", () => {
    const result = run({ MODE: "resolve", STREAM: "generic" });
    expect(result.exitCode).toBe(0);
    expect(result.text).toMatch(
      new RegExp(
        `^Nightly run passed on ${DAY}\\. Run: https://github.com/o/r/actions/runs/42\n\nClosing; the next failing night opens a fresh issue\\.$`,
      ),
    );
  });

  test.each([
    {
      vars: { MODE: "comment" },
      error: "unknown MODE 'comment' (expected report or resolve)",
    },
    {
      vars: { MODE: "resolve", STREAM: "ci" },
      error: "unknown STREAM 'ci' (expected fuzz or generic)",
    },
    {
      vars: { MODE: "report", RUNNER_TEMP: undefined },
      error: "RUNNER_TEMP and GITHUB_OUTPUT are required",
    },
  ])("refuses $vars and writes nothing", ({ vars, error }) => {
    const result = run(vars);
    expect([result.exitCode, result.file]).toEqual([1, undefined]);
    expect(result.stderr).toContain(error);
  });
});
