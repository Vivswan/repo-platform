import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end harness for the selector, in the stub-gh style of
// validate_central_settings.test.ts: the script runs against stub `gh`
// and `curl` binaries on PATH (plus a no-op `sleep`, so the retry loop
// costs no wall time). Personas, all enrolled/adopted unless probed
// otherwise:
//   central-home - has settings/repos/central-home.yml, never probed
//   deadapi      - settings.yml check fails with HTTP 502 every attempt
//   deadprobe    - push probe answers HTTP 500 every attempt
//   flaky        - push probe 500s once then 200s; adoption 502s once
//                  then succeeds (both must be healed by the retries)
//   steady       - every probe answers first try
// The heal must select flaky and steady, warn about deadapi and
// deadprobe (skipped this run, retried nightly), and exit 0; only an
// unreadable registry or a failed discovery still exits 1.
describe("select_settings_repos.sh", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const script = join(import.meta.dir, "select_settings_repos.sh");
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
        "  echo '[[]]'",
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
    const proc = Bun.spawnSync(["bash", script], {
      cwd: options.cwd ?? fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAT: "stub-token",
        GH_TOKEN: "stub-token",
        OWNER: "Vivswan",
        RUNNER_TEMP: join(work, "temp"),
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        STUB_STATE: join(work, "state"),
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

  test("a probe that flakes once is retried and the repo stays selected", () => {
    expect(main.stdout).toContain("Vivswan/flaky: push-permission probe failed (attempt 1/3");
    expect(main.stdout).toContain("Vivswan/flaky: adoption check failed (attempt 1/3");
    expect(main.stdout).not.toContain("::warning::Vivswan/flaky");
    expect(main.output).toContain("Vivswan/flaky\n");
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

  test("the rest of the list is intact: skips never drop their neighbors", () => {
    expect(main.output).toBe("repos<<REPOS_EOF\nVivswan/flaky\nVivswan/steady\nREPOS_EOF\n");
  });

  test("an unreadable registry still fails the whole run", () => {
    const bare = join(root, "bare-fixture");
    mkdirSync(bare);
    symlinkSync(join(repoRoot, ".github"), join(bare, ".github"));
    const result = run("no-registry", { cwd: bare });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("repos.yml");
  });

  test("a failed discovery still fails the whole run", () => {
    const result = run("no-discovery", { env: { STUB_FAIL_DISCOVERY: "1" } });
    expect(result.exitCode).not.toBe(0);
  });
});
