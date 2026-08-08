import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../.github/scripts/sync/failure_issue.ts");
const SLUG = "Vivswan/hidden-server";

// Records every invocation to GH_CALLS, copies any body=@file payload to
// GH_BODY, answers `api user` with a login and issue-list GETs with the
// canned GH_LOOKUP; GH_FAIL picks a failure mode, each with a leaky error.
const ghStub = `#!/usr/bin/env bash
set -euo pipefail
{ printf 'gh'; printf ' %s' "$@"; echo; } >>"$GH_CALLS"
if [ "\${GH_FAIL:-}" = "all" ]; then
  echo "gh: Not Found (HTTP 404): repos/${SLUG}/issues" >&2
  exit 1
fi
if [ "\${GH_FAIL:-}" = "network" ]; then
  echo "dial tcp: lookup api.github.com for repos/${SLUG}: no such host" >&2
  exit 1
fi
for a in "$@"; do
  case "$a" in body=@*) cp "\${a#body=@}" "$GH_BODY" ;; esac
done
if [ "\${2:-}" = "user" ]; then
  echo "token-bot"
  exit 0
fi
method=GET
prev=""
for a in "$@"; do
  if [ "$prev" = "--method" ]; then method="$a"; fi
  prev="$a"
done
case "$method" in
  GET) printf '%s' "\${GH_LOOKUP:-}" ;;
  POST | PATCH)
    if [ "\${GH_FAIL:-}" = "write" ]; then
      echo "gh: Validation Failed (HTTP 422): ${SLUG}" >&2
      exit 1
    fi
    ;;
esac
`;

interface Options {
  failures?: { label: string; slug: string; rc: number; output: string }[];
  lookup?: string;
  fail?: string;
  prUrl?: string;
}

function run(mode: string | undefined, opts: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "failure-issue-"));
  const temp = join(root, "temp");
  const bin = join(root, "bin");
  mkdirSync(temp);
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghStub, { mode: 0o755 });
  const calls = join(root, "calls.log");
  const bodyOut = join(root, "delivered-body.md");
  if (opts.failures) {
    const lines = opts.failures.map((f) => {
      const log = join(temp, `hidden-${f.slug}.log`);
      writeFileSync(log, f.output);
      return `${f.label}\t${f.rc}\t${log}`;
    });
    writeFileSync(join(temp, "hidden-failures.tsv"), `${lines.join("\n")}\n`);
  }
  const proc = Bun.spawnSync(["bun", script, ...(mode === undefined ? [] : [mode])], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      TARGET: SLUG,
      RUN_URL: "https://github.com/Vivswan/repo-platform/actions/runs/123",
      GITHUB_REPOSITORY: "Vivswan/repo-platform",
      GH_CALLS: calls,
      GH_BODY: bodyOut,
      GH_LOOKUP: opts.lookup ?? "",
      GH_FAIL: opts.fail ?? "",
      PR_URL: opts.prUrl ?? "",
    },
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    calls: existsSync(calls) ? readFileSync(calls, "utf-8") : "",
    body: existsSync(bodyOut) ? readFileSync(bodyOut, "utf-8") : "",
  };
}

const oneFailure = [
  { label: "copier update", slug: "copier-update", rc: 3, output: "Traceback: secret target path" },
];

