/**
 * Unit test for the fuzz-issue action's pure helpers: line/char truncation,
 * the run-link builder, failure-dir discovery, body assembly over failure
 * directories built in a temp dir (contract v1), and the issue lifecycle
 * (create/comment/resolve) through an injected fake gh runner. The real gh
 * calls are not tested here (they need a live GitHub).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockTitle,
  buildBody,
  capChars,
  DEFAULT_TITLE,
  failureDirs,
  fileIssue,
  type GhRunner,
  head,
  issueNumberFromUrl,
  LABEL_RE,
  resolveIssue,
  runUrl,
} from "./fuzz-issue";

const env = {
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_RUN_ID: "42",
} as NodeJS.ProcessEnv;

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

  test("truncates a long single line to at most `max` characters", () => {
    const out = capChars("x".repeat(1000), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("... (truncated)")).toBe(true);
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
  test("uses the report's first heading", () => {
    expect(blockTitle("/x/target", "# fuzz: target crashed\n\nbody")).toBe("fuzz: target crashed");
  });

  test("strips every leading heading marker", () => {
    expect(blockTitle("/x/target", "## fuzz: target crashed\n")).toBe("fuzz: target crashed");
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
    mkdirSync(join(root, "mcp_jsonrpc"), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("builds one block per failure with the report head and replay command", () => {
    const body = buildBody(failureDirs(root), env, "fuzz-failures-1");
    expect(body).toContain("2 failure report(s)");
    expect(body).toContain("## fuzz: nm_frame crashed");
    expect(body).toContain("cargo +nightly fuzz run nm_frame fuzz/artifacts/nm_frame/crash-abc");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
  });

  test("names the uploaded artifact when given", () => {
    const body = buildBody(failureDirs(root), env, "fuzz-failures-1");
    expect(body).toContain("`fuzz-failures-1`");
  });

  test("points at the run's artifact list when no artifact name is given", () => {
    const body = buildBody(failureDirs(root), env, "");
    expect(body).toContain("see its artifacts list");
  });

  test("a failure dir without report.md is titled by its directory name", () => {
    const body = buildBody(failureDirs(root), env, "");
    expect(body).toContain("## mcp_jsonrpc (no report.md)");
  });

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
    const body = buildBody([], env, "a");
    expect(body).toContain("no failure report");
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
  });
});

/**
 * A recording gh runner: captures every command, answers the label-list
 * query from `labelTaken`, and the issue-list query from `openNumber` (a
 * number opens the comment path, undefined the create path).
 */
function fakeGh(openNumber?: number, labelTaken = false): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "label" && args[1] === "list") {
      return JSON.stringify(labelTaken ? [{ name: args[3] }] : []);
    }
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify(openNumber === undefined ? [] : [{ number: openNumber }]);
    }
    if (args[0] === "issue" && args[1] === "create") {
      return "https://github.com/o/r/issues/7\n";
    }
    return "";
  };
  return { run, calls };
}

describe("fileIssue", () => {
  test("create path opens a labeled issue with the body and title", async () => {
    const { run, calls } = fakeGh(undefined);
    await fileIssue(run, "body", "fuzz-nightly", DEFAULT_TITLE);
    const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create?.[create.indexOf("--label") + 1]).toBe("fuzz-nightly");
    expect(create?.[create.indexOf("--title") + 1]).toBe(DEFAULT_TITLE);
    expect(create?.[create.indexOf("--body") + 1]).toBe("body");
  });

  test("comment path comments on the existing issue, does not create a new one", async () => {
    const { run, calls } = fakeGh(3);
    await fileIssue(run, "body", "fuzz-nightly", "t");
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment" && c[2] === "3")).toBe(true);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "create")).toBe(false);
  });

  test("the filer performs no assignment on either path", async () => {
    // Assignment policy lives in the auto-assign workflow, which the caller
    // dispatches after filing; the filer must never touch assignees.
    for (const openNumber of [undefined, 3]) {
      const { run, calls } = fakeGh(openNumber);
      await fileIssue(run, "body", "fuzz-nightly", "t");
      const flat = calls.flat();
      expect(flat).not.toContain("--assignee");
      expect(flat).not.toContain("--add-assignee");
      expect(calls.some((c) => c[0] === "issue" && c[1] === "edit")).toBe(false);
    }
  });

  test("returns the created issue number (parsed from gh's create URL)", async () => {
    const { run } = fakeGh(undefined); // fakeGh's create returns .../issues/7
    expect(await fileIssue(run, "body", "fuzz-nightly", "t")).toBe(7);
  });

  test("returns the existing issue number on the comment path", async () => {
    const { run } = fakeGh(3);
    expect(await fileIssue(run, "body", "fuzz-nightly", "t")).toBe(3);
  });

  test("creates the label only when the list says it is missing", async () => {
    const { run, calls } = fakeGh(undefined, false);
    await fileIssue(run, "body", "fuzz-nightly", "t");
    const create = calls.find((c) => c[0] === "label" && c[1] === "create");
    expect(create).toBeDefined();
    expect(create).not.toContain("--force");
  });

  test("never touches a pre-existing label (no create, no repaint)", async () => {
    // Someone pointing the action at `bug` must not get it repainted red.
    const { run, calls } = fakeGh(9, true);
    expect(await fileIssue(run, "body", "bug", "t")).toBe(9);
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
    expect(fileIssue(run, "body", "fuzz-nightly", "t")).rejects.toThrow("auth required");
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

describe("resolveIssue", () => {
  test("comments then closes the open labeled issue", async () => {
    const { run, calls } = fakeGh(5);
    await resolveIssue(run, "fuzz-nightly", env);
    const commentIdx = calls.findIndex((c) => c[0] === "issue" && c[1] === "comment");
    const closeIdx = calls.findIndex((c) => c[0] === "issue" && c[1] === "close");
    expect(commentIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThan(commentIdx);
    expect(calls[commentIdx]?.[2]).toBe("5");
    expect(calls[closeIdx]?.[2]).toBe("5");
    expect(calls[closeIdx]).toContain("--reason");
    // The comment names the run and hedges on unpinned crashes.
    const body = calls[commentIdx]?.[calls[commentIdx].indexOf("--body") + 1] ?? "";
    expect(body).toContain("Run: https://github.com/o/r/actions/runs/42");
    expect(body).toContain("regression");
  });

  test("no open issue is a silent no-op", async () => {
    const { run, calls } = fakeGh(undefined);
    await resolveIssue(run, "fuzz-nightly", env);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "comment")).toBe(false);
    expect(calls.some((c) => c[0] === "issue" && c[1] === "close")).toBe(false);
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

describe("DEFAULT_TITLE", () => {
  test("matches the title input default declared in action.yml", () => {
    // No yaml dependency in this package: the default is a plain one-line
    // scalar, so line extraction is exact enough.
    const actionYml = readFileSync(join(import.meta.dir, "action.yml"), "utf-8");
    const match = actionYml.match(/^ {2}title:\n(?: {4}.+\n)*? {4}default: (.+)$/m);
    expect(match?.[1]).toBe(DEFAULT_TITLE);
  });
});
