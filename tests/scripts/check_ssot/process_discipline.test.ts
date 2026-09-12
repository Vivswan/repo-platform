import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ASYNC_SPAWN_FILES,
  actionTestFileMismatches,
  asyncSpawnMismatches,
  asyncStreamWriteMismatches,
  BUN_TEST_FILE,
  mkdtempSites,
  spawnSyncHazard,
  spawnSyncSites,
  TEMP_DIR_HELPER,
  tempDirSiteMismatches,
  tempDirTreeMismatches,
  topLevelProperties,
} from "../../../scripts/check/ssot/process_discipline.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";

describe("spawnSyncSites", () => {
  test("finds calls with and without options, splitting at the top-level comma", () => {
    const source = [
      'const a = Bun.spawnSync(["git", "st"]);',
      'const b = Bun.spawnSync(["git", "st"], { stdout: "pipe", timeout: 1000 });',
    ].join("\n");
    expect(spawnSyncSites(source, "f")).toEqual([
      { line: 1, kind: "call", options: null },
      { line: 2, kind: "call", options: '{ stdout: "pipe", timeout: 1000 }' },
    ]);
  });

  test("commas inside the command array or string literals never split the args", () => {
    const source = 'Bun.spawnSync(["sh", "-c", "a, b (c"], { timeout: 5 });';
    expect(spawnSyncSites(source, "f")[0]).toEqual({
      line: 1,
      kind: "call",
      options: "{ timeout: 5 }",
    });
  });

  test("comment mentions - line, doc-block, and between callee and paren - are not calls", () => {
    const source = [
      "// a piped Bun.spawnSync(cmd) example in a line comment",
      "/** doc block: Bun.spawnSync(cmd) here too */",
      "const real = Bun.spawnSync /* why not */ (cmd);",
    ].join("\n");
    expect(spawnSyncSites(source, "f")).toEqual([{ line: 3, kind: "call", options: null }]);
  });

  test("a `//` inside a string never hides a same-line call (reviewer's probe)", () => {
    const source = 'const url = "https://x"; Bun.spawnSync(cmd);';
    expect(spawnSyncSites(source, "f")).toEqual([{ line: 1, kind: "call", options: null }]);
  });

  test("an alias binding is a reference site, not a skipped one", () => {
    expect(spawnSyncSites("const s = Bun.spawnSync;\ns(cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites("Bun.spawnSync.call(x, cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });

  test("a pure destructure of Bun is a reference site (reviewer's probe)", () => {
    expect(spawnSyncSites("const { spawnSync } = Bun;\nspawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites("const { spawnSync: s, env } = Bun;", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });

  test("bracket access is a reference site, optional and computed included (reviewer's probes)", () => {
    expect(spawnSyncSites('Bun["spawnSync"](cmd);', "f")).toEqual([{ line: 1, kind: "reference" }]);
    expect(spawnSyncSites('Bun?.["spawnSync"](cmd);', "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites('Bun["spawn" + "Sync"](cmd);', "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });

  test("a string carrying a call- or access-shaped token is not a site (reviewer's probes)", () => {
    expect(spawnSyncSites('const doc = "call Bun.spawnSync(cmd) like this";', "f")).toEqual([]);
    expect(spawnSyncSites("const doc = 'see Bun[\"spawnSync\"] docs';", "f")).toEqual([]);
  });

  test("a comment inside a template interpolation is stripped (reviewer's probe)", () => {
    expect(spawnSyncSites("const x = `${1 /* Bun.spawnSync(cmd) */}`;", "f")).toEqual([]);
  });

  test("a template INTERPOLATION is code, not string content (reviewer's probe)", () => {
    expect(spawnSyncSites("const x = `${Bun.spawnSync(cmd)}`;", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    expect(spawnSyncSites("const x = `Bun.spawnSync(cmd)`;", "f")).toEqual([]);
  });

  test("optional-chained forms are calls (reviewer's probe)", () => {
    expect(spawnSyncSites("Bun?.spawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    expect(spawnSyncSites("Bun.spawnSync?.(cmd, { timeout: 5 });", "f")).toEqual([
      { line: 1, kind: "call", options: "{ timeout: 5 }" },
    ]);
  });

  test("a re-punctuated callee is still a site; a different receiver is not (reviewer's probes)", () => {
    expect(spawnSyncSites("(Bun).spawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    expect(spawnSyncSites("Bun!.spawnSync(cmd, { timeout: 5 });", "f")).toEqual([
      { line: 1, kind: "call", options: "{ timeout: 5 }" },
    ]);
    expect(spawnSyncSites("fakeBun.spawnSync(cmd);", "f")).toEqual([]);
    expect(spawnSyncSites("const a = 1;\nBun.spawnSync(cmd);", "f")).toEqual([
      { line: 2, kind: "call", options: null },
    ]);
  });

  test("the object-form overload carries its own literal as the options", () => {
    const source = 'Bun.spawnSync({ cmd: ["git", "st"], timeout: 5 });';
    expect(spawnSyncSites(source, "f")).toEqual([
      { line: 1, kind: "call", options: '{ cmd: ["git", "st"], timeout: 5 }' },
    ]);
  });

  test("multi-line options come back whole, brackets inside strings ignored", () => {
    const source = [
      "const proc = Bun.spawnSync([`git`, rel], {",
      '  stdin: Buffer.from("x)y"),',
      "  timeout: DEFAULT_HANG_BOUND_MS,",
      "});",
    ].join("\n");
    const [site] = spawnSyncSites(source, "f");
    expect(site.kind === "call" && site.options).toContain("timeout: DEFAULT_HANG_BOUND_MS");
  });

  test("a source the parser must recover throws instead of judging recovered shapes", () => {
    // A truncated call's recovered nodes can read as benign (an intact
    // options object before the missing paren), so the scan refuses the
    // whole file.
    expect(() => spawnSyncSites("Bun.spawnSync([cmd", "f")).toThrow("syntax errors");
    expect(() => spawnSyncSites("Bun.spawnSync(cmd, { timeout: 5 }", "f")).toThrow("syntax errors");
  });

  test("a globalThis-qualified receiver is still Bun; type-dressed destructures still fail closed", () => {
    expect(spawnSyncSites("globalThis.Bun.spawnSync(cmd);", "f")).toEqual([
      { line: 1, kind: "call", options: null },
    ]);
    expect(spawnSyncSites("const { spawnSync: s } = Bun as typeof Bun;\ns(cmd);", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites('const { ["spawnSync"]: s } = Bun;', "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
    expect(spawnSyncSites("const { spawnSync } = globalThis.Bun;", "f")).toEqual([
      { line: 1, kind: "reference" },
    ]);
  });
});

describe("regex and comment decoys stay outside the spawn scan", () => {
  test("a call-shaped token inside a regex body is not code", () => {
    expect(spawnSyncSites("const re = /Bun.spawnSync(cmd)/;", "f")).toEqual([]);
  });

  test("division never desyncs the scan into misreading later code", () => {
    const source = "const half = total / 2; // tail\nBun.spawnSync(cmd);";
    expect(spawnSyncSites(source, "f")).toEqual([{ line: 2, kind: "call", options: null }]);
  });
});

describe("topLevelProperties", () => {
  test("reads top-level keys with raw values, shorthand included", () => {
    const props = topLevelProperties('{ stdout: "pipe", timeout, env: { a: 1 } }');
    expect(props?.get("stdout")).toBe('"pipe"');
    expect(props?.get("timeout")).toBe("timeout");
    expect(props?.get("env")).toBe("{ a: 1 }");
    expect(props?.has("a")).toBe(false);
  });

  test("non-literal shapes are unauditable: variables, spreads, computed keys", () => {
    expect(topLevelProperties("opts")).toBeNull();
    expect(topLevelProperties("{ ...base }")).toBeNull();
    expect(topLevelProperties("{ [key]: 1 }")).toBeNull();
    expect(topLevelProperties("makeOptions()")).toBeNull();
  });

  test("commas inside nested values never split a property", () => {
    const props = topLevelProperties('{ stdio: ["inherit", log, log], timeout: f(1, 2) }');
    expect(props?.get("stdio")).toBe('["inherit", log, log]');
    expect(props?.get("timeout")).toBe("f(1, 2)");
  });
});

describe("spawnSyncHazard", () => {
  test("near miss: a bare piped call - no options at all - is the measured hazard", () => {
    expect(spawnSyncHazard(null)).toContain("pipe by default");
  });

  test("explicit pipes without a timeout are hazards", () => {
    expect(spawnSyncHazard('{ stdout: "pipe", stderr: "pipe" }')).toContain("explicitly piped");
    expect(spawnSyncHazard('{ stdio: ["ignore", "pipe", "inherit"] }')).toContain(
      "explicitly piped",
    );
  });

  test("a partially shaped call leaves the other stream on the piped default", () => {
    expect(spawnSyncHazard('{ stdout: "inherit" }')).toContain("stderr");
    expect(spawnSyncHazard('{ stderr: "inherit" }')).toContain("stdout");
  });

  test("options the scanner cannot audit fail closed", () => {
    expect(spawnSyncHazard("opts")).toContain("cannot audit");
    expect(spawnSyncHazard("{ ...base }")).toContain("cannot audit");
    expect(spawnSyncHazard("makeOptions()")).toContain("cannot audit");
  });

  test("a nested timeout never reads as a bound (reviewer's probe)", () => {
    expect(spawnSyncHazard('{ env: { timeout: "5" } }')).toContain("piped default");
  });

  test("timeout: undefined, null, or 0 is no bound (measured on 1.4.0; reviewer's probe)", () => {
    expect(spawnSyncHazard("{ timeout: undefined }")).not.toBeNull();
    expect(spawnSyncHazard("{ timeout: null }")).not.toBeNull();
    expect(spawnSyncHazard('{ stdout: "pipe", timeout: 0 }')).toContain("not a provable bound");
  });

  test("every numeric spelling of zero is no bound (reviewer's probe)", () => {
    for (const zero of ["0.0", "0x0", "-0", "0e0", "+0"]) {
      expect(spawnSyncHazard(`{ timeout: ${zero} }`)).toContain("not a provable bound");
    }
    // `0_0` is not a legal numeric literal (a separator after a leading
    // zero); the parser refuses it, so it fails closed as unauditable.
    expect(spawnSyncHazard("{ timeout: 0_0 }")).toContain("cannot audit");
    expect(spawnSyncHazard("{ timeout: 100 }")).toBeNull();
  });

  test("a numeric-separator literal is a provable bound (10_000 folds to 10000, not NaN)", () => {
    expect(spawnSyncHazard('{ stdout: "pipe", timeout: 10_000 }')).toBeNull();
    expect(spawnSyncHazard("{ timeout: 1_000_000 }")).toBeNull();
  });

  test("an expression timeout is unprovable and fails closed (reviewer's probe)", () => {
    expect(spawnSyncHazard("{ timeout: 1 - 1 }")).toContain("not a provable bound");
    expect(spawnSyncHazard("{ timeout: Infinity }")).not.toBeNull();
    // Named constants and member paths stay trusted - the stated residual.
    expect(spawnSyncHazard("{ timeout: DEFAULT_HANG_BOUND_MS }")).toBeNull();
    expect(spawnSyncHazard("{ timeout: options.timeoutMs }")).toBeNull();
  });

  test("a stream shaped to undefined falls back to the piped default (reviewer's probe)", () => {
    expect(spawnSyncHazard('{ stdout: undefined, stderr: "inherit" }')).toContain("stdout");
    expect(spawnSyncHazard("{ stdio: undefined }")).toContain("stdout and stderr");
  });

  test('null is "ignore" in bun-types (measured on 1.4.0: no buffer comes back), so it shapes the stream', () => {
    expect(spawnSyncHazard('{ stdout: null, stderr: "inherit" }')).toBeNull();
    expect(spawnSyncHazard('{ stdio: ["ignore", null, "inherit"] }')).toBeNull();
    expect(spawnSyncHazard('{ stdio: ["ignore", null, undefined] }')).toBe(
      "stderr left to the piped default with no timeout",
    );
  });

  test("a non-array stdio value is refused by name: bun-types declares stdio as a tuple, so only a literal shows the slots", () => {
    for (const stdio of ["makeStreams()", "7", "STDIO", '"inherit"', "null"]) {
      expect(spawnSyncHazard(`{ stdio: ${stdio} }`)).toBe(
        "a stdio value the scanner cannot audit (not an array literal, so its stream slots cannot be read) with no timeout",
      );
    }
    expect(spawnSyncHazard("{ stdio: makeStreams(), timeout: 5_000 }")).toBeNull();
  });

  test("an explicit timeout bounds any piped shape, object-form included", () => {
    expect(spawnSyncHazard('{ stdout: "pipe", stderr: "pipe", timeout: 1000 }')).toBeNull();
    expect(spawnSyncHazard("{ timeout: DEFAULT_HANG_BOUND_MS }")).toBeNull();
    expect(spawnSyncHazard('{ cmd: ["git", "st"], timeout: 5 }')).toBeNull();
  });

  test("fully shaped unpiped stdio needs no bound - there is no pipe EOF to wait on", () => {
    expect(spawnSyncHazard('{ stdio: ["inherit", "inherit", "inherit"] }')).toBeNull();
    expect(spawnSyncHazard('{ stdio: ["inherit", log, log] }')).toBeNull();
    expect(spawnSyncHazard('{ stdout: "ignore", stderr: "inherit" }')).toBeNull();
  });

  test("stdio array slots are read individually (reviewer's probe)", () => {
    expect(spawnSyncHazard("{ stdio: [undefined, undefined, undefined] }")).toContain(
      "stdout and stderr",
    );
    expect(spawnSyncHazard('{ stdio: ["inherit"] }')).toContain("stdout and stderr");
    expect(spawnSyncHazard('{ stdio: ["ignore", , "inherit"] }')).toContain("stdout");
  });

  test("the stdio tuple overrides the stdout/stderr keys, as bun-types says and bun 1.4.0 does", () => {
    expect(spawnSyncHazard('{ stdio: ["inherit"], stdout: log, stderr: log }')).toBe(
      "stdout and stderr left to the piped default with no timeout",
    );
    expect(
      spawnSyncHazard(
        '{ stdio: ["ignore", undefined, undefined], stdout: "ignore", stderr: "ignore" }',
      ),
    ).toBe("stdout and stderr left to the piped default with no timeout");
    expect(
      spawnSyncHazard('{ stdio: ["ignore", "inherit", "inherit"], stdout: "pipe" }'),
    ).toBeNull();
  });

  test("a stream value is judged as what it evaluates to, never by its text", () => {
    for (const wrapped of ["(undefined)", "void 0", "(void 0) as never"]) {
      expect(spawnSyncHazard(`{ stdout: ${wrapped}, stderr: "ignore" }`)).toBe(
        "stdout left to the piped default with no timeout",
      );
    }
    expect(spawnSyncHazard('{ stdout: "p\\x69pe", stderr: "ignore" }')).toBe(
      "explicitly piped stdio with no timeout",
    );
    expect(spawnSyncHazard("{ stdout: `pipe`, stderr: 2 }")).toBe(
      "explicitly piped stdio with no timeout",
    );
    expect(spawnSyncHazard("{ stdout: 1, stderr: 2 }")).toBeNull();
    expect(spawnSyncHazard('{ stdout: options.log, stderr: "inherit" }')).toBeNull();
  });

  test("a call, an operator expression, or a string bun-types does not list is refused, not trusted", () => {
    for (const value of ["makeStream()", "a || b", '"socket-fd"', "Bun.file(path)"]) {
      expect(spawnSyncHazard(`{ stdout: ${value}, stderr: "inherit" }`)).toBe(
        "stdout shaped by a value the scanner cannot audit (a call, an optional chain, or an expression) with no timeout",
      );
    }
    expect(spawnSyncHazard("{ stdout: makeStream(), stderr: makeStream() }")).toBe(
      "stdout and stderr shaped by a value the scanner cannot audit (a call, an optional chain, or an expression) with no timeout",
    );
    expect(spawnSyncHazard("{ stdout: makeStream(), timeout: 5_000 }")).toBeNull();
  });

  test("an optional chain is refused, not trusted: `options?.log` with options undefined is the piped default", () => {
    // A `?.` anywhere in the chain, or an element step (an absent element is undefined too): both refused.
    for (const value of ["options?.log", "a.b?.c", "a?.b.c", "(a?.b)", "a?.[k]", "a[k]"]) {
      expect(spawnSyncHazard(`{ stdout: ${value}, stderr: "inherit" }`)).toBe(
        "stdout shaped by a value the scanner cannot audit (a call, an optional chain, or an expression) with no timeout",
      );
    }
    // The recorded trust: a plain member path is judged by its key, and a timeout clears the hazard whatever the value.
    expect(spawnSyncHazard('{ stdout: options.log, stderr: "inherit" }')).toBeNull();
    expect(spawnSyncHazard("{ stdout: options?.log, timeout: 5_000 }")).toBeNull();
  });

  test("a slot past stderr is judged too: spawnSync never drains it, so a pipe there wedges on a full buffer", () => {
    expect(spawnSyncHazard('{ stdio: ["ignore", "ignore", "ignore", "pipe"] }')).toBe(
      "explicitly piped stdio with no timeout",
    );
    expect(spawnSyncHazard('{ stdio: ["ignore", "ignore", "ignore", makeFd()] }')).toBe(
      "stdio[3] shaped by a value the scanner cannot audit (a call, an optional chain, or an expression) with no timeout",
    );
    // An undefined or null extra slot is a closed fd (measured: a writer to it fails with EBADF at once).
    for (const closed of ["undefined", "null", "3"]) {
      expect(spawnSyncHazard(`{ stdio: ["ignore", "ignore", "ignore", ${closed}] }`)).toBeNull();
    }
    expect(spawnSyncHazard('{ stdio: ["ignore", , "ignore", undefined] }')).toBe(
      "stdout left to the piped default with no timeout",
    );
  });

  test("a spread inside a stdio array is unauditable - it can shift or inject stream slots", () => {
    expect(spawnSyncHazard('{ stdio: ["ignore", ...streams, "inherit"] }')).toBe(
      "a stdio value the scanner cannot audit (a spread can shift or inject stream slots) with no timeout",
    );
    expect(spawnSyncHazard('{ stdio: (["ignore", ...streams]) }')).toContain("cannot audit");
    expect(spawnSyncHazard('{ stdio: (["inherit"]) }')).toContain("stdout and stderr");
    expect(spawnSyncHazard('{ stdio: ["ignore", ...streams], timeout: 5_000 }')).toBeNull();
  });

  test("a timeoutMs-style key is not the timeout property - the call reads as wholly unbounded", () => {
    expect(spawnSyncHazard("{ timeoutMs: 5 }")).toBe(
      "stdout and stderr left to the piped default with no timeout",
    );
  });
});

describe("spawnSyncHazard agrees with bun about which literal shapes pipe", () => {
  // Every claim the rule makes about stream defaults, null, fd numbers, and tuple precedence is checked against the
  // pinned bun itself: each shape is spawned in a child bun (a direct Bun.spawnSync here would be a site this rule judges),
  // which reports the output streams that came back as buffers. `piped` is the measured value the rule must agree with.
  const cases: { shape: string; piped: ("stdout" | "stderr")[] }[] = [
    { shape: "{}", piped: ["stdout", "stderr"] },
    { shape: "{ stdio: undefined }", piped: ["stdout", "stderr"] },
    { shape: '{ stdout: "inherit" }', piped: ["stderr"] },
    { shape: '{ stdout: null, stderr: "inherit" }', piped: [] },
    { shape: '{ stdio: ["ignore", null, "inherit"] }', piped: [] },
    { shape: '{ stdio: ["ignore", null, undefined] }', piped: ["stderr"] },
    { shape: '{ stdio: ["ignore", , "inherit"] }', piped: ["stdout"] },
    { shape: '{ stdio: ["inherit"] }', piped: ["stdout", "stderr"] },
    { shape: '{ stdio: ["inherit", "inherit", "inherit"] }', piped: [] },
    {
      shape: '{ stdio: ["inherit"], stdout: "ignore", stderr: "ignore" }',
      piped: ["stdout", "stderr"],
    },
    { shape: '{ stdio: ["ignore", "inherit", "inherit"], stdout: "pipe" }', piped: [] },
    { shape: '{ stdout: (undefined), stderr: "ignore" }', piped: ["stdout"] },
    { shape: '{ stdout: void 0, stderr: "ignore" }', piped: ["stdout"] },
    { shape: '{ stdout: "p\\x69pe", stderr: "ignore" }', piped: ["stdout"] },
    { shape: '{ stdout: "pipe", stderr: "pipe" }', piped: ["stdout", "stderr"] },
    { shape: "{ stdout: 1, stderr: 2 }", piped: [] },
  ];
  test.each(cases)("$shape pipes $piped", ({ shape, piped }) => {
    const probe =
      'const r = Bun.spawnSync(["sh", "-c", "printf out; printf err >&2"], ' +
      `${shape}); console.log("\\nRESULT " + JSON.stringify(["stdout", "stderr"].filter((s) => r[s] instanceof Uint8Array)));`;
    const child = boundedSpawnSync([process.execPath, "-e", probe]);
    expect(child.exitCode).toBe(0);
    const result = child.stdout.split("\n").findLast((line) => line.startsWith("RESULT "));
    expect(result).toBeDefined();
    expect(JSON.parse(result?.slice("RESULT ".length) ?? "")).toEqual(piped);
    const hazard = spawnSyncHazard(shape);
    if (piped.length === 0) {
      expect(hazard).toBeNull();
    } else if (/"pipe"|`pipe`|p\\x69pe/.test(shape)) {
      expect(hazard).toBe("explicitly piped stdio with no timeout");
    } else {
      expect(hazard).toBe(`${piped.join(" and ")} left to the piped default with no timeout`);
    }
  });
});

describe("spawnSyncHazard agrees with bun about a slot past stderr", () => {
  // No buffer comes back for fd 3, so the oracle is the hang itself: a 1 MiB writer into the slot, under a deadline the
  // child adds only to bound the measurement. The rule judges the shape without that deadline.
  const cases: { slot: string; hangs: boolean }[] = [
    { slot: '"pipe"', hangs: true },
    { slot: '"ignore"', hangs: false },
    { slot: "undefined", hangs: false },
  ];
  test.each(cases)("stdio[3] = $slot hangs: $hangs", ({ slot, hangs }) => {
    const shape = `{ stdio: ["ignore", "ignore", "ignore", ${slot}] }`;
    const probe =
      'const r = Bun.spawnSync(["sh", "-c", "exec head -c 1048576 /dev/zero >&3 2>/dev/null"], ' +
      `{ ...${shape}, timeout: 500, killSignal: "SIGKILL" }); console.log("RESULT " + JSON.stringify(r.exitedDueToTimeout === true));`;
    const child = boundedSpawnSync([process.execPath, "-e", probe]);
    expect(child.exitCode).toBe(0);
    const result = child.stdout.split("\n").findLast((line) => line.startsWith("RESULT "));
    expect(JSON.parse(result?.slice("RESULT ".length) ?? "")).toBe(hangs);
    expect(spawnSyncHazard(shape)).toBe(hangs ? "explicitly piped stdio with no timeout" : null);
  });
});

describe("asyncSpawnMismatches", () => {
  test("the enumeration pins the exact landed set, by name", () => {
    expect(Object.keys(ASYNC_SPAWN_FILES).sort()).toEqual([
      "actions/release-health/release-health.ts",
      "scripts/run_tests.ts",
      "tests/actions/pages-site/mermaid_labels.test.ts",
      "tests/build-branches/publish_behavior.test.ts",
    ]);
  });

  test("an unenumerated async Bun.spawn fires per site, naming the file and the true reason for the pin", () => {
    const found = asyncSpawnMismatches("scripts/x.ts", 'const p = Bun.spawn(["gh"]);\n', false);
    expect(found).toEqual([
      {
        file: "scripts/x.ts:1",
        // Bun.spawn honors `timeout` (bun-types declares it on the shared options; measured: SIGTERM at ~52 ms with timeout: 50),
        // so the message must not claim the option is missing.
        expected:
          "no async Bun.spawn outside ASYNC_SPAWN_FILES (an async site draining its pipes has no pipe-EOF " +
          "deadlock for a timeout to bound, so its bound is a recorded rationale rather than a checked option; " +
          "a sync site rewritten async exits the sync gate and must land here, by name)",
        got: "an unenumerated async Bun.spawn",
      },
    ]);
  });

  test("LAUNDERING: a test file's spawnSync rewritten as async Bun.spawn fails by introducing a fourth name", () => {
    // The sync->async rewrite EXITS the sync gate silently (no sync
    // site remains to report); the exact-set pin is what makes it fail -
    // the file's name is not in the enumeration, and nothing but a
    // reviewed entry can satisfy that.
    const rewritten = 'const proc = Bun.spawn(["bun", entry], { stdout: "pipe" });\n';
    const found = asyncSpawnMismatches("tests/shared/flags.test.ts", rewritten, false);
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe("tests/shared/flags.test.ts:1");
  });

  test("an enumerated file with a site passes; one with none left is a stale entry", () => {
    expect(asyncSpawnMismatches("actions/x/x.ts", "Bun.spawn(cmd);\n", true)).toEqual([]);
    const stale = asyncSpawnMismatches("actions/x/x.ts", 'console.log("gone");\n', true);
    expect(stale).toHaveLength(1);
    expect(stale[0].got).toContain("stale");
  });

  test("spawnSync, comments, and string mentions are not async sites", () => {
    const source = [
      'Bun.spawnSync(["git"], { timeout: 5 });',
      "// a Bun.spawn(cmd) mention in a comment",
      'const doc = "Bun.spawn(cmd)";',
    ].join("\n");
    expect(asyncSpawnMismatches("scripts/x.ts", source, false)).toEqual([]);
    expect(asyncSpawnMismatches("scripts/x.ts", "Bun?.spawn(cmd);\n", false)).toHaveLength(1);
    expect(asyncSpawnMismatches("scripts/x.ts", "const s = Bun.spawn;\n", false)).toHaveLength(1);
  });

  test("a re-punctuated callee is still an async site; a different receiver is not", () => {
    expect(asyncSpawnMismatches("scripts/x.ts", "(Bun).spawn(cmd);\n", false)).toHaveLength(1);
    expect(asyncSpawnMismatches("scripts/x.ts", "Bun!.spawn(cmd);\n", false)).toHaveLength(1);
    expect(asyncSpawnMismatches("scripts/x.ts", "fakeBun.spawn(cmd);\n", false)).toEqual([]);
  });
});

describe("mkdtempSites and tempDirSiteMismatches (temp-dirs-through-helper)", () => {
  test.each([
    { shape: "named import", source: 'import { mkdtempSync } from "node:fs";\n' },
    { shape: "aliased import", source: 'import { mkdtempSync as mk } from "node:fs";\n' },
    { shape: "promises import", source: 'import { mkdtemp } from "node:fs/promises";\n' },
    { shape: "namespace member", source: 'import * as fs from "node:fs";\nfs.mkdtempSync(p);\n' },
    { shape: "promises member", source: "const d = await fs.promises.mkdtemp(p);\n" },
    { shape: "require destructure", source: 'const { mkdtempSync } = require("node:fs");\n' },
    { shape: "bare reference", source: "const make = mkdtempSync;\n" },
  ])("a $shape is a site, reported by line", ({ source }) => {
    const found = tempDirSiteMismatches("tests/x/y.test.ts", source);
    expect(found.map((m) => m.file)).toEqual([
      `tests/x/y.test.ts:${source.trim().split("\n").length}`,
    ]);
    expect(found[0].expected).toContain(TEMP_DIR_HELPER);
  });

  test("every identifier is a site, import and calls alike, two on one line included", () => {
    const source = [
      'import { mkdtempSync } from "node:fs";',
      'const a = mkdtempSync(join(tmpdir(), "a-")), b = mkdtempSync(join(tmpdir(), "b-"));',
      "",
      'const c = mkdtempSync(join(tmpdir(), "c-"));',
    ].join("\n");
    expect(mkdtempSites(source)).toEqual([1, 2, 2, 4]);
  });

  test("comments, strings, and template bodies are not sites (the launcher test's probe source)", () => {
    const source = [
      "// a mkdtempSync(join(tmpdir(), x)) mention in a comment",
      "const probe = 'const fixture = mkdtempSync(join(tmpdir(), \"probe-\"));';",
      "const line = `${probe} and mkdtemp too`;",
      'import { tempDirs } from "../shared/temp_dir";',
      "const temp = tempDirs();",
      'const root = temp.dir("stamp-manifest-");',
    ].join("\n");
    expect(mkdtempSites(source)).toEqual([]);
    expect(tempDirSiteMismatches("tests/x/y.test.ts", source)).toEqual([]);
  });

  test("the helper itself must call mkdtemp, or the scan has lost its anchor", () => {
    const helper = "const dir = mkdtempSync(join(tmpdir(), prefix));\n";
    expect(tempDirSiteMismatches(TEMP_DIR_HELPER, helper)).toEqual([]);
    expect(() => tempDirSiteMismatches(TEMP_DIR_HELPER, "export const x = 1;\n")).toThrow(
      /anchor lost/,
    );
  });

  test("selection and judgment together: symlinks fail closed, actions/ is not selected", () => {
    const helperSource = "const dir = mkdtempSync(join(tmpdir(), prefix));\n";
    const bare = 'import { mkdtempSync } from "node:fs";\n';
    const sources: Record<string, string> = {
      [TEMP_DIR_HELPER]: helperSource,
      "tests/sync/clean.test.ts": 'import { tempDirs } from "../shared/temp_dir";\n',
      "tests/shared/support.ts": bare,
      // actions/ belongs to the no-tests-under-actions rule, test-named or not.
      "actions/x/x.test.ts": bare,
      "actions/x/x.ts": bare,
      "tests/fixtures/a/README.md": "mkdtempSync in prose\n",
    };
    const read = (rel: string) => {
      if (rel === "tests/shared/leaky.ts") throw new Error("a symlink's target must not be read");
      return sources[rel];
    };
    const files = [
      ...Object.keys(sources).map((path) => ({ path, symlink: false })),
      // Non-test-named, so a selection keyed on the test pattern alone
      // would let it through unread.
      { path: "tests/shared/leaky.ts", symlink: true },
      { path: "tests/fixtures/a/CLAUDE.md", symlink: true },
    ];
    const found = tempDirTreeMismatches(files, read);
    expect(found.map((m) => [m.file, m.got])).toEqual([
      [
        "tests/shared/support.ts:1",
        "a bare mkdtemp, which nothing removes when the test fails, throws, or forgets",
      ],
      ["tests/shared/leaky.ts", "a symlink"],
    ]);
  });

  test("actionTestFileMismatches: a clean actions/ tree passes, every planted test spelling reds by name", () => {
    const clean = [
      { path: "actions/x/x.ts" },
      { path: "actions/x/lib/helper.ts" },
      { path: "actions/x/test.ts" },
      { path: "actions/shared/manifest.ts" },
    ];
    expect(actionTestFileMismatches(clean)).toEqual([]);
    const planted = [
      ...clean,
      { path: "actions/x/x.test.ts" },
      { path: "actions/x/lib/x_spec.mts" },
    ];
    expect(actionTestFileMismatches(planted)).toEqual([
      {
        file: "actions/x/x.test.ts",
        expected:
          "no test file under actions/ (tests live under tests/actions/<action>/, mirroring the action's tree)",
        got: "a bun-discoverable test file beside an action's sources",
      },
      {
        file: "actions/x/lib/x_spec.mts",
        expected:
          "no test file under actions/ (tests live under tests/actions/<action>/, mirroring the action's tree)",
        got: "a bun-discoverable test file beside an action's sources",
      },
    ]);
  });

  test("a missing or symlinked helper is a lost anchor, not a clean pass", () => {
    const files = [{ path: "tests/sync/clean.test.ts", symlink: false }];
    expect(() => tempDirTreeMismatches(files, () => "")).toThrow(/anchor lost/);
    const linked = [...files, { path: TEMP_DIR_HELPER, symlink: true }];
    expect(() => tempDirTreeMismatches(linked, () => "")).toThrow(/anchor lost/);
  });

  test("BUN_TEST_FILE matches what bun test discovers, and only that", () => {
    // .mjs and .cts measured as discovered on bun 1.4.0.
    const discovered = ["a.test.ts", "a_test.ts", "a.spec.tsx", "a_spec.mjs", "dir/b.test.cts"];
    const skipped = ["a.ts", "test.ts", "atest.ts", "a.test.md", "a.tests.ts", "spec/a.ts"];
    expect(discovered.filter((f) => BUN_TEST_FILE.test(f))).toEqual(discovered);
    expect(skipped.filter((f) => BUN_TEST_FILE.test(f))).toEqual([]);
  });

  test("the landed helper is the one file on the roster path", () => {
    expect(TEMP_DIR_HELPER).toBe("tests/shared/temp_dir.ts");
    // The import specifier and the one call, nothing else: a second
    // call would mean a fixture path the afterAll might not own.
    expect(mkdtempSites(readFileSync(TEMP_DIR_HELPER, "utf-8"))).toHaveLength(2);
  });
});

describe("asyncStreamWriteMismatches", () => {
  test("an unlisted file with an async stream write is flagged at its line", () => {
    const source = 'console.log("hi");\nprocess.stdout.write(out);\n';
    const found = asyncStreamWriteMismatches("x/y.ts", source, false);
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe("x/y.ts:2");
    expect(found[0].expected).toContain("writeSync");
    expect(
      asyncStreamWriteMismatches("x/y.ts", "process.stderr.write(err);\n", false),
    ).toHaveLength(1);
  });

  test("mentions in comments, strings, and regex bodies never fire", () => {
    const source = [
      "// process.stdout.write(x) stays banned",
      "/* process.stderr.write(y) */",
      'const s = "process.stdout.write(z)";',
      "const r = /process\\.stdout\\.write\\(/;",
    ].join("\n");
    expect(asyncStreamWriteMismatches("x/y.ts", source, false)).toEqual([]);
  });

  test.each([
    { source: "process?.stdout.write(out);", reason: "an optional receiver" },
    { source: "process.stderr?.write(err);", reason: "an optional stream" },
    { source: "process.stdout.write?.(out);", reason: "an optional call" },
    { source: "process?.stdout.write?.(out);", reason: "optional receiver and call together" },
    { source: "process . stdout . write (out);", reason: "spaced member access" },
    { source: "globalThis.process.stdout.write(out);", reason: "a globalThis receiver" },
    {
      source: "const t = `${process.stdout.write(chunk)}`;",
      reason: "a template interpolation (code, not string content)",
    },
  ])("$reason still fires at its line: $source", ({ source }) => {
    expect(asyncStreamWriteMismatches("x/y.ts", `${source}\n`, false)).toEqual([
      {
        file: "x/y.ts:1",
        expected:
          "writeSync for stream writes (bun's async stream writes truncate at the pipe buffer when any later path exits), or a NATURAL_EXIT_WRITE_FILES entry whose reason holds",
        got: "an async stream write",
      },
    ]);
  });

  test("a source the parser must recover throws instead of judging recovered shapes", () => {
    expect(() =>
      asyncStreamWriteMismatches("x/y.ts", "process.stdout.write(out;\n", false),
    ).toThrow("syntax errors");
  });

  test("an allowlisted file whose writes ride to a natural exit passes", () => {
    const source = 'fail("early");\nprocess.stdout.write(out);\nconsole.log("bye");\n';
    expect(asyncStreamWriteMismatches("x/y.ts", source, true)).toEqual([]);
  });

  test("an allowlisted file with an exit-capable call after the first write is flagged", () => {
    for (const late of [
      "process.exit(1);",
      "process?.exit(1);",
      "process . exit(1);",
      "globalThis.process.exit(1);",
      'fail("boom");',
      'gha.fail("boom");',
      "must(cmd);",
      "mustCapture(cmd);",
      'throw new Error("boom");',
      'function later() {\n  throw new Error("boom");\n}',
    ]) {
      const found = asyncStreamWriteMismatches(
        "x/y.ts",
        `process.stdout.write(out);\n${late}\n`,
        true,
      );
      expect(found).toHaveLength(1);
      expect(found[0].got).toContain("exit-capable");
    }
  });

  test("an allowlisted file with no async write left is a stale entry", () => {
    const found = asyncStreamWriteMismatches("x/y.ts", 'console.log("ok");\n', true);
    expect(found).toHaveLength(1);
    expect(found[0].got).toContain("stale");
  });
});
