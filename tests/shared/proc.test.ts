// Pins the timeout contract on capture and mustCapture: every piped run
// is bounded - an explicit timeoutMs wins, and without one the default
// hang bound applies (bun >= 1.4.0 waits for piped-stdio EOF rather than
// child exit, so an unbounded piped run can hang forever on an orphaned
// pipe holder). A run cut off by its deadline is a FAILURE: capture
// reports timedOut with a nonzero exitCode, mustCapture names the
// deadline and exits nonzero - even when the child itself exited 0 and
// only an orphan wedged the pipe until the deadline.

import { describe, expect, test } from "bun:test";
import {
  capture,
  DEFAULT_HANG_BOUND_MS,
  mustCapture,
  redactCommand,
  redactText,
  timeoutExitCode,
} from "../../.github/scripts/shared/proc";

describe("capture timeoutMs", () => {
  test("absent: the hang bound is the deadline; a normal exit reports timedOut false", () => {
    // Minutes, not seconds - a hang bound must never cut a legitimate
    // operation short - but small enough to fire before the job-level
    // timeout kills the runner.
    expect(DEFAULT_HANG_BOUND_MS).toBe(300_000);
    const result = capture(["true"]);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("an expiring deadline kills the child and reports timedOut", () => {
    const start = Date.now();
    const result = capture(["sleep", "5"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("an orphan holding the pipe cannot stretch the deadline or mask the kill", () => {
    // The child is still running at the deadline while its backgrounded
    // grandchild holds the pipe fds: the SIGKILL only reaps the child, so
    // spawnSync must return at the kill (not at the orphan's EOF, ~5s)
    // and report a loud nonzero timeout under every bun version.
    const start = Date.now();
    const result = capture(["sh", "-c", "sleep 5 & sleep 5"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  test("a clean child exit behind a pipe-wedging orphan never reads as success", () => {
    // Under bun >= 1.4.0 this child exits 0 immediately but spawnSync
    // waits at the pipe until the deadline and reports exitedDueToTimeout
    // with the child's exit code 0 - which must surface as timedOut plus
    // a nonzero exitCode (124). Under bun < 1.4.0 spawnSync returns at
    // child exit, so the run legitimately succeeds; either way, timedOut
    // and a zero exitCode must never coincide.
    const result = capture(["sh", "-c", "sleep 2 & exit 0"], { timeoutMs: 400 });
    expect(result.exitCode).toBe(result.timedOut ? 124 : 0);
  });

  test("a deadline that is not hit: timedOut false, output intact", () => {
    // 2000ms, comfortably inside bun-test's default 5000ms per-test cap:
    // a deadline equal to the cap would report a wedged run as an opaque
    // test kill instead of capture's own diagnostics.
    const result = capture(["echo", "ok"], { timeoutMs: 2000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok\n");
  });
});

describe("timeoutExitCode", () => {
  test("a child that exited 0 before the deadline still maps to failure (124)", () => {
    expect(timeoutExitCode({ exitCode: 0, signalCode: null })).toBe(124);
  });

  test("a killed or failed child keeps its own code", () => {
    expect(timeoutExitCode({ exitCode: null, signalCode: "SIGKILL" })).toBe(137);
    expect(timeoutExitCode({ exitCode: 3, signalCode: null })).toBe(3);
  });
});

describe("redactCommand", () => {
  test("masks URL userinfo, keeping scheme and host", () => {
    expect(
      redactCommand(["git", "push", "https://x-access-token:ghp_secret@github.com/o/r.git"]),
    ).toBe("git push https://***@github.com/o/r.git");
  });

  test("masks userinfo whose password itself contains an @", () => {
    expect(redactCommand(["https://user:p@ss@example.com/x"])).toBe("https://***@example.com/x");
  });

  test("masks the bare x-access-token shape even without a scheme", () => {
    expect(redactCommand(["x-access-token:ghp_secret@github.com/o/r.git"])).toBe(
      "x-access-token:***@github.com/o/r.git",
    );
  });

  test("masks a token that itself contains an @, leaving no fragment of it", () => {
    expect(redactCommand(["x-access-token:abc@def@github.com/o/r.git"])).toBe(
      "x-access-token:***@github.com/o/r.git",
    );
  });

  test("an @ in a query or fragment is not userinfo and stays verbatim", () => {
    const argv = ["https://example.com?mail=a@b", "https://example.com#sec@ref"];
    expect(redactCommand(argv)).toBe(argv.join(" "));
  });

  test("leaves credential-free argv verbatim", () => {
    const argv = ["git", "ls-remote", "https://github.com/o/r.git", "refs/heads/main", "a@b"];
    expect(redactCommand(argv)).toBe(argv.join(" "));
  });
});

describe("redactText", () => {
  test("masks the credentialed URL git's own error text quotes back", () => {
    // The shape commit_push re-emits: git 401/403 errors embed the push
    // URL, credentials included - redactCommand covers our argv lines,
    // this covers the child's output.
    const gitError =
      "fatal: unable to access 'https://x-access-token:ghp_SENTINEL@github.com/o/r.git/': The requested URL returned error: 403\n";
    const redacted = redactText(gitError);
    expect(redacted).not.toContain("ghp_SENTINEL");
    expect(redacted).toBe(
      "fatal: unable to access 'https://***@github.com/o/r.git/': The requested URL returned error: 403\n",
    );
  });

  test("masks every credentialed URL in multi-line output", () => {
    const text =
      "remote: https://user:ghp_SENTINEL@github.com/o/r.git\nhint: x-access-token:ghp_SENTINEL@github.com/o/r.git\n";
    const redacted = redactText(text);
    expect(redacted).not.toContain("ghp_SENTINEL");
    expect(redacted).toContain("https://***@github.com/o/r.git");
    expect(redacted).toContain("x-access-token:***@github.com/o/r.git");
  });

  test("a URL without credentials survives verbatim", () => {
    const text =
      "To https://github.com/o/r.git\n ! [rejected] automation/repo-platform (stale info)\n";
    expect(redactText(text)).toBe(text);
  });
});

describe("mustCapture timeoutMs", () => {
  const procModule = new URL("../../.github/scripts/shared/proc.ts", import.meta.url).pathname;

  test("a deadline that is not hit returns trimmed stdout", () => {
    // 2000ms for the same cap-headroom reason as the capture twin above.
    expect(mustCapture(["echo", "ok"], { timeoutMs: 2000 })).toBe("ok");
  });

  // The expiry path exits the calling process, so these tests run
  // mustCapture in a child bun: process.execPath, never a bare "bun"
  // (PATH's bun can be a DIFFERENT version than the runner, hiding
  // version-specific semantics from a version-gated run), and the outer
  // capture bound plus the elapsed guards stay well under bun-test's
  // 5000ms per-test limit, so a wedged chain fails with capture's own
  // diagnostics (timedOut true) instead of an opaque test timeout.

  test("an expiring deadline names it and exits nonzero", () => {
    const snippet = [
      `import { mustCapture } from ${JSON.stringify(procModule)};`,
      'mustCapture(["sleep", "5"], { timeoutMs: 200 });',
      'console.log("unreachable");',
    ].join("\n");
    const start = Date.now();
    const result = capture([process.execPath, "-e", snippet], { timeoutMs: 2000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("unreachable");
    expect(result.stderr).toContain("timed out after 200ms: sleep 5");
    expect(Date.now() - start).toBeLessThan(4000);
  });

  test("the expiry line redacts credentials carried in argv", () => {
    // The sync push passes mustCapture an argv holding the fleet PAT
    // inside the push URL; the deadline-expiry line is reachable for
    // every call now that the default hang bound exists, so it must
    // never echo the token into the (public) Actions log. The stalled
    // child must EXEC its sleep with fds detached: a shell is the only
    // child whose argv can carry the URL past the deadline, but a forked
    // sleeper surviving the deadline kill would hold the inherited
    // stderr - THIS test's outer pipe - which bun >= 1.4.0 waits on to
    // EOF (a plain `sh -c "sleep 5"` forked exactly so on Linux and hung
    // this test for the sleep's full 5s). exec pins the sleeper to the
    // killed pid; the /dev/null fds mean even a survivor could not
    // wedge the pipes.
    const url = "https://x-access-token:ghp_SUPERSECRET@github.com/octo/repo.git";
    const stalled = ["sh", "-c", "exec sleep 5 </dev/null >/dev/null 2>&1", "sh", url];
    const snippet = [
      `import { mustCapture } from ${JSON.stringify(procModule)};`,
      `mustCapture(${JSON.stringify(stalled)}, { timeoutMs: 200 });`,
    ].join("\n");
    const start = Date.now();
    const result = capture([process.execPath, "-e", snippet], { timeoutMs: 2000 });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).not.toContain("ghp_SUPERSECRET");
    expect(result.stderr).toContain("timed out after 200ms:");
    expect(result.stderr).toContain("https://***@github.com/octo/repo.git");
    expect(Date.now() - start).toBeLessThan(4000);
  });
});
