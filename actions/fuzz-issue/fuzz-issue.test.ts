/**
 * Unit tests for the fuzz-issue action's pure helpers and the issue
 * lifecycle (create/comment/resolve) through an injected fake gh runner.
 * The real gh calls are not tested here (they need a live GitHub).
 */

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockTitle,
  buildBody,
  buildGenericBody,
  capChars,
  DEFAULT_LABEL_COLOR,
  DEFAULT_LABEL_DESCRIPTION,
  DEFAULT_TITLE,
  failureDirs,
  fileIssue,
  type GhRunner,
  head,
  issueNumberFromUrl,
  LABEL_RE,
  resolveIssue,
  runUrl,
  type Stream,
} from "./fuzz-issue";

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
  test("returns the text unchanged when under the limit", () => {
    expect(head("a\nb\nc", 5)).toBe("a\nb\nc");
  });

  test("truncates and names how many lines were cut", () => {
    expect(head(["1", "2", "3", "4", "5"].join("\n"), 2)).toBe("1\n2\n... (3 more lines)");
  });

  test("a single trailing newline is not counted as an extra line", () => {
    const text = `${["1", "2", "3"].join("\n")}\n`;
    expect(head(text, 3)).toBe("1\n2\n3");
  });
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
    const root = mkdtempSync(join(tmpdir(), "dirs-"));
    mkdirSync(join(root, "good_target-1.x"));
    mkdirSync(join(root, "bad name with spaces"));
    writeFileSync(join(root, "stray-file"), "not a dir");
    const dirs = failureDirs(root).map((d) => d.split("/").pop());
    expect(dirs).toEqual(["good_target-1.x"]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("blockTitle", () => {
  test.each([
    { report: "# fuzz: target crashed\n\nbody", reason: "an h1 first line" },
    { report: "## fuzz: target crashed\n", reason: "every leading marker is stripped, not one" },
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
    root = mkdtempSync(join(tmpdir(), "failures-"));
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

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test.each([
    {
      artifactName: "fuzz-failures-1",
      reason: "names the uploaded artifact",
      artifactsLine:
        "The full failure artifacts (crashing inputs, logs) are attached to the run as `fuzz-failures-1`.",
    },
    {
      artifactName: "",
      reason: "no artifact name points at the run's artifacts list",
      artifactsLine: "The full failure artifacts are attached to the run; see its artifacts list.",
    },
  ])(
    "one block per failure, oldest first, then the artifacts note and run ($reason)",
    ({ artifactName, artifactsLine }) => {
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
          artifactsLine,
          "Run: https://github.com/o/r/actions/runs/42",
        ].join("\n"),
      );
    },
  );

  test("caps the body under the GitHub limit and says how many were omitted", () => {
    const bigRoot = mkdtempSync(join(tmpdir(), "big-"));
    const filler = "x".repeat(5000);
    for (let i = 0; i < 40; i++) {
      const dir = join(bigRoot, `target-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.md"), `# target-${i} crashed\n\n${filler}\n${filler}\n`);
    }
    const body = buildBody(failureDirs(bigRoot), env, "a");
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("omitted to stay under the GitHub body limit");
    rmSync(bigRoot, { recursive: true, force: true });
  });

  test("a single giant single-line report still produces a body under the limit", () => {
    // One report that is a single 70,000-char line, which line truncation
    // cannot shorten. The character cap must keep the whole body under
    // GitHub's 65,536 limit so the filing itself does not fail.
    const giantRoot = mkdtempSync(join(tmpdir(), "giant-"));
    const dir = join(giantRoot, "handshake");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), `# handshake crashed\n${"x".repeat(70_000)}`);
    const body = buildBody(failureDirs(giantRoot), env, "a");
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("## handshake crashed");
    rmSync(giantRoot, { recursive: true, force: true });
  });

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

/**
 * A recording gh runner: captures every command, answers the label-list
 * query from `labelTaken`, and the issue-list query from `openNumber` (a
 * number opens the comment path, undefined the create path) with the given
 * `assignees` on the open issue.
 */
function fakeGh(
  openNumber?: number,
  labelTaken = false,
  assignees: Array<{ login: string }> = [],
): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "label" && args[1] === "list") {
      return JSON.stringify(labelTaken ? [{ name: args[args.indexOf("--search") + 1] }] : []);
    }
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify(openNumber === undefined ? [] : [{ number: openNumber, assignees }]);
    }
    if (args[0] === "issue" && args[1] === "create") {
      return "https://github.com/o/r/issues/7\n";
    }
    return "";
  };
  return { run, calls };
}

