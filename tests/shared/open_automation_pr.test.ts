import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/shared/open_automation_pr.ts");

// Records every git/gh invocation to CALLS_LOG with arguments separated by
// \x1f and records by \x1e, so split arguments and multiline values stay
// distinguishable. `gh pr list` answers the canned PR_LOOKUP, and
// GIT_FAIL/GH_FAIL pick a subcommand that exits 1.
const stub = (tool: string) => `#!/usr/bin/env bash
set -euo pipefail
{ printf '%s' "${tool}"; for a in "$@"; do printf '\\x1f%s' "$a"; done; printf '\\x1e'; } >>"$CALLS_LOG"
if [ "\${${tool.toUpperCase()}_FAIL:-}" = "\${1:-}" ]; then
  echo "${tool} \${1:-} failed" >&2
  exit 1
fi
if [ "${tool}" = "gh" ] && [ "\${2:-}" = "list" ]; then
  printf '%s' "\${PR_LOOKUP:-}"
fi
`;

interface Options {
  env?: Record<string, string>;
  lookup?: string;
  drop?: string[];
}

function run(opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "open-automation-pr-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), stub("git"), { mode: 0o755 });
  writeFileSync(join(bin, "gh"), stub("gh"), { mode: 0o755 });
  const calls = join(root, "calls.log");
  const scriptEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CALLS_LOG: calls,
    PR_LOOKUP: opts.lookup ?? "",
    BRANCH: "automation/x-refresh",
    BASE_BRANCH: "main",
    COMMIT_MESSAGE: "chore: refresh x from upstream@abc",
    PR_TITLE: "chore: refresh x from upstream",
    PR_BODY: "Automated refresh body.",
    ...opts.env,
  };
  for (const name of opts.drop ?? []) delete scriptEnv[name];
  const proc = Bun.spawnSync(["bun", script], { env: scriptEnv });
  const raw = existsSync(calls) ? readFileSync(calls, "utf-8") : "";
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    calls: raw
      .split("\x1e")
      .filter(Boolean)
      .map((record) => record.split("\x1f")),
  };
}

describe("open_automation_pr.ts", () => {
  test("a missing required env fails before any command runs", () => {
    const r = run({ drop: ["PR_BODY"] });
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("::error::PR_BODY must be set");
    expect(r.calls).toEqual([]);
  });

  test("commits the tree onto the branch, force-pushes, and creates the PR", () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.calls).toEqual([
      ["git", "config", "user.name", "repo-platform-sync"],
      ["git", "config", "user.email", "repo-platform-sync@users.noreply.github.com"],
      ["git", "checkout", "-B", "automation/x-refresh"],
      ["git", "add", "-A"],
      ["git", "commit", "-m", "chore: refresh x from upstream@abc"],
      ["git", "push", "--force", "origin", "automation/x-refresh"],
      // biome-ignore format: one argv per line loses the record shape
      ["gh", "pr", "list", "--head", "automation/x-refresh", "--json", "number", "--jq", ".[0].number // empty"],
      // biome-ignore format: one argv per line loses the record shape
      ["gh", "pr", "create", "--base", "main", "--head", "automation/x-refresh", "--title", "chore: refresh x from upstream", "--body", "Automated refresh body."],
    ]);
  });

  test("a multiline body reaches the PR as one argument", () => {
    const body =
      "**MAJOR VERSION JUMP: bun 2 - review before merging.**\n\nAutomated refresh body.";
    const r = run({ env: { PR_BODY: body } });
    expect(r.exitCode).toBe(0);
    const create = r.calls.find((call) => call[1] === "pr" && call[2] === "create");
    expect(create?.at(-1)).toBe(body);
  });

  test("an existing PR gets its body refreshed, not a duplicate PR", () => {
    const r = run({ lookup: "17" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContainEqual(["gh", "pr", "edit", "17", "--body", "Automated refresh body."]);
    expect(r.calls.some((call) => call[2] === "create")).toBe(false);
  });

  test("REFRESH_TITLE=true refreshes an existing PR's title too", () => {
    const r = run({ lookup: "17", env: { REFRESH_TITLE: "true" } });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContainEqual([
      "gh",
      "pr",
      "edit",
      "17",
      "--title",
      "chore: refresh x from upstream",
      "--body",
      "Automated refresh body.",
    ]);
  });

  test("a failed push stops the run before any PR call", () => {
    const r = run({ env: { GIT_FAIL: "push" } });
    expect(r.exitCode).toBe(1);
    expect(r.calls.some((call) => call[0] === "gh")).toBe(false);
  });

  test("a failed PR lookup fails the run instead of double-creating", () => {
    const r = run({ env: { GH_FAIL: "pr" } });
    expect(r.exitCode).toBe(1);
    expect(r.calls.some((call) => call[2] === "create")).toBe(false);
  });
});
