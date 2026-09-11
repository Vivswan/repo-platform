import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notAdoptedNotice, pushProbeSkipNotice } from "../../.github/scripts/fleet/discovery.ts";
import { declaredModules } from "../../actions/plan/registration.ts";
import { MODULE_ORDER } from "../../scripts/lib/module_manifests.ts";
import { tempDirs } from "../shared/temp_dir";

const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";

const temp = tempDirs();

// End-to-end harness for the selector against stub `gh`, `curl`, and no-op
// `sleep` binaries on PATH (the retry loop costs no wall time). The stub
// fleet covers every selection axis: adoption (a readable modules list is
// the opt-in, folded settings-sync name or not), dead and flaky probes the
// retries must heal, revoked push access (a public repo prints one notice
// per selecting plan; a private one vanishes from GET /user/repos, so the
// stubs admit hidden-gone only in a control run), and PRIVATE personas
// whose every public surface carries the hint, never the slug. For the
// modules filters, hidden-server declares [uv, pages].
describe("declaredModules", () => {
  test("answers the list for a readable declaration, in the sync's grammar", () => {
    expect(declaredModules("modules:\n  - settings-sync\n")).toEqual(["settings-sync"]);
    expect(declaredModules("modules: [uv]\n")).toEqual(["uv"]);
    expect(declaredModules("modules: []\n")).toEqual([]);
  });

  test("answers null for an unreadable list, never guessing", () => {
    expect(declaredModules("notmodules: true\n")).toBeNull();
    expect(declaredModules("modules: notalist\n")).toBeNull();
    expect(declaredModules("modules: [uv, uv]\n")).toBeNull();
    expect(declaredModules(": broken\n")).toBeNull();
    expect(declaredModules("modules: [&loop [*loop]]\n")).toBeNull();
  });
});

