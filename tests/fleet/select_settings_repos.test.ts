import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end harness for the selector, in the stub-gh style of
// validate_central_settings.test.ts: the script runs against stub `gh`
// and `curl` binaries on PATH (plus a no-op `sleep`, so the retry loop
// costs no wall time). Personas, all enrolled/adopted unless probed
// otherwise:
//   central-home  - has settings/repos/central-home.yml, never probed
//   deadapi       - settings.yml check fails with HTTP 502 every attempt
//   deadprobe     - push probe answers HTTP 500 every attempt
//   flaky         - push probe 500s once then 200s; adoption 502s once
//                   then succeeds (both must be healed by the retries)
//   steady        - every probe answers first try
//   hidden-server - PRIVATE, wildcard-discovered: healthy, must reach the
//                   matrix as its hint with a verify tag, never as a slug
//   hidden-nohome - PRIVATE, wildcard-discovered: no settings home, so
//                   its warning and summary line must carry the hint
// The explicit managed personas are absent from discovery, so the
// fail-closed rule marks them private - but their names are committed in
// repos.yml (self-disclosed), so they still print plainly with
// hide_details riding the matrix row.
// The heal must select flaky, steady, and hidden-server (plus
// central-home's central file), warn about deadapi and deadprobe
// (skipped this run, retried nightly), and exit 0; only an unreadable
// registry or a failed discovery still exits 1.
describe("select_settings_repos.ts", () => {
  const repoRoot = join(import.meta.dir, "..", "..");
  const script = join(import.meta.dir, "../../.github/scripts/fleet/select_settings_repos.ts");
  const root = mkdtempSync(join(tmpdir(), "select-settings-"));
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
        // Two wildcard-discovered private repos; every explicit managed
        // persona is deliberately absent (fail-closed => private, but
        // self-disclosed by their repos.yml entries).
        `  echo '[[{"full_name":"Vivswan/hidden-server","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}},{"full_name":"Vivswan/hidden-nohome","private":true,"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}}]]'`,
        "  exit 0",
        "fi",
        'case "$2" in',
        "  repos/Vivswan/flaky/contents/.repo-platform.yml)",
        '    if [ -e "$STUB_STATE/flaky-adoption" ]; then exit 0; fi',
        '    touch "$STUB_STATE/flaky-adoption"',
        '    echo "HTTP 502 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/deadapi/contents/.github/settings.yml)",
        '    echo "HTTP 502 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/hidden-nohome/contents/.github/settings.yml)",
        '    echo "HTTP 404 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/*/contents/.repo-platform.yml) exit 0 ;;",
        "  repos/*/contents/.github/settings.yml) echo '\"abc123\"' ;;",
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
    // resolves .github/scripts, repos.yml, and settings/repos relative
    // to its cwd, so only .github is borrowed from the real repo.
    mkdirSync(join(fixture, "settings", "repos"), { recursive: true });
    symlinkSync(join(repoRoot, ".github"), join(fixture, ".github"));
    writeFileSync(
      join(fixture, "repos.yml"),
      [
        "managed:",
        '  - "*"',
        "  - Vivswan/central-home",
        "  - Vivswan/deadapi",
        "  - Vivswan/deadprobe",
        "  - Vivswan/flaky",
        "  - Vivswan/steady",
        "",
      ].join("\n"),
    );
    writeFileSync(join(fixture, "settings", "repos", "central-home.yml"), "repository: {}\n");
  });

  interface Run {
    exitCode: number;
    stdout: string;
    stderr: string;
    output: string;
    summary: string;
  }

  function run(name: string, options: { cwd?: string; env?: Record<string, string> } = {}): Run {
    const work = join(root, `work-${name}`);
    mkdirSync(join(work, "state"), { recursive: true });
    mkdirSync(join(work, "temp"));
    const outputFile = join(work, "output.txt");
    const summaryFile = join(work, "summary.md");
    writeFileSync(outputFile, "");
    writeFileSync(summaryFile, "");
    const proc = Bun.spawnSync(["bun", script], {
      cwd: options.cwd ?? fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAT: "stub-token",
        PROBE_RETRY_DELAY_MS: "0",
        GH_TOKEN: "stub-token",
        GITHUB_RUN_ID: "8675309",
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
  });

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
    expect(main.stdout).toContain("Vivswan/flaky: adoption check failed (attempt 1/3");
    expect(main.stdout).not.toContain("::warning::Vivswan/flaky");
    expect(targetsOf(main).map((t) => t.repo)).toContain("Vivswan/flaky");
  });

  test("a persistently failing repo is skipped with a warning naming repo, probe, and error", () => {
    for (const [repo, probe, error] of [
      ["Vivswan/deadprobe", "push-permission probe", "HTTP 500"],
      ["Vivswan/deadapi", "settings.yml check", "HTTP 502"],
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

  test("the matrix is intact: skips never drop their neighbors, homes are carried", () => {
    // Explicit personas are absent from discovery, so fail-closed marks
    // them private - self-disclosed names stay, hide_details rides along.
    expect(targetsOf(main)).toEqual([
      {
        repo: "Vivswan/central-home",
        name: "central-home",
        home: "central",
        redact_name: false,
        verify: "",
      },
      {
        repo: "Vivswan/flaky",
        name: "flaky",
        home: "in-repo",
        redact_name: false,
        verify: "",
      },
      {
        repo: "Vivswan/steady",
        name: "steady",
        home: "in-repo",
        redact_name: false,
        verify: "",
      },
      {
        repo: "h**-s**r",
        name: "h**-s**r",
        home: "in-repo",
        redact_name: true,
        verify: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
    ]);
  });

  test("a discovered private repo never leaks its slug anywhere public", () => {
    // Job log, GITHUB_OUTPUT (the matrix), and the step summary are all
    // world-readable; the hint is the only permitted spelling.
    for (const channel of [main.stdout, main.stderr, main.output, main.summary]) {
      expect(channel).not.toContain("hidden-server");
      expect(channel).not.toContain("hidden-nohome");
    }
    expect(main.output).toContain("h**-s**r");
  });

  test("a hinted repo's no-settings-home warning and summary carry the hint", () => {
    const warning = main.stdout.split("\n").find((line) => line.startsWith("::warning::h**-n**e"));
    expect(warning).toBeDefined();
    expect(warning).toContain("no settings/repos/<name>.yml here");
    expect(main.summary).toContain("- h**-n**e");
  });

  test("a private dispatch input arrives via the event payload and never prints", () => {
    // The workflow passes no ONLY_REPO env (the runner would print it);
    // the script reads the typed input from GITHUB_EVENT_PATH instead.
    const eventFile = join(root, "dispatch-event.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-server" } }));
    const r = run("dispatch", { env: { GITHUB_EVENT_PATH: eventFile } });
    expect(r.exitCode).toBe(0);
    for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
      expect(channel).not.toContain("hidden-server");
    }
    const targets = targetsOf(r);
    expect(targets).toHaveLength(1);
    expect(targets[0].home).toBe("in-repo");
    expect(targets[0].redact_name).toBe(true);
  });

  test("a bare central-file name scopes the heal to its central row", () => {
    const r = run("dispatch-central", { env: { ONLY_REPO: "central-home" } });
    expect(r.exitCode).toBe(0);
    expect(targetsOf(r)).toEqual([
      expect.objectContaining({ repo: "Vivswan/central-home", home: "central" }),
    ]);
  });

  test("a mistyped dispatch input fails loudly without echoing the input", () => {
    const eventFile = join(root, "dispatch-miss-event.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-servr" } }));
    const r = run("dispatch-miss", { env: { GITHUB_EVENT_PATH: eventFile } });
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("matches no settings target");
    for (const channel of [r.stdout, r.stderr, r.output, r.summary]) {
      expect(channel).not.toContain("hidden-servr");
    }
  });

  test("an unreadable registry still fails the whole run", () => {
    const bare = join(root, "bare-fixture");
    mkdirSync(bare);
    symlinkSync(join(repoRoot, ".github"), join(bare, ".github"));
    const result = run("no-registry", { cwd: bare });
    expect(result.exitCode).not.toBe(0);
    // The registry stage's ::error:: rides its captured stdout, which
    // runStage forwards on failure.
    expect(result.stdout).toContain("repos.yml");
  });

  test("a failed discovery still fails the whole run", () => {
    const result = run("no-discovery", { env: { STUB_FAIL_DISCOVERY: "1" } });
    expect(result.exitCode).not.toBe(0);
  });
});