/** Run `body` with console.log captured; returns the captured lines. */
async function withCapturedLog(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await body();
  } finally {
    console.log = original;
  }
  return lines;
}

/** The exact `gh label list` argv fileIssue issues for `label`. */
const labelListCall = (label: string): string[] => [
  "label",
  "list",
  "--repo",
  "o/r",
  "--search",
  label,
  "--limit",
  "1000",
  "--json",
  "name",
];

/** The exact `gh issue list` argv for `label` at page size `limit`. */
const issueListCall = (label: string, limit: string): string[] => [
  "issue",
  "list",
  "--repo",
  "o/r",
  "--label",
  label,
  "--state",
  "open",
  "--limit",
  limit,
  "--json",
  "number,assignees",
];

describe("fileIssue", () => {
  test.each([
    {
      reason: "the fuzz stream with the default title",
      label: "fuzz-nightly",
      title: DEFAULT_TITLE,
      body: "body",
    },
    {
      reason: "a no-artifacts stream passes its label, title, and generic body straight through",
      label: "nightly-failure",
      title: "Nightly CI failures",
      body: buildGenericBody({ ...env, GITHUB_WORKFLOW: "Nightly" } as NodeJS.ProcessEnv),
    },
  ])(
    "create path: creates the missing label, opens the labeled issue, assigns the owner ($reason)",
    async ({ label, title, body }) => {
      // A workflow-token issue fires no issues:opened event, so assignment
      // must happen at creation - the filer itself owns it now.
      const { run, calls } = fakeGh(undefined);
      expect(await fileIssue(run, "o/r", body, label, title)).toBe(7);
      expect(calls).toEqual([
        labelListCall(label),
        [
          "label",
          "create",
          label,
          "--repo",
          "o/r",
          "--color",
          DEFAULT_LABEL_COLOR,
          "--description",
          DEFAULT_LABEL_DESCRIPTION,
        ],
        issueListCall(label, "1"),
        ["issue", "create", "--repo", "o/r", "--label", label, "--title", title, "--body", body],
        ["issue", "edit", "7", "--repo", "o/r", "--add-assignee", "o"],
      ]);
    },
  );

  test("comment path: comments on the open unassigned issue and assigns the owner, no create", async () => {
    const { run, calls } = fakeGh(3, true);
    expect(await fileIssue(run, "o/r", "body", "fuzz-nightly", "t")).toBe(3);
    expect(calls).toEqual([
      labelListCall("fuzz-nightly"),
      issueListCall("fuzz-nightly", "1"),
      ["issue", "comment", "3", "--repo", "o/r", "--body", "body"],
      ["issue", "edit", "3", "--repo", "o/r", "--add-assignee", "o"],
    ]);
  });

  test("an already-assigned open issue is left alone on the comment path", async () => {
    // A human may have deliberately reassigned the tracking issue.
    const { run, calls } = fakeGh(3, true, [{ login: "someone" }]);
    await fileIssue(run, "o/r", "body", "fuzz-nightly", "t");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "edit")).toBe(false);
  });

  test("a failed assignment logs a notice and never fails the filing", async () => {
    // An org-owned repo's owner is an org and not assignable; the filing
    // must still succeed and return the number.
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "label" && args[1] === "list") return JSON.stringify([{ name: "l" }]);
      if (args[0] === "issue" && args[1] === "list") return "[]";
      if (args[0] === "issue" && args[1] === "create") return "https://github.com/o/r/issues/7\n";
      if (args[0] === "issue" && args[1] === "edit") {
        throw new Error("gh issue edit failed (1): could not assign user");
      }
      return "";
    };
    const logs = await withCapturedLog(async () => {
      expect(await fileIssue(run, "o/r", "body", "fuzz-nightly", "t")).toBe(7);
    });
    expect(calls.some((c) => c[0] === "issue" && c[1] === "edit")).toBe(true);
    expect(logs.some((line) => line.startsWith("::notice::could not assign @o to #7"))).toBe(true);
  });

  test("an unparseable create URL logs a notice, skips assignment, never fails the filing", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "label" && args[1] === "list") return JSON.stringify([{ name: "l" }]);
      if (args[0] === "issue" && args[1] === "list") return "[]";
      if (args[0] === "issue" && args[1] === "create") return "not a url\n";
      return "";
    };
    const logs = await withCapturedLog(async () => {
      expect(await fileIssue(run, "o/r", "body", "fuzz-nightly", "t")).toBeUndefined();
    });
    expect(calls.some((c) => c[0] === "issue" && c[1] === "edit")).toBe(false);
    expect(
      logs.some((line) => line.startsWith("::notice::could not parse the created issue's number")),
    ).toBe(true);
  });

  test("a caller-supplied label tuple reaches the create call", async () => {
    const { run, calls } = fakeGh(undefined, false);
    await fileIssue(
      run,
      "o/r",
      "body",
      "nightly-failure",
      "t",
      "D93F0B",
      "Automated nightly CI failure",
    );
    const create = calls.find((c) => c[0] === "label" && c[1] === "create");
    expect(create?.[create.indexOf("--color") + 1]).toBe("D93F0B");
    expect(create?.[create.indexOf("--description") + 1]).toBe("Automated nightly CI failure");
  });

  test("never touches a pre-existing label (no create, no repaint)", async () => {
    // Someone pointing the action at `bug` must not get it repainted red.
    const { run, calls } = fakeGh(9, true);
    expect(await fileIssue(run, "o/r", "body", "bug", "t")).toBe(9);
    expect(calls.some((c) => c[0] === "label" && c[1] === "create")).toBe(false);
  });

  test("a label-create failure propagates", async () => {
    const run: GhRunner = async (args) => {
      if (args[0] === "label" && args[1] === "list") return "[]";
      if (args[0] === "label" && args[1] === "create") {
        throw new Error("gh label create failed (4): auth required");
      }
      return "";
    };
    expect(fileIssue(run, "o/r", "body", "fuzz-nightly", "t")).rejects.toThrow("auth required");
  });
});