describe("failure_issue.ts", () => {
  test("rejects a missing mode without touching the API", () => {
    const r = run(undefined);
    expect(r.exitCode).toBe(2);
    expect(r.output).toContain("::error::");
    expect(r.calls).toBe("");
  });

  test("deliver skips when a PR already carries the diagnostics", () => {
    const r = run("deliver", { failures: oneFailure, prUrl: "https://github.com/x/y/pull/1" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("sync PR carries");
    expect(r.calls).toBe("");
  });

  test("deliver no-ops when no hidden step failed", () => {
    const r = run("deliver");
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("no hidden step failed");
    expect(r.calls).toBe("");
  });

  test("deliver creates the issue when none exists", () => {
    const r = run("deliver", { failures: oneFailure });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain(`repos/${SLUG}/issues --method GET`);
    expect(r.calls).toContain("sort=created");
    expect(r.calls).toContain("direction=asc");
    expect(r.calls).toContain(`repos/${SLUG}/issues --method POST`);
    expect(r.calls).toContain("title=[automated] repo-platform sync: private failure report");
    expect(r.body).toContain("## copier update: exit 3");
    expect(r.body).toContain("Traceback: secret target path");
    expect(r.body).toContain("actions/runs/123");
    expect(r.body).toContain("docs/private-repos.md");
    expect(r.output).not.toContain("hidden-server");
  });

  test("deliver replaces and reopens an existing issue", () => {
    const r = run("deliver", { failures: oneFailure, lookup: "17 closed" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain(`repos/${SLUG}/issues/17 --method PATCH`);
    expect(r.calls).toContain("state=open");
    expect(r.calls).not.toContain("--method POST");
    expect(r.output).not.toContain("hidden-server");
  });

  test("deliver bounds an oversized capture", () => {
    const r = run("deliver", {
      failures: [
        { label: "copier update", slug: "copier-update", rc: 1, output: "x".repeat(30000) },
      ],
    });
    expect(r.body).toContain("(truncated at 20000 bytes");
    expect(r.body.length).toBeLessThan(25000);
  });

  test("a capture full of backticks cannot terminate its own fence", () => {
    const r = run("deliver", {
      failures: [
        { label: "copier update", slug: "copier-update", rc: 1, output: "before\n`````raw\nafter" },
      ],
    });
    expect(r.body).toContain("``````text\nbefore\n`````raw\nafter\n``````");
  });

  test("a NUL byte cannot hide backtick runs from the fence scan", () => {
    const r = run("deliver", {
      failures: [
        {
          label: "copier update",
          slug: "copier-update",
          rc: 1,
          output: "bin\u0000ary\n`````raw\nafter",
        },
      ],
    });
    expect(r.body).toContain("``````text");
    expect(r.body).toContain("`````raw");
  });

  test("a giant backtick run collapses and the body stays bounded", () => {
    const r = run("deliver", {
      failures: [
        { label: "copier update", slug: "copier-update", rc: 1, output: "`".repeat(30000) },
      ],
    });
    expect(r.body).toContain(`${"`".repeat(101)}text`);
    expect(r.body).toContain(`\n${"`".repeat(100)}\n`);
    expect(r.body).toContain("(truncated at 20000 bytes");
    expect(r.body.length).toBeLessThan(64000);
  });

  test("a run split by the truncation cut is fenced by its shipped length", () => {
    const r = run("deliver", {
      failures: [
        {
          label: "copier update",
          slug: "copier-update",
          rc: 1,
          output: "x".repeat(19995) + "`".repeat(10),
        },
      ],
    });
    expect(r.body).toContain("``````text");
    expect(r.body).not.toContain("```````");
    expect(r.body).toContain("(truncated at 20000 bytes");
  });

  test("a failed delivery warns once with the status only and exits 0", () => {
    const r = run("deliver", { failures: oneFailure, fail: "all" });
    expect(r.exitCode).toBe(0);
    expect(r.output.split("::warning::").length).toBe(2);
    expect(r.output).toContain("(HTTP 404)");
    expect(r.output).toContain("Issues read/write");
    expect(r.output).not.toContain("hidden-server");
    expect(r.output).not.toContain("Not Found");
    expect(r.output).not.toContain("repos/");
  });

  test("a non-permission write failure advises a re-run", () => {
    const r = run("deliver", { failures: oneFailure, fail: "write" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("(HTTP 422)");
    expect(r.output).toContain("Re-run the sync");
    expect(r.output).not.toContain("Issues read/write");
    expect(r.output).not.toContain("hidden-server");
  });

  test("a failure with no HTTP response stays slug-free", () => {
    const r = run("deliver", { failures: oneFailure, fail: "network" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("(no HTTP response arrived)");
    expect(r.output).not.toContain("hidden-server");
    expect(r.output).not.toContain("no such host");
  });

  test("resolve is a silent no-op without an issue", () => {
    const r = run("resolve");
    expect(r.exitCode).toBe(0);
    expect(r.calls).not.toContain("PATCH");
  });

  test("resolve leaves a closed issue alone", () => {
    const r = run("resolve", { lookup: "9 closed" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).not.toContain("PATCH");
  });

  test("resolve closes an open issue with a healthy note", () => {
    const r = run("resolve", { lookup: "9 open" });
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain(`repos/${SLUG}/issues/9 --method PATCH`);
    expect(r.calls).toContain("state=closed");
    expect(r.body).toContain("Healthy");
    expect(r.body).toContain("actions/runs/123");
    expect(r.output).not.toContain("hidden-server");
  });

  test("a failed resolve warns once with the status only and exits 0", () => {
    const r = run("resolve", { fail: "all" });
    expect(r.exitCode).toBe(0);
    expect(r.output.split("::warning::").length).toBe(2);
    expect(r.output).toContain("(HTTP 404)");
    expect(r.output).not.toContain("hidden-server");
    expect(r.output).not.toContain("Not Found");
  });
});
