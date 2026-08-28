// End-to-end sentinel on commit_push.ts's credential redaction: git's OWN
// error text quotes the credentialed push URL back (the 401/403 shape),
// and redactCommand only covers our argv lines - so the script must pass
// every re-emission of git's output (stderr, stdout, the push.err file)
// through redactText. A stub git on PATH forces the credentialed error
// shapes; the assertions are on the script's whole public output.

import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capture } from "../../.github/scripts/shared/proc.ts";

const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/commit_push.ts");
const SENTINEL = "ghp_SENTINEL";
const GIT_ERROR = `fatal: unable to access 'https://x-access-token:${SENTINEL}@github.com/o/r.git/': The requested URL returned error: 403`;

// Case order matters: the push argv also contains the URL, so ls-remote
// must match first. STUB_MODE=lease-fail fails the lease probe; push-fail
// serves the lease and fails the push itself.
const STUB_GIT = `#!/bin/sh
case "$*" in
  *ls-remote*)
    if [ "$STUB_MODE" = "lease-fail" ]; then
      echo "${GIT_ERROR}" >&2
      exit 128
    fi
    printf '0123456789012345678901234567890123456789\\trefs/heads/automation/repo-platform\\n'
    exit 0 ;;
  *" push "*)
    echo "${GIT_ERROR}" >&2
    echo "remote: see https://x-access-token:${SENTINEL}@github.com/o/r.git"
    exit 1 ;;
  *) exit 0 ;;
esac
`;

let scratch: string;
let stubBin: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "commit-push-"));
  stubBin = join(scratch, "bin");
  mkdirSync(stubBin);
  mkdirSync(join(scratch, "work", "target"), { recursive: true });
  writeFileSync(join(stubBin, "git"), STUB_GIT);
  chmodSync(join(stubBin, "git"), 0o755);
});

function runCommitPush(mode: string, hideDetails: string) {
  const runnerTemp = mkdtempSync(join(scratch, "rt-"));
  writeFileSync(join(runnerTemp, "gh-output.txt"), "");
  const result = capture([process.execPath, SCRIPT], {
    cwd: join(scratch, "work"),
    env: {
      PATH: `${stubBin}:${process.env.PATH}`,
      STUB_MODE: mode,
      TARGET: "o/r",
      TARGET_DISPLAY: hideDetails === "true" ? "repo #1" : "",
      BRANCH: "automation/repo-platform",
      DISPLAY: "v1 (abcdef012345)",
      BASE_BRANCH: "main",
      PAT: SENTINEL,
      HIDE_DETAILS: hideDetails,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: join(runnerTemp, "gh-output.txt"),
    },
    timeoutMs: 30_000,
  });
  return { ...result, runnerTemp };
}

describe("commit_push credential redaction", () => {
  test("a failing lease probe re-emits git's error redacted", () => {
    const result = runCommitPush("lease-fail", "false");
    expect(result.exitCode).toBe(128);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).toContain("unable to access 'https://***@github.com/o/r.git/'");
  });

  test("a hidden target's failing lease probe emits no git output at all", () => {
    const result = runCommitPush("lease-fail", "true");
    expect(result.exitCode).toBe(128);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).not.toContain("o/r");
    expect(result.stdout).toContain("(ls-remote output hidden: private repository)");
  });

  test("a failing push redacts both streams and the push.err file", () => {
    const result = runCommitPush("push-fail", "false");
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(result.stderr).toContain("unable to access 'https://***@github.com/o/r.git/'");
    expect(result.stdout).toContain("https://***@github.com/o/r.git");
    const pushErr = readFileSync(join(result.runnerTemp, "push.err"), "utf-8");
    expect(pushErr).not.toContain(SENTINEL);
    expect(pushErr).toContain("https://***@github.com/o/r.git");
  });

  test("a hidden target's failing push keeps its slug off both streams", () => {
    const result = runCommitPush("push-fail", "true");
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    // Redaction alone would keep the slug (o/r survives redactText); the
    // hidden path must withhold git's output on BOTH streams entirely.
    expect(result.stdout + result.stderr).not.toContain("o/r");
    expect(result.stdout).toContain("(push output hidden: private repository)");
  });
});