describe("repo naming", () => {
  test("every gh invocation names the repo - report jobs have no checkout to infer from", async () => {
    for (const openNumber of [undefined, 3] as const) {
      const { run, calls } = fakeGh(openNumber);
      await fileIssue(run, "o/r", "body", "fuzz-nightly", "t");
      await resolveIssue(run, "o/r", "fuzz-nightly", env);
      for (const call of calls) {
        expect(call[call.indexOf("--repo") + 1]).toBe("o/r");
      }
    }
  });
});

describe("LABEL_RE", () => {
  test("accepts plain labels including spaces and colons", () => {
    for (const label of [
      "fuzz-nightly",
      "e2e-fuzz",
      "autorelease: pending",
      "python:uv",
      "a.b_c",
      "x".repeat(50),
    ]) {
      expect(LABEL_RE.test(label)).toBe(true);
    }
  });

  test("rejects flag-like, empty, oversized, and structurally unsafe values", () => {
    for (const label of [
      "",
      "-x",
      "--help",
      "#fuzz",
      "a,b",
      "a\nb",
      "a\n",
      'fuzz: nightly" x: y',
      "x".repeat(51),
    ]) {
      expect(LABEL_RE.test(label)).toBe(false);
    }
  });
});

/**
 * A recording gh runner whose issue listings come from a queue, one page per
 * `issue list` call (empty once the queue drains), so a drain test sees the
 * close it just made instead of a permanently stale page.
 */
function queuedGh(listings: number[][]): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify((listings.shift() ?? []).map((number) => ({ number })));
    }
    return "";
  };
  return { run, calls };
}

