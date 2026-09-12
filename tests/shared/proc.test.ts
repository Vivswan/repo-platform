import { describe, expect, spyOn, test } from "bun:test";
import {
  capture,
  DEFAULT_HANG_BOUND_MS,
  mustCapture,
  passthrough,
  redactCommand,
  redactText,
  timeoutExitCode,
} from "../../.github/scripts/shared/proc";

describe("spawn env is live process.env", () => {
  // Bun.spawnSync WITHOUT `env:` hands children a snapshot of the environment
  // taken at PROCESS START (bun 1.4.0), so a test or script mutating
  // process.env before calling through proc.ts would get a silently inert pin.

  test("a key added to process.env after start reaches capture's child", () => {
    process.env.PROC_ENV_PROBE_ADDED = "live";
    try {
      const result = capture(["sh", "-c", 'echo "${PROC_ENV_PROBE_ADDED-unset}"'], {
        timeoutMs: 2000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("live\n");
    } finally {
      delete process.env.PROC_ENV_PROBE_ADDED;
    }
  });

  test("a key deleted from process.env after start is absent in capture's child", () => {
    // HOME is the deletion subject because the snapshot only carries
    // keys present at process start - a key this test added would be
    // missing from the child under BOTH behaviors, proving nothing.
    const saved = process.env.HOME;
    expect(saved).toBeDefined();
    delete process.env.HOME;
    try {
      const result = capture(["sh", "-c", 'echo "${HOME-unset}"'], { timeoutMs: 2000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("unset\n");
    } finally {
      process.env.HOME = saved;
    }
  });

  test("passthrough and mustCapture hand the live environment too", () => {
    // passthrough's stdio is inherited, so the child reports through
    // its exit code; mustCapture through its captured stdout (the
    // `-unset` fallback keeps its exit-the-process failure path
    // unreachable here).
    process.env.PROC_ENV_PROBE_ADDED = "live";
    try {
      expect(passthrough(["sh", "-c", 'test "$PROC_ENV_PROBE_ADDED" = live'])).toBe(0);
      expect(
        mustCapture(["sh", "-c", 'echo "${PROC_ENV_PROBE_ADDED-unset}"'], { timeoutMs: 2000 }),
      ).toBe("live");
    } finally {
      delete process.env.PROC_ENV_PROBE_ADDED;
    }
  });

  test("an explicit options.env call still inherits the rest of live process.env", () => {
    // The merge's other half: handing a per-call entry must not strip
    // the ambient environment (PATH, HOME, credentials) from the child -
    // the regression where the spread's process.env base is dropped.
    process.env.PROC_ENV_PROBE_ADDED = "live";
    try {
      const result = capture(
        ["sh", "-c", 'echo "${PROC_ENV_PROBE_ADDED-unset} ${PROC_ENV_PROBE_OTHER-unset}"'],
        { env: { PROC_ENV_PROBE_OTHER: "explicit" }, timeoutMs: 2000 },
      );
      expect(result.stdout).toBe("live explicit\n");
    } finally {
      delete process.env.PROC_ENV_PROBE_ADDED;
    }
  });

  test.each([
    [
      "an explicit options.env entry wins over the ambient value",
      { PROC_ENV_PROBE_ADDED: "explicit" },
      "explicit\n",
    ],
    [
      "an undefined-valued options.env entry deletes the key for the child",
      { PROC_ENV_PROBE_ADDED: undefined },
      "unset\n",
    ],
  ])("%s", (_reason, env, expected) => {
    process.env.PROC_ENV_PROBE_ADDED = "ambient";
    try {
      const result = capture(["sh", "-c", 'echo "${PROC_ENV_PROBE_ADDED-unset}"'], {
        env,
        timeoutMs: 2000,
      });
      expect(result).toEqual({
        exitCode: 0,
        stdout: expected,
        stderr: "",
        timedOut: false,
        pid: expect.any(Number),
      });
    } finally {
      delete process.env.PROC_ENV_PROBE_ADDED;
    }
  });
});

describe("capture timeoutMs", () => {
  test("absent: the hang bound is the deadline; a normal exit reports timedOut false", () => {
    // Minutes, not seconds - a hang bound must never cut a legitimate
    // operation short - but small enough to fire before the job-level
    // timeout kills the runner.
    expect(DEFAULT_HANG_BOUND_MS).toBe(300_000);
    // A clean exit cannot tell a bound from no bound (the unbounded-pipe
    // hang the module exists for), so the wiring is read off the spawn
    // itself: both piped wrappers must hand the default as `timeout` with
    // the SIGKILL that makes the deadline final.
    const spy = spyOn(Bun, "spawnSync");
    try {
      expect(capture(["true"])).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        pid: expect.any(Number),
      });
      expect(mustCapture(["true"])).toBe("");
      const bounds = spy.mock.calls.map((call) => {
        const options = call[1] as { timeout?: number; killSignal?: string };
        return [call[0], options.timeout, options.killSignal];
      });
      expect(bounds).toEqual([
        [["true"], DEFAULT_HANG_BOUND_MS, "SIGKILL"],
        [["true"], DEFAULT_HANG_BOUND_MS, "SIGKILL"],
      ]);
    } finally {
      spy.mockRestore();
    }
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
  test.each([
    [
      "a child that exited 0 before the deadline still maps to failure (124)",
      { exitCode: 0, signalCode: null },
      124,
    ],
    ["a killed child keeps 128+signal", { exitCode: null, signalCode: "SIGKILL" }, 137],
    ["a failed child keeps its own code", { exitCode: 3, signalCode: null }, 3],
  ])("%s", (_reason, proc, expected) => {
    expect(timeoutExitCode(proc)).toBe(expected);
  });
});

describe("redactCommand", () => {
  test.each([
    [
      "masks URL userinfo, keeping scheme and host",
      ["git", "push", "https://x-access-token:ghp_secret@github.com/o/r.git"],
      "git push https://***@github.com/o/r.git",
    ],
    [
      "masks userinfo whose password itself contains an @",
      ["https://user:p@ss@example.com/x"],
      "https://***@example.com/x",
    ],
    [
      "masks the bare x-access-token shape even without a scheme",
      ["x-access-token:ghp_secret@github.com/o/r.git"],
      "x-access-token:***@github.com/o/r.git",
    ],
    [
      "masks a token that itself contains an @, leaving no fragment of it",
      ["x-access-token:abc@def@github.com/o/r.git"],
      "x-access-token:***@github.com/o/r.git",
    ],
    [
      "an @ in a query or fragment is not userinfo and stays verbatim",
      ["https://example.com?mail=a@b", "https://example.com#sec@ref"],
      "https://example.com?mail=a@b https://example.com#sec@ref",
    ],
    [
      "leaves credential-free argv verbatim",
      ["git", "ls-remote", "https://github.com/o/r.git", "refs/heads/main", "a@b"],
      "git ls-remote https://github.com/o/r.git refs/heads/main a@b",
    ],
  ])("%s", (_reason, argv, expected) => {
    expect(redactCommand(argv)).toBe(expected);
  });
});

describe("redactText", () => {
  // git 401/403 errors quote the push URL back, credentials included:
  // redactCommand covers our argv lines, this covers the child's output.
  test.each([
    [
      "masks the credentialed URL git's own error text quotes back",
      "fatal: unable to access 'https://x-access-token:ghp_SENTINEL@github.com/o/r.git/': The requested URL returned error: 403\n",
      "fatal: unable to access 'https://***@github.com/o/r.git/': The requested URL returned error: 403\n",
    ],
    [
      "masks every credentialed URL in multi-line output",
      "remote: https://user:ghp_SENTINEL@github.com/o/r.git\nhint: x-access-token:ghp_SENTINEL@github.com/o/r.git\n",
      "remote: https://***@github.com/o/r.git\nhint: x-access-token:***@github.com/o/r.git\n",
    ],
    [
      "a URL without credentials survives verbatim",
      "To https://github.com/o/r.git\n ! [rejected] automation/repo-platform (stale info)\n",
      "To https://github.com/o/r.git\n ! [rejected] automation/repo-platform (stale info)\n",
    ],
  ])("%s", (_reason, text, expected) => {
    expect(redactText(text)).toBe(expected);
  });
});

describe("mustCapture timeoutMs", () => {
  const procModule = new URL("../../.github/scripts/shared/proc.ts", import.meta.url).pathname;

  test("a deadline that is not hit returns trimmed stdout", () => {
    // 2000ms for the same cap-headroom reason as the capture twin above.
    expect(mustCapture(["echo", "ok"], { timeoutMs: 2000 })).toBe("ok");
  });

  // The expiry path exits the calling process, so these tests run mustCapture in a child bun.
  //   process.execPath, never a bare "bun"     -> PATH's bun can be a different version than the runner
  //   outer bound and elapsed guards < 5000ms  -> a wedged chain fails with capture's own diagnostics, not an opaque test timeout

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
    // An argv can carry a credentialed push URL, and the expiry line is reachable for every call, so
    // it must never echo the token into the public Actions log.
    //   `sh ... url` as the argv     -> a child whose argv carries the URL and outlives the deadline
    //   exec sleep, fds on /dev/null -> a forked sleeper would hold the outer stderr pipe, which bun >= 1.4.0 waits on to EOF
    // A plain `sh -c "sleep 5"` hung this test for the full 5s on Linux.
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