describe("select_settings_repos.ts", () => {
  const repoRoot = join(import.meta.dir, "..", "..");
  const script = join(import.meta.dir, "../../.github/scripts/fleet/select_settings_repos.ts");
  const root = temp.dir("select-settings-");
  const bin = join(root, "bin");
  const fixture = join(root, "fixture");

  beforeAll(() => {
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'if [ "$2" = "user/repos" ]; then',
        '  if [ -n "$STUB_FAIL_DISCOVERY" ]; then',
        '    echo "HTTP 500 from stub" >&2',
        "    exit 1",
        "  fi",
        // Every persona, three of them private: the listing is the fleet.
        // hidden-gone joins the listing only under STUB_DISCOVER_GONE: the
        // control proving its absence elsewhere is discovery's doing.
        '  gone=""',
        `  if [ -n "$STUB_DISCOVER_GONE" ]; then gone=',{"full_name":"Vivswan/hidden-gone","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}}'; fi`,
        `  printf '%s%s]]\\n' '[[{"full_name":"Vivswan/deadapi","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/deadprobe","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/flaky","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/nomodule","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/steady","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/unadopted","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/locked","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/hidden-locked","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/open-lib","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/hidden-server","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/hidden-nomods","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/hidden-deadapi","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}}' "$gone"`,
        "  exit 0",
        "fi",
        'case "$2" in',
        "  repos/Vivswan/flaky/contents/.repo-platform.yml)",
        '    if [ -e "$STUB_STATE/flaky-opt-in" ]; then echo "modules: [settings-sync]"; exit 0; fi',
        '    touch "$STUB_STATE/flaky-opt-in"',
        '    echo "HTTP 502 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/deadapi/contents/.repo-platform.yml)",
        '    echo "HTTP 502 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/nomodule/contents/.repo-platform.yml)",
        '    echo "modules: [uv, release-please]"',
        "    ;;",
        "  repos/Vivswan/unadopted/contents/.repo-platform.yml)",
        '    echo "HTTP 404 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/hidden-nomods/contents/.repo-platform.yml)",
        '    echo "notmodules: true"',
        "    ;;",
        "  repos/Vivswan/hidden-server/contents/.repo-platform.yml)",
        '    echo "modules: [uv, pages]"',
        "    ;;",
        // Error text with the slug in a URL, the bare name, and a case
        // variant: every retry line and the final warning must scrub all
        // three to the hint.
        "  repos/Vivswan/hidden-deadapi/contents/.repo-platform.yml)",
        '    echo "HTTP 502: https://api.github.com/repos/Vivswan/hidden-deadapi bad gateway; HIDDEN-DEADAPI unreachable" >&2',
        "    exit 1",
        "    ;;",
        "  repos/*/contents/.repo-platform.yml)",
        '    echo "modules: [settings-sync]"',
        "    ;;",
        "  *)",
        '    echo "HTTP 404 from stub" >&2',
        "    exit 1",
        "    ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "curl"),
      [
        "#!/usr/bin/env bash",
        "# The probed URL is curl's last argument.",
        'while [ "$#" -gt 1 ]; do shift; done',
        'url="$1"',
        'case "$url" in',
        '  *"/Vivswan/deadprobe.git/"*) printf 500 ;;',
        '  *"/Vivswan/locked.git/"*|*"/Vivswan/hidden-locked.git/"*) printf 403 ;;',
        '  *"/Vivswan/flaky.git/"*)',
        '    if [ -e "$STUB_STATE/flaky-push" ]; then',
        "      printf 200",
        "    else",
        '      touch "$STUB_STATE/flaky-push"',
        "      printf 500",
        "    fi",
        "    ;;",
        "  *) printf 200 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    // The fixture root stands in for the checked-out repo: the script
    // spawns the matrix builder by its .github/scripts path relative to
    // its cwd, so only .github is borrowed from the real repo.
    mkdirSync(fixture, { recursive: true });
    symlinkSync(join(repoRoot, ".github"), join(fixture, ".github"));
  });

  interface Run {
    exitCode: number;
    stdout: string;
    stderr: string;
    output: string;
    summary: string;
  }

  // run() spawns bun which spawns more bun children, so one healthy run
  // costs seconds, and a cold start (this file alone in a fresh worktree)
  // reliably pushed the beforeAll past bun-test's default 5s hook cap.
  // SPAWN_TIMEOUT_MS turns a wedged child into a diagnostic throw instead
  // of exitCode null with partial output, and TEST_TIMEOUT_MS sits above
  // it on every spawning test/hook so that throw always beats bun's
  // value-free kill.
  const SPAWN_TIMEOUT_MS = 15_000;
  const TEST_TIMEOUT_MS = 20_000;

  function run(name: string, options: { cwd?: string; env?: Record<string, string> } = {}): Run {
    const work = join(root, `work-${name}`);
    mkdirSync(join(work, "state"), { recursive: true });
    mkdirSync(join(work, "temp"));
    const outputFile = join(work, "output.txt");
    const summaryFile = join(work, "summary.md");
    writeFileSync(outputFile, "");
    writeFileSync(summaryFile, "");
    const proc = Bun.spawnSync(["bun", script], {
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      cwd: options.cwd ?? fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAT: "stub-token",
        PROBE_RETRY_DELAY_MS: "0",
        GH_TOKEN: "stub-token",
        GITHUB_RUN_ID: "8675309",
        GITHUB_REPOSITORY: "Vivswan/repo-platform",
        OWNER: "Vivswan",
        RUNNER_TEMP: join(work, "temp"),
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        STUB_STATE: join(work, "state"),
        // The spread above carries CI's real event file; the dispatch
        // tests supply their own.
        GITHUB_EVENT_PATH: "",
        ...options.env,
      },
    });
    // Any null exit (timeout or another signal) is "failed to look",
    // never a result: exit-code assertions would read null as nonzero.
    if (proc.exitCode === null) {
      const cause =
        proc.exitedDueToTimeout === true
          ? `exceeded the ${SPAWN_TIMEOUT_MS}ms harness bound`
          : `died on signal ${proc.signalCode}`;
      throw new Error(
        `select_settings_repos.ts (run "${name}") ${cause}\n` +
          `${proc.stdout.toString()}${proc.stderr.toString()}`,
      );
    }
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      output: readFileSync(outputFile, "utf-8"),
      summary: readFileSync(summaryFile, "utf-8"),
    };
  }

  let main: Run;
  beforeAll(() => {
    main = run("main");
  }, TEST_TIMEOUT_MS);

  test("the heal survives flaky and dead repos: exit 0, no errors", () => {
    expect(main.stdout).not.toContain("::error::");
    expect(main.stderr).not.toContain("::error::");
    expect(main.exitCode).toBe(0);
  });

  function targetsOf(result: Run): Record<string, unknown>[] {
    const line = result.output.split("\n").find((l) => l.startsWith("targets="));
    if (line === undefined) throw new Error(`no targets= line in: ${result.output}`);
    return JSON.parse(line.slice("targets=".length));
  }

  test("a probe that flakes once is retried and the repo stays selected", () => {
    expect(main.stdout).toContain("Vivswan/flaky: push-permission probe failed (attempt 1/3");
    expect(main.stdout).toContain("Vivswan/flaky: settings adoption check failed (attempt 1/3");
    expect(main.stdout).not.toContain("::warning::Vivswan/flaky");
    expect(targetsOf(main).map((t) => t.repo)).toContain("Vivswan/flaky");
  });

  test("a persistently failing repo is skipped with a warning naming repo, probe, and error", () => {
    for (const [repo, probe, error] of [
      ["Vivswan/deadprobe", "push-permission probe", "HTTP 500"],
      ["Vivswan/deadapi", "settings adoption check", "HTTP 502"],
    ]) {
      const warning = main.stdout
        .split("\n")
        .find((line) => line.startsWith(`::warning::${repo}:`));
      expect(warning).toBeDefined();
      expect(warning).toContain(probe);
      expect(warning).toContain(error);
      expect(warning).toContain("skipped this run");
      expect(warning).toContain("nightly heal retries it");
      expect(main.summary).toContain(`- ${repo}:`);
    }
  });

  test("every adopted repository is a target, whatever its list names; an unadopted one is not", () => {
    // The whole selection for the fixture fleet: adoption is the opt-in,
    // so a declaration still naming settings-sync (steady, the pre-fold
    // shape) and one that never did (nomodule) select alike, the 404
    // (unadopted) is a routine notice-level skip, and the repos whose
    // probes never answered stay out with their warnings. The operator
    // repository joins as the builder's self row.
    expect(targetsOf(main).map((t) => t.repo)).toEqual([
      "Vivswan/flaky",
      "Vivswan/nomodule",
      "Vivswan/open-lib",
      "Vivswan/repo-platform",
      "Vivswan/steady",
      "h**-s**r",
    ]);
    const notice = main.stdout
      .split("\n")
      .find((line) => line.startsWith("::notice::Vivswan/unadopted"));
    expect(notice).toBeDefined();
    expect(notice).toContain("no .repo-platform.yml on its default branch");
    expect(main.stdout).not.toContain("::warning::Vivswan/unadopted");
    expect(main.stdout).not.toContain("::notice::Vivswan/nomodule");
    expect(main.summary).not.toContain("Vivswan/nomodule");
    expect(main.summary).not.toContain("Vivswan/unadopted");
  });

  test("a repo the token cannot push is not a member: one notice, no target, no summary entry", () => {
    // Whole outcome for both visibilities: the public one by slug, the
    // private one by hint; the matrix above already excludes both.
    for (const display of ["Vivswan/locked", "h**-l**d"]) {
      expect(main.stdout).toContain(`::notice::${pushProbeSkipNotice(display)}`);
      expect(main.stdout).not.toContain(`::warning::${display}`);
      expect(main.summary).not.toContain(display);
    }
  });

  test(
    "a private repo the token can no longer see leaves without a trace; listed, it would select",
    () => {
      // Control first: listed, the same stubs select it (adopted, probe
      // 200), so the main run's silence about it is discovery's doing.
      const control = run("gone-present", {
        env: { ONLY_REPO: "private", SOURCE_SHA: SHA, STUB_DISCOVER_GONE: "1" },
      });
      expect(control.exitCode).toBe(0);
      expect(targetsOf(control).map((t) => t.repo)).toEqual(["h**-g**", "h**-s**r"]);
      for (const channel of [main.stdout, main.stderr, main.output, main.summary]) {
        expect(channel.toLowerCase()).not.toContain("hidden-gone");
        expect(channel).not.toContain("h**-g**");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test("the matrix is intact: skips never drop their neighbors, self included", () => {
    // One flag per row: the public personas print plainly and carry no
    // tag, the private one rides as its hint with a tag. The operator
    // repo joins as the builder's self row.
    expect(targetsOf(main)).toEqual([
      { repo: "Vivswan/flaky", name: "flaky", private: false, verify: "" },
      { repo: "Vivswan/nomodule", name: "nomodule", private: false, verify: "" },
      { repo: "Vivswan/open-lib", name: "open-lib", private: false, verify: "" },
      { repo: "Vivswan/repo-platform", name: "repo-platform", private: false, verify: "" },
      { repo: "Vivswan/steady", name: "steady", private: false, verify: "" },
      {
        repo: "h**-s**r",
        name: "h**-s**r",
        private: true,
        verify: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    ]);
  });

  test("a discovered private repo never leaks its slug anywhere public", () => {
    // Job log, GITHUB_OUTPUT (the matrix), and the step summary are all
    // world-readable; the hint is the only permitted spelling, in any
    // casing (the stub plants an uppercase variant).
    for (const channel of [main.stdout, main.stderr, main.output, main.summary]) {
      expect(channel.toLowerCase()).not.toContain("hidden-server");
      expect(channel.toLowerCase()).not.toContain("hidden-nomods");
      expect(channel.toLowerCase()).not.toContain("hidden-deadapi");
      expect(channel.toLowerCase()).not.toContain("hidden-locked");
    }
    expect(main.output).toContain("h**-s**r");
  });

  test("a redacted repo's persistent probe failure warns with the scrubbed detail", () => {
    // The stub's 502 text carries the slug inside a URL and an uppercase
    // bare-name variant after it; the retry lines (checked by the leak
    // test above) and this warning must render both as the hint.
    const warning = main.stdout.split("\n").find((line) => line.startsWith("::warning::h**-d**i"));
    expect(warning).toBeDefined();
    expect(warning).toContain("settings adoption check");
    expect(warning).toContain(
      "https://api.github.com/repos/h**-d**i bad gateway; h**-d**i unreachable",
    );
    expect(main.summary).toContain("- h**-d**i");
  });

  test("a hinted repo's unreadable-modules warning and summary carry the hint", () => {
    const warning = main.stdout.split("\n").find((line) => line.startsWith("::warning::h**-n**s"));
    expect(warning).toBeDefined();
    expect(warning).toContain("no readable top-level modules list");
    expect(main.summary).toContain("- h**-n**s");
  });

  test(
    "a private dispatch input arrives via the event payload and never prints",
    () => {
      // The workflow passes no ONLY_REPO env (the runner would print it);
      // the script reads the typed input from GITHUB_EVENT_PATH instead.
      const eventFile = join(root, "dispatch-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-server" } }));
      const r = run("dispatch", { env: { GITHUB_EVENT_PATH: eventFile } });
      expect(r.exitCode).toBe(0);
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel).not.toContain("hidden-server");
      }
      // The one row, whole: the hint in both name slots, the flag set,
      // and a tag - never the slug.
      expect(targetsOf(r)).toEqual([
        {
          repo: "h**-s**r",
          name: "h**-s**r",
          private: true,
          verify: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a bare name scopes the heal, the operator repo's own included",
    () => {
      const r = run("dispatch-self", { env: { ONLY_REPO: "repo-platform" } });
      expect(r.exitCode).toBe(0);
      expect(targetsOf(r)).toEqual([
        { repo: "Vivswan/repo-platform", name: "repo-platform", private: false, verify: "" },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mistyped dispatch input is refused as unknown without echoing the input",
    () => {
      const eventFile = join(root, "dispatch-miss-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-servr" } }));
      const r = run("dispatch-miss", { env: { GITHUB_EVENT_PATH: eventFile } });
      expect(r).toEqual({
        exitCode: 1,
        stdout:
          "::error::1 of 1 scoped repos matched no fleet repository (values withheld - they may be " +
          "private slugs): not among the fleet token's pushable repositories under Vivswan - the grant " +
          "was revoked, the repository is archived or owned by someone else, or the slug is misspelled " +
          "(matching ignores case)\n",
        stderr: "",
        output: "",
        summary: "",
      });
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel).not.toContain("hidden-servr");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a failed discovery still fails the whole run",
    () => {
      // Discovery exits with gh's own code and forwards its stderr, and no
      // matrix is published - not just "some nonzero exit".
      const result = run("no-discovery", { env: { STUB_FAIL_DISCOVERY: "1" } });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("HTTP 500 from stub");
      expect(result.output).not.toContain("targets=");
    },
    TEST_TIMEOUT_MS,
  );

  // A stub bun ahead of the real one corrupts (or fails) the matrix
  // stage per flag; everything else (including this test's own script
  // invocation) execs through to the real bun. The bare identifier is
  // the leaking form: a raw JSON.parse error would quote it into this
  // public log, so the parse must fail with the fixed value-free
  // diagnostic instead.
  function corruptStubBin(name: string): string {
    const dir = join(root, `bin-${name}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "bun"),
      [
        "#!/usr/bin/env bash",
        'if [ -n "$STUB_CORRUPT_MATRIX" ]; then',
        '  case "$*" in *build_settings_matrix.ts*) echo \'[{"repo": corruptmatrix}]\'; exit 0 ;; esac',
        "fi",
        'if [ -n "$STUB_FAIL_MATRIX" ]; then',
        '  case "$*" in *build_settings_matrix.ts*) echo "::error::matrix builder boom"; exit 1 ;; esac',
        "fi",
        'exec "$REAL_BUN" "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return dir;
  }

  test(
    "a malformed settings matrix fails value-free (no SyntaxError echo)",
    () => {
      const stub = corruptStubBin("matrix");
      const r = run("corrupt-matrix", {
        env: {
          PATH: `${stub}:${bin}:${process.env.PATH}`,
          REAL_BUN: process.execPath,
          STUB_CORRUPT_MATRIX: "1",
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("::error::select_settings_repos: settings matrix: not valid JSON");
      for (const channel of [r.stdout, r.stderr, r.summary]) {
        expect(channel).not.toContain("corruptmatrix");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a matrix-builder failure is loud: its captured ::error:: is forwarded",
    () => {
      const stub = corruptStubBin("fail-matrix");
      const r = run("fail-matrix", {
        env: {
          PATH: `${stub}:${bin}:${process.env.PATH}`,
          REAL_BUN: process.execPath,
          STUB_FAIL_MATRIX: "1",
        },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain("::error::matrix builder boom");
    },
    TEST_TIMEOUT_MS,
  );

  const OPEN_LIB = { repo: "Vivswan/open-lib", name: "open-lib", private: false, verify: "" };
  const SELF = {
    repo: "Vivswan/repo-platform",
    name: "repo-platform",
    private: false,
    verify: "",
  };
  const HIDDEN_SERVER = {
    repo: "h**-s**r",
    name: "h**-s**r",
    private: true,
    verify: expect.stringMatching(/^[0-9a-f]{32}$/),
  };
  const FLAKY = { repo: "Vivswan/flaky", name: "flaky", private: false, verify: "" };
  const STEADY = { repo: "Vivswan/steady", name: "steady", private: false, verify: "" };
  const NOMODULE = { repo: "Vivswan/nomodule", name: "nomodule", private: false, verify: "" };

  // The called path (post-green's settings-fleet leg): the scope is public
  // text off the merged PRs of the judged range, so a private repo rides
  // only under the token. The operator repo joins when the scope selects it (it is
  // public). Whole outcome per row: every log line, the summary, the
  // matrix, exit code.
  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const RETRY = (display: string, probe: string, detail: string) =>
    [1, 2].map(
      (attempt) => `${display}: ${probe} failed (attempt ${attempt}/3: ${detail}); retrying...`,
    );
  const GAVE_UP = (display: string, probe: string, detail: string) =>
    `${display}: the ${probe} failed 3 times (last error: ${detail}) - not a permission or adoption answer, so the repo is skipped this run; the nightly heal retries it. If this persists, check the repo's availability and the fleet token.`;
  const DEADAPI_DETAIL = "HTTP 502 from stub";
  const DEADPROBE_DETAIL = "HTTP 500";
  const HIDDEN_DEADAPI_DETAIL =
    "HTTP 502: https://api.github.com/repos/h**-d**i bad gateway; h**-d**i unreachable";
  const NOMODS_WARNING =
    "h**-n**s: its .repo-platform.yml has no readable top-level modules list, so its settings baseline cannot be computed - the repo is skipped and its settings stay unmanaged until the file is fixed.";
  const UNADOPTED_NOTICE = notAdoptedNotice(
    "Vivswan/unadopted",
    "The settings heal only manages adopted repos.",
  );
  // Every public persona's probe output, in row (slug) order.
  const PUBLIC_PROBES = [
    ...RETRY("Vivswan/deadapi", "settings adoption check", DEADAPI_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadapi", "settings adoption check", DEADAPI_DETAIL)}`,
    ...RETRY("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL)}`,
    "Vivswan/flaky: push-permission probe failed (attempt 1/3: HTTP 500); retrying...",
    "Vivswan/flaky: settings adoption check failed (attempt 1/3: HTTP 502 from stub); retrying...",
    `::notice::${pushProbeSkipNotice("Vivswan/locked")}`,
    `::notice::${UNADOPTED_NOTICE}`,
  ];
  const PUBLIC_SUMMARY = `### Settings heal warnings\n${[
    GAVE_UP("Vivswan/deadapi", "settings adoption check", DEADAPI_DETAIL),
    GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
  ]
    .map((line) => `- ${line}\n`)
    .join("")}`;
  // Every private persona's, by hint only.
  const PRIVATE_PROBES = [
    ...RETRY("h**-d**i", "settings adoption check", HIDDEN_DEADAPI_DETAIL),
    `::warning::${GAVE_UP("h**-d**i", "settings adoption check", HIDDEN_DEADAPI_DETAIL)}`,
    `::notice::${pushProbeSkipNotice("h**-l**d")}`,
    `::warning::${NOMODS_WARNING}`,
  ];
  const PRIVATE_SUMMARY = `### Settings heal warnings\n${[
    GAVE_UP("h**-d**i", "settings adoption check", HIDDEN_DEADAPI_DETAIL),
    NOMODS_WARNING,
  ]
    .map((line) => `- ${line}\n`)
    .join("")}`;
  test.each<{
    reason: string;
    scope: string;
    targets: ReturnType<typeof targetsOf>;
    stdout: string;
    summary: string;
  }>([
    {
      reason: "a public slug selects it alone, and slugs alone never probe other repos",
      scope: "Vivswan/open-lib",
      targets: [OPEN_LIB],
      stdout: lines("settings targets: Vivswan/open-lib"),
      summary: "",
    },
    {
      reason: "public selects the public repos, self included, and probes only them",
      scope: "public",
      targets: [FLAKY, NOMODULE, OPEN_LIB, SELF, STEADY],
      stdout: lines(
        ...PUBLIC_PROBES,
        "settings targets: Vivswan/flaky, Vivswan/nomodule, Vivswan/open-lib, Vivswan/repo-platform, Vivswan/steady",
      ),
      summary: PUBLIC_SUMMARY,
    },
    {
      reason: "private selects the private repos, every line by hint",
      scope: "private",
      targets: [HIDDEN_SERVER],
      stdout: lines(...PRIVATE_PROBES, "settings targets: h**-s**r"),
      summary: PRIVATE_SUMMARY,
    },
    {
      reason: "a token unions with a slug",
      scope: "private, Vivswan/open-lib",
      targets: [OPEN_LIB, HIDDEN_SERVER],
      stdout: lines(...PRIVATE_PROBES, "settings targets: Vivswan/open-lib, h**-s**r"),
      summary: PRIVATE_SUMMARY,
    },
  ])(
    "called with $scope: $reason",
    ({ scope, targets, stdout, summary }) => {
      const r = run(`called-${Bun.hash(scope).toString(16)}`, {
        env: { ONLY_REPO: scope, SOURCE_SHA: SHA },
      });
      expect({ ...r, output: r.output.split("\n")[0].slice(0, "targets=".length) }).toEqual({
        exitCode: 0,
        stdout,
        stderr: "",
        output: "targets=",
        summary,
      });
      expect(r.output.split("\n")).toHaveLength(2);
      expect(targetsOf(r)).toEqual(targets);
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel).not.toContain("hidden-server");
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The modules: filters, dispatched: every candidate the tokens admit is
  // probed (all of them when only a filter constrains the fleet, in row
  // order), an adopted one is judged over its declared list, and the
  // operator repo joins only by slug or visibility, never through a filter.
  // Declared: nomodule [uv, release-please], hidden-server [uv, pages],
  // flaky/open-lib/steady [settings-sync].
  const ALL_PROBES = [
    ...RETRY("Vivswan/deadapi", "settings adoption check", DEADAPI_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadapi", "settings adoption check", DEADAPI_DETAIL)}`,
    ...RETRY("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL)}`,
    "Vivswan/flaky: push-permission probe failed (attempt 1/3: HTTP 500); retrying...",
    "Vivswan/flaky: settings adoption check failed (attempt 1/3: HTTP 502 from stub); retrying...",
    ...RETRY("h**-d**i", "settings adoption check", HIDDEN_DEADAPI_DETAIL),
    `::warning::${GAVE_UP("h**-d**i", "settings adoption check", HIDDEN_DEADAPI_DETAIL)}`,
    `::notice::${pushProbeSkipNotice("h**-l**d")}`,
    `::warning::${NOMODS_WARNING}`,
    `::notice::${pushProbeSkipNotice("Vivswan/locked")}`,
    `::notice::${UNADOPTED_NOTICE}`,
  ];
  const ALL_SUMMARY = `### Settings heal warnings\n${[
    GAVE_UP("Vivswan/deadapi", "settings adoption check", DEADAPI_DETAIL),
    GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
    GAVE_UP("h**-d**i", "settings adoption check", HIDDEN_DEADAPI_DETAIL),
    NOMODS_WARNING,
  ]
    .map((line) => `- ${line}\n`)
    .join("")}`;
  const LEFT_OUT = (count: number) =>
    `modules filter: ${count} adopted ${count === 1 ? "repo" : "repos"} left out (selecting none of the listed module sets)`;
  test.each<{
    reason: string;
    repo: string;
    targets: ReturnType<typeof targetsOf>;
    stdout: string;
    summary: string;
  }>([
    {
      reason:
        "a filter alone probes every visibility and keeps the repos selecting the module; the operator repo is not a render",
      repo: "modules:uv",
      targets: [NOMODULE, HIDDEN_SERVER],
      stdout: lines(...ALL_PROBES, LEFT_OUT(3), "settings targets: Vivswan/nomodule, h**-s**r"),
      summary: ALL_SUMMARY,
    },
    {
      reason:
        "a visibility token intersects: only public candidates are probed, self included in none",
      repo: "public,modules:release-please",
      targets: [NOMODULE],
      stdout: lines(...PUBLIC_PROBES, LEFT_OUT(3), "settings targets: Vivswan/nomodule"),
      summary: PUBLIC_SUMMARY,
    },
    {
      reason: "a bare name unions in as typed, the operator repo's own included",
      repo: "repo-platform,modules:uv",
      targets: [NOMODULE, SELF, HIDDEN_SERVER],
      stdout: lines(
        ...ALL_PROBES,
        LEFT_OUT(3),
        "settings targets: Vivswan/nomodule, Vivswan/repo-platform, h**-s**r",
      ),
      summary: ALL_SUMMARY,
    },
  ])(
    "dispatched with $repo: $reason",
    ({ repo, targets, stdout, summary }) => {
      const name = `filter-${Bun.hash(repo).toString(16)}`;
      const eventFile = join(root, `${name}-event.json`);
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo } }));
      const r = run(name, { env: { GITHUB_EVENT_PATH: eventFile } });
      expect({ ...r, output: r.output.split("\n")[0].slice(0, "targets=".length) }).toEqual({
        exitCode: 0,
        stdout,
        stderr: "",
        output: "targets=",
        summary,
      });
      expect(r.output.split("\n")).toHaveLength(2);
      expect(targetsOf(r)).toEqual(targets);
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel.toLowerCase()).not.toContain("hidden-server");
        expect(channel.toLowerCase()).not.toContain("hidden-nomods");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a filter naming no module of the template fails before discovery, naming the roster",
    () => {
      const eventFile = join(root, "filter-unknown-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "modules:uv+pagez" } }));
      const r = run("filter-unknown", { env: { GITHUB_EVENT_PATH: eventFile } });
      expect(r).toEqual({
        exitCode: 1,
        stdout: `::error::1 of 2 module names in the modules: filters is not a module of this template (values withheld - this log is public); the modules are: ${MODULE_ORDER.join(", ")}\n`,
        stderr: "",
        output: "",
        summary: "",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a private slug on the called path is refused, counting only, naming the judged commit",
    () => {
      const r = run("called-private", {
        env: { ONLY_REPO: "Vivswan/open-lib, vivswan/hidden-server", SOURCE_SHA: SHA },
      });
      expect(r).toEqual({
        exitCode: 1,
        stdout: lines(
          `::error::1 of 2 scoped repos are private: name private repositories with the \`private\` token, never by slug - a directive is public text (the range judged at ${SHA.slice(0, 12)})`,
        ),
        stderr: "",
        output: "",
        summary: "",
      });
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel).not.toContain("hidden-server");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dispatched comma list scopes the heal to every listed target, the private one by its hint",
    () => {
      // The typed dispatch input may name private repos; it arrives via
      // the event payload, never as step env.
      const eventFile = join(root, "dispatch-list-event.json");
      writeFileSync(
        eventFile,
        JSON.stringify({ inputs: { repo: "Vivswan/steady, vivswan/hidden-server" } }),
      );
      const r = run("list", { env: { GITHUB_EVENT_PATH: eventFile } });
      expect({ ...r, output: r.output.split("\n")[0].slice(0, "targets=".length) }).toEqual({
        exitCode: 0,
        stdout: lines("settings targets: Vivswan/steady, h**-s**r"),
        stderr: "",
        output: "targets=",
        summary: "",
      });
      expect(r.output.split("\n")).toHaveLength(2);
      expect(targetsOf(r)).toEqual([STEADY, HIDDEN_SERVER]);
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel).not.toContain("hidden-server");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    '"all" is the whole fleet, byte-identical to no scope at all',
    () => {
      const r = run("all", { env: { ONLY_REPO: "all" } });
      expect(r.exitCode).toBe(0);
      expect(targetsOf(r)).toEqual(targetsOf(main));
      expect(r.summary).toBe(main.summary);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a list with one unknown entry fails the whole run, counting rather than naming",
    () => {
      const r = run("list-miss", { env: { ONLY_REPO: "Vivswan/steady,Vivswan/hidden-servr" } });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain(
        "::error::1 of 2 scoped repos matched no fleet repository (values withheld",
      );
      expect(r.output).not.toContain("targets=");
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel).not.toContain("hidden-servr");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a scope of known repos that are not adopted selects nothing, green, with the notice",
    () => {
      // A scoped run may legitimately select nothing: the settings apply
      // that follows a fleet sync must not go red for an unadopted repo.
      const r = run("list-declined", { env: { ONLY_REPO: "Vivswan/unadopted", SOURCE_SHA: SHA } });
      expect({ ...r, output: r.output.split("\n")[0].slice(0, "targets=".length) }).toEqual({
        exitCode: 0,
        stdout: lines(`::notice::${UNADOPTED_NOTICE}`, "settings targets: (none)"),
        stderr: "",
        output: "targets=",
        summary: "",
      });
      expect(r.output.split("\n")).toHaveLength(2);
      expect(targetsOf(r)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an empty scope entry is refused before discovery, so it can neither widen nor narrow the scope",
    () => {
      const r = run("list-empty", { env: { ONLY_REPO: "Vivswan/steady,,Vivswan/flaky" } });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("::error::the scope has an empty entry");
      expect(r.summary).toBe("");
      expect(r.output).not.toContain("targets=");
    },
    TEST_TIMEOUT_MS,
  );
});