describe("resolveIssue", () => {
  test.each([
    {
      reason:
        "the omitted stream is the pre-input default, pinned verbatim for fleet fuzzer starters",
      stream: undefined,
      label: "fuzz-nightly",
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
      label: "nightly-failure",
      comment: [
        `Nightly run passed on ${date}. Run: https://github.com/o/r/actions/runs/42`,
        "",
        "Closing; the next failing night opens a fresh issue.",
      ],
    },
  ])(
    "comments then closes the open labeled issue, never assigns, and re-lists until empty ($reason)",
    async ({ stream, label, comment }) => {
      const { run, calls } = queuedGh([[5]]);
      await resolveIssue(run, "o/r", label, env, stream);
      expect(calls).toEqual([
        issueListCall(label, "100"),
        ["issue", "comment", "5", "--repo", "o/r", "--body", comment.join("\n")],
        ["issue", "close", "5", "--repo", "o/r", "--reason", "completed"],
        issueListCall(label, "100"),
      ]);
    },
  );

  test("no open issue is a silent no-op", async () => {
    const { run, calls } = fakeGh(undefined);
    await resolveIssue(run, "o/r", "fuzz-nightly", env);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(false);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "close")).toBe(false);
  });

  test("every open labeled issue is closed, not just the first", async () => {
    // The release gate blocks while ANY open issue carries the label, so a
    // green night must clear the whole set (a human can label extras in).
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([{ number: 5 }, { number: 8 }]);
      }
      return "";
    };
    await resolveIssue(run, "o/r", "fuzz-nightly", env);
    for (const number of ["5", "8"]) {
      expect(calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === number)).toBe(
        true,
      );
      expect(calls.some((c) => c[0] === "issue" && c[1] === "close" && c[2] === number)).toBe(true);
    }
  });

  test("a stale listing that re-serves closed issues does not strand later pages", async () => {
    // Page 1 closes; the next listing lags, re-serving only just-closed
    // numbers; the listing after that reveals the next page. The drain
    // must push through the stale round and still close everything.
    const listings = [
      [{ number: 1 }, { number: 2 }],
      [{ number: 1 }, { number: 2 }], // lagging: all already closed
      [{ number: 3 }],
      [],
    ];
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify(listings.shift() ?? []);
      }
      return "";
    };
    await resolveIssue(run, "o/r", "fuzz-nightly", env);
    for (const number of ["1", "2", "3"]) {
      expect(calls.some((c) => c[0] === "issue" && c[1] === "close" && c[2] === number)).toBe(true);
    }
  });

  test("a permanently stale listing terminates instead of looping", async () => {
    const calls: string[][] = [];
    const run: GhRunner = async (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([{ number: 4 }]); // never observes the close
      }
      return "";
    };
    await resolveIssue(run, "o/r", "fuzz-nightly", env);
    expect(calls.filter((c) => c[0] === "issue" && c[1] === "close").length).toBe(1);
  });
});

describe("issueNumberFromUrl", () => {
  test("parses the trailing number from a gh issue URL", () => {
    expect(issueNumberFromUrl("https://github.com/o/r/issues/42\n")).toBe(42);
  });

  test("returns undefined when the URL has no trailing number", () => {
    expect(issueNumberFromUrl("not a url")).toBeUndefined();
  });
});

describe("action.yml input defaults", () => {
  // No yaml dependency in this package: each default is a plain one-line
  // scalar, so line extraction is exact enough.
  const inputDefault = (name: string): string | undefined => {
    const actionYml = readFileSync(join(import.meta.dir, "action.yml"), "utf-8");
    const re = new RegExp(`^ {2}${name}:\\n(?: {4}.+\\n)*? {4}default: (.+)$`, "m");
    return actionYml.match(re)?.[1];
  };

  test.each([
    { input: "title", expected: DEFAULT_TITLE, reason: "DEFAULT_TITLE" },
    { input: "label-color", expected: `"${DEFAULT_LABEL_COLOR}"`, reason: "DEFAULT_LABEL_COLOR" },
    {
      input: "label-description",
      expected: DEFAULT_LABEL_DESCRIPTION,
      reason: "DEFAULT_LABEL_DESCRIPTION",
    },
  ])("the `$input` input default matches $reason", ({ input, expected }) => {
    expect(inputDefault(input)).toBe(expected);
  });
});
