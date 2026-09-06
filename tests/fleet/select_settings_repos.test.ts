import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectsSettingsSync } from "../../.github/scripts/fleet/build_settings_matrix";
import { undiscoveredWarning } from "../../.github/scripts/fleet/sync_scope.ts";
import { tempDirs } from "../shared/temp_dir";

const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";

const temp = tempDirs();

// End-to-end harness for the selector: the script runs against stub `gh`
// and `curl` binaries on PATH (plus a no-op `sleep`, so the retry loop
// costs no wall time). Personas, all enrolled unless probed otherwise;
// adoption (a .repo-platform.yml with a readable modules list) is the
// opt-in to managed settings, whether or not the list still names the
// folded settings-sync module:
//   deadapi       - .repo-platform.yml fetch fails HTTP 502 every attempt
//   deadprobe     - push probe answers HTTP 500 every attempt
//   flaky         - push probe 500s once then 200s; the adoption fetch 502s
//                   once then succeeds (both must be healed by the retries)
//   steady        - every probe answers first try; adopted (its list still
//                   names settings-sync, the pre-fold shape)
//   nomodule      - adopted with a list naming no folded module: a target
//                   like any other
//   unadopted     - no .repo-platform.yml (404): a routine notice-level
//                   skip, never a warning
//   hidden-server - PRIVATE, wildcard-discovered: healthy adoption, must
//                   reach the matrix as its hint with a verify tag, never
//                   as a slug
//   hidden-nomods - PRIVATE, wildcard-discovered: its .repo-platform.yml
//                   has no readable modules list, so the unmanaged
//                   warning and summary line must carry the hint
//   hidden-deadapi - PRIVATE, wildcard-discovered: the adoption fetch 502s
//                   every attempt with the slug and bare name in the
//                   error text; the retry lines and the final warning
//                   must carry only the hint
// The explicit managed personas are absent from discovery, so the
// fail-closed rule marks them private - but their names are committed in
// repos.yml (self-disclosed), so they still print plainly with
// hide_details riding the matrix row. The operator repository itself
// (GITHUB_REPOSITORY) always joins the matrix as the builder's self row.
// The heal must select flaky, steady, nomodule, and hidden-server, warn about
// deadapi, deadprobe, hidden-nomods, and hidden-deadapi (skipped this
// run, retried nightly), and exit 0; only an unreadable registry or a
// failed discovery still exits 1.
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
        // Three wildcard-discovered private repos and one public (open-lib:
        // every probe answers, opts in); every explicit managed persona is
        // deliberately absent (fail-closed => private, but self-disclosed
        // by their repos.yml entries).
        `  echo '[[{"full_name":"Vivswan/open-lib","private":false,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/hidden-server","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/hidden-nomods","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},` +
          `{"full_name":"Vivswan/hidden-deadapi","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}}]]'`,
        "  exit 0",
        "fi",
        'case "$2" in',
        "  repos/Vivswan/flaky/contents/.repo-platform.yml)",
        '    if [ -e "$STUB_STATE/flaky-optin" ]; then echo "modules: [settings-sync]"; exit 0; fi',
        '    touch "$STUB_STATE/flaky-optin"',
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
    // resolves .github/scripts and repos.yml relative to its cwd, so only
    // .github is borrowed from the real repo.
    mkdirSync(fixture, { recursive: true });
    symlinkSync(join(repoRoot, ".github"), join(fixture, ".github"));
    writeFileSync(
      join(fixture, "repos.yml"),
      [
        "managed:",
        '  - "*"',
        "  - Vivswan/deadapi",
        "  - Vivswan/deadprobe",
        "  - Vivswan/flaky",
        "  - Vivswan/nomodule",
        "  - Vivswan/steady",
        "  - Vivswan/unadopted",
        "",
      ].join("\n"),
    );
  });

  interface Run {
    exitCode: number;
    stdout: string;
    stderr: string;
    output: string;
    summary: string;
  }

  // run() spawns bun which spawns more bun children, so one healthy run
  // costs seconds. Host load stretches that, and a cold start (deps
  // installed but caches unwarmed - exactly this file run in isolation
  // in a fresh worktree) reliably pushed the beforeAll past bun-test's
  // default 5s per-test/hook cap (the 5005ms hook-timeout signature;
  // full-suite runs ride earlier suites' warmth and merely flaked).
  // SPAWN_TIMEOUT_MS turns a wedged child into a diagnostic throw
  // instead of exitCode null with partial output, and TEST_TIMEOUT_MS
  // sits above it on every spawning test/hook so that throw always
  // beats bun's value-free kill.
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

  test("the matrix is intact: skips never drop their neighbors, self included", () => {
    // Explicit personas are absent from discovery, so fail-closed marks
    // them private - self-disclosed names stay, hide_details rides along.
    // That pairing (redact_name false, hide_details true) is exactly the
    // case the pre-action render and merge steps must stay quiet for.
    // The operator repo joins as the builder's self row.
    expect(targetsOf(main)).toEqual([
      {
        repo: "Vivswan/flaky",
        name: "flaky",
        redact_name: false,
        hide_details: true,
        verify: "",
      },
      {
        repo: "Vivswan/open-lib",
        name: "open-lib",
        redact_name: false,
        hide_details: false,
        verify: "",
      },
      {
        repo: "Vivswan/repo-platform",
        name: "repo-platform",
        redact_name: false,
        hide_details: false,
        verify: "",
      },
      {
        repo: "Vivswan/steady",
        name: "steady",
        redact_name: false,
        hide_details: true,
        verify: "",
      },
      {
        repo: "h**-s**r",
        name: "h**-s**r",
        redact_name: true,
        hide_details: true,
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
      // The one row, whole: the hint in both name slots, both flags set,
      // and a tag - never the slug.
      expect(targetsOf(r)).toEqual([
        {
          repo: "h**-s**r",
          name: "h**-s**r",
          redact_name: true,
          hide_details: true,
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
        {
          repo: "Vivswan/repo-platform",
          name: "repo-platform",
          redact_name: false,
          hide_details: false,
          verify: "",
        },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mistyped dispatch input fails loudly without echoing the input",
    () => {
      const eventFile = join(root, "dispatch-miss-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-servr" } }));
      const r = run("dispatch-miss", { env: { GITHUB_EVENT_PATH: eventFile } });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain(
        "::error::1 of 1 scoped repos matched no managed repository (values withheld",
      );
      expect(r.output).not.toContain("targets=");
      for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
        expect(channel).not.toContain("hidden-servr");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an unreadable registry still fails the whole run",
    () => {
      const bare = join(root, "bare-fixture");
      mkdirSync(bare);
      symlinkSync(join(repoRoot, ".github"), join(bare, ".github"));
      const result = run("no-registry", { cwd: bare });
      expect(result.exitCode).not.toBe(0);
      // The registry stage's ::error:: rides its captured stdout, which
      // runStage forwards on failure.
      expect(result.stdout).toContain("repos.yml");
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

  // A stub bun ahead of the real one corrupts (or fails) one pipeline
  // stage per flag; everything else (including this test's own script
  // invocation) execs through to the real bun. The bare identifiers are
  // the leaking form: a raw JSON.parse error would quote them into this
  // public log, so both parses must fail with the fixed value-free
  // diagnostic instead.
  function corruptStubBin(name: string): string {
    const dir = join(root, `bin-${name}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, "bun"),
      [
        "#!/usr/bin/env bash",
        'if [ -n "$STUB_CORRUPT_EXCLUDED" ]; then',
        '  case "$*" in *repos_registry.ts\\ excluded*) echo "[corruptslug]"; exit 0 ;; esac',
        "fi",
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
    "a malformed excluded list fails value-free (no SyntaxError echo)",
    () => {
      const stub = corruptStubBin("excluded");
      const r = run("corrupt-excluded", {
        env: {
          PATH: `${stub}:${bin}:${process.env.PATH}`,
          REAL_BUN: process.execPath,
          STUB_CORRUPT_EXCLUDED: "1",
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("::error::select_settings_repos: excluded list: not valid JSON");
      for (const channel of [r.stdout, r.stderr, r.summary]) {
        expect(channel).not.toContain("corruptslug");
      }
    },
    TEST_TIMEOUT_MS,
  );

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

  const OPEN_LIB = {
    repo: "Vivswan/open-lib",
    name: "open-lib",
    redact_name: false,
    hide_details: false,
    verify: "",
  };
  const SELF = {
    repo: "Vivswan/repo-platform",
    name: "repo-platform",
    redact_name: false,
    hide_details: false,
    verify: "",
  };
  const HIDDEN_SERVER = {
    repo: "h**-s**r",
    name: "h**-s**r",
    redact_name: true,
    hide_details: true,
    verify: expect.stringMatching(/^[0-9a-f]{32}$/),
  };
  const FLAKY = {
    repo: "Vivswan/flaky",
    name: "flaky",
    redact_name: false,
    hide_details: true,
    verify: "",
  };
  const STEADY = {
    repo: "Vivswan/steady",
    name: "steady",
    redact_name: false,
    hide_details: true,
    verify: "",
  };

  // The called path (post-green's settings-fleet leg): the scope is public
  // text off the judged main commit, so a private repo rides only under the
  // token; the five explicit personas are absent from discovery, so they
  // count as private (fail-closed) and every run warns once, counting. The
  // operator repo joins when the scope selects it (it is public). Whole
  // outcome per row: every log line, the summary, the matrix, exit code.
  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const UNDISCOVERED = `::warning::${undiscoveredWarning(5)}`;
  const UNDISCOVERED_SUMMARY = `### Settings heal warnings\n- ${undiscoveredWarning(5)}\n`;
  const ONE_UNDISCOVERED_SUMMARY = `### Settings heal warnings\n- ${undiscoveredWarning(1)}\n`;
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
    "h**-n**s: its .repo-platform.yml has no readable top-level modules list, so the settings opt-in cannot be determined - the repo is skipped and its settings stay unmanaged until the file is fixed.";
  // Every private persona's probe output, in enriched-row order.
  const PRIVATE_PROBES = [
    ...RETRY("Vivswan/deadapi", "settings opt-in check", DEADAPI_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadapi", "settings opt-in check", DEADAPI_DETAIL)}`,
    ...RETRY("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL)}`,
    "Vivswan/flaky: push-permission probe failed (attempt 1/3: HTTP 500); retrying...",
    "Vivswan/flaky: settings opt-in check failed (attempt 1/3: HTTP 502 from stub); retrying...",
    ...RETRY("h**-d**i", "settings opt-in check", HIDDEN_DEADAPI_DETAIL),
    `::warning::${GAVE_UP("h**-d**i", "settings opt-in check", HIDDEN_DEADAPI_DETAIL)}`,
    `::warning::${NOMODS_WARNING}`,
    "::notice::Vivswan/nomodule: skipped - its .repo-platform.yml does not select the settings-sync module, the opt-in to centrally managed settings (docs/settings.md). Nothing installs or heals its rulesets or labels.",
  ];
  const PRIVATE_SUMMARY =
    UNDISCOVERED_SUMMARY +
    [
      GAVE_UP("Vivswan/deadapi", "settings opt-in check", DEADAPI_DETAIL),
      GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
      GAVE_UP("h**-d**i", "settings opt-in check", HIDDEN_DEADAPI_DETAIL),
      NOMODS_WARNING,
    ]
      .map((line) => `- ${line}\n`)
      .join("");
  test.each([
    {
      reason: "a public slug selects it alone, and slugs alone never warn about other repos",
      scope: "Vivswan/open-lib",
      targets: [OPEN_LIB],
      stdout: lines("settings targets: Vivswan/open-lib"),
      summary: "",
    },
    {
      reason: "public selects the public repos, self included",
      scope: "public",
      targets: [OPEN_LIB, SELF],
      stdout: lines(UNDISCOVERED, "settings targets: Vivswan/open-lib, Vivswan/repo-platform"),
      summary: UNDISCOVERED_SUMMARY,
    },
    {
      reason: "private selects the rest, the discovered one by its hint",
      scope: "private",
      targets: [FLAKY, STEADY, HIDDEN_SERVER],
      stdout: lines(
        UNDISCOVERED,
        ...PRIVATE_PROBES,
        "settings targets: Vivswan/flaky, Vivswan/steady, h**-s**r",
      ),
      summary: PRIVATE_SUMMARY,
    },
    {
      reason: "a token unions with a slug",
      scope: "private, Vivswan/open-lib",
      targets: [FLAKY, OPEN_LIB, STEADY, HIDDEN_SERVER],
      stdout: lines(
        UNDISCOVERED,
        ...PRIVATE_PROBES,
        "settings targets: Vivswan/flaky, Vivswan/open-lib, Vivswan/steady, h**-s**r",
      ),
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

  test(
    "a private slug on the called path is refused, counting only, naming the judged commit",
    () => {
      const r = run("called-private", {
        env: { ONLY_REPO: "Vivswan/open-lib, vivswan/hidden-server", SOURCE_SHA: SHA },
      });
      expect(r).toEqual({
        exitCode: 1,
        stdout: lines(
          `::error::1 of 2 scoped repos are private: name private repositories with the \`private\` token, never by slug - a directive is public text on main (the range judged at ${SHA.slice(0, 12)})`,
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
    "a dispatched comma list scopes the heal to every listed target, the redacted one by its hint",
    () => {
      // The typed dispatch input may name private repos; it arrives via
      // the event payload, never as step env.
      const eventFile = join(root, "dispatch-list-event.json");
      writeFileSync(
        eventFile,
        JSON.stringify({ inputs: { repo: "Vivswan/steady, vivswan/hidden-server" } }),
      );
      const r = run("list", { env: { GITHUB_EVENT_PATH: eventFile } });
      // steady is an explicit managed persona absent from discovery:
      // fail-closed private, self-disclosed by its repos.yml entry - the
      // one undiscovered repo THIS scope names, so the warning counts one.
      expect({ ...r, output: r.output.split("\n")[0].slice(0, "targets=".length) }).toEqual({
        exitCode: 0,
        stdout: lines(
          `::warning::${undiscoveredWarning(1)}`,
          "settings targets: Vivswan/steady, h**-s**r",
        ),
        stderr: "",
        output: "targets=",
        summary: ONE_UNDISCOVERED_SUMMARY,
      });
      expect(r.output.split("\n")).toHaveLength(2);
      expect(targetsOf(r)).toEqual([
        {
          repo: "Vivswan/steady",
          name: "steady",
          redact_name: false,
          hide_details: true,
          verify: "",
        },
        {
          repo: "h**-s**r",
          name: "h**-s**r",
          redact_name: true,
          hide_details: true,
          verify: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      ]);
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
        "::error::1 of 2 scoped repos matched no managed repository (values withheld",
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
      // A synced repo need not manage its settings here: the settings
      // apply that follows a fleet sync must not go red for it. Dispatched:
      // the persona is absent from discovery, so the called path would
      // refuse it as private before the probes run.
      const eventFile = join(root, "dispatch-declined-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/nomodule" } }));
      const r = run("list-declined", { env: { GITHUB_EVENT_PATH: eventFile } });
      expect({ ...r, output: r.output.split("\n")[0].slice(0, "targets=".length) }).toEqual({
        exitCode: 0,
        stdout: lines(
          `::warning::${undiscoveredWarning(1)}`,
          "::notice::Vivswan/nomodule: skipped - its .repo-platform.yml does not select the settings-sync module, the opt-in to centrally managed settings (docs/settings.md). Nothing installs or heals its rulesets or labels.",
          "settings targets: (none)",
        ),
        stderr: "",
        output: "targets=",
        summary: ONE_UNDISCOVERED_SUMMARY,
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
