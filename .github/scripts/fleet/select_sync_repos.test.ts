import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// End-to-end harness for the sync fan-out selector, stub-gh/curl style
// (see select_settings_repos.test.ts). Personas:
//   steady        - explicit in repos.yml, public in discovery, adopted
//   unadopted     - explicit, public, no .repo-platform.yml (skip notice)
//   hidden-server - PRIVATE, wildcard-discovered, adopted: every public
//                   surface (log, matrix, roster) must carry its hint
//   hidden-locked - PRIVATE, wildcard-discovered, push probe 403s: the
//                   skip notice must carry its hint
// The matrix rows are this job's output contract: a redacted row holds
// {repo: <hint>, verify} and never the slug.
describe("select_sync_repos.sh", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const script = join(import.meta.dir, "select_sync_repos.sh");
  const root = mkdtempSync(join(tmpdir(), "select-sync-"));
  const bin = join(root, "bin");
  const fixture = join(root, "fixture");

  const discovered = [
    { repo: "Vivswan/steady", private: false },
    { repo: "Vivswan/unadopted", private: false },
    { repo: "Vivswan/hidden-server", private: true },
    { repo: "Vivswan/hidden-locked", private: true },
  ];

  beforeAll(() => {
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'case "$2" in',
        "  repos/Vivswan/unadopted/contents/.repo-platform.yml)",
        '    echo "HTTP 404 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/*/contents/.repo-platform.yml) exit 0 ;;",
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
        'while [ "$#" -gt 1 ]; do shift; done',
        'case "$1" in',
        '  *"/Vivswan/hidden-locked.git/"*) printf 403 ;;',
        "  *) printf 200 ;;",
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    mkdirSync(join(fixture, "settings", "repos"), { recursive: true });
    symlinkSync(join(repoRoot, ".github"), join(fixture, ".github"));
    writeFileSync(
      join(fixture, "repos.yml"),
      ["managed:", '  - "*"', "  - Vivswan/steady", "  - Vivswan/unadopted", ""].join("\n"),
    );
  });

  interface Run {
    exitCode: number;
    stdout: string;
    stderr: string;
    output: string;
  }

  function run(name: string, env: Record<string, string> = {}): Run {
    const work = join(root, `work-${name}`);
    mkdirSync(join(work, "temp"), { recursive: true });
    const outputFile = join(work, "output.txt");
    writeFileSync(outputFile, "");
    writeFileSync(join(work, "temp", "discovered.json"), JSON.stringify(discovered));
    const proc = Bun.spawnSync(["bash", script], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAT: "stub-token",
        GH_TOKEN: "stub-token",
        GITHUB_RUN_ID: "8675309",
        ONLY_REPO: "",
        // Neutralize the real event payload CI runs carry; the dispatch
        // tests set their own.
        GITHUB_EVENT_PATH: "",
        RUNNER_TEMP: join(work, "temp"),
        GITHUB_OUTPUT: outputFile,
        ...env,
      },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      output: readFileSync(outputFile, "utf-8"),
    };
  }

  let main: Run;
  beforeAll(() => {
    main = run("main");
  });

  function reposOf(result: Run): Record<string, unknown>[] {
    const line = result.output.split("\n").find((l) => l.startsWith("repos="));
    if (line === undefined) throw new Error(`no repos= line in: ${result.output}`);
    return JSON.parse(line.slice("repos=".length));
  }

  test("selects adopted repos and exits 0", () => {
    expect(main.stderr).not.toContain("::error::");
    expect(main.exitCode).toBe(0);
  });

  test("matrix rows carry redaction fields; redacted rows carry the hint", () => {
    expect(reposOf(main)).toEqual([
      {
        repo: "h**-s**r",
        channel: "",
        redact_name: true,
        hide_details: true,
        verify: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
      {
        repo: "Vivswan/steady",
        channel: "",
        redact_name: false,
        hide_details: false,
        verify: "",
      },
    ]);
  });

  test("no private slug reaches stdout, stderr, or the job output", () => {
    for (const channel of [main.stdout, main.stderr, main.output]) {
      expect(channel).not.toContain("hidden-server");
      expect(channel).not.toContain("hidden-locked");
    }
  });

  test("skip notices print hints for redacted repos and slugs for public ones", () => {
    expect(main.stdout).toContain("::notice::h**-l**d: skipped - the fleet token has no write");
    expect(main.stdout).toContain("::notice::Vivswan/unadopted: skipped - no .repo-platform.yml");
  });

  test("the roster line lists hints, not slugs", () => {
    expect(main.stdout).toContain("syncing: h**-s**r, Vivswan/steady");
  });

  test("a private dispatch input arrives via the event payload and never prints", () => {
    // The workflow passes no ONLY_REPO env (the runner would print it);
    // the script reads the typed input from GITHUB_EVENT_PATH instead.
    const eventFile = join(root, "dispatch-event.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-server" } }));
    const r = run("dispatch", { ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile });
    expect(r.exitCode).toBe(0);
    for (const channel of [r.stdout, r.stderr, r.output]) {
      expect(channel).not.toContain("hidden-server");
    }
    expect(reposOf(r).map((row) => row.repo)).toEqual(["h**-s**r"]);
  });

  test("a mistyped private dispatch input is withheld from the no-match error", () => {
    const eventFile = join(root, "dispatch-miss-event.json");
    writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-servr" } }));
    const r = run("dispatch-miss", { ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("matched no selected repository");
    for (const channel of [r.stdout, r.stderr, r.output]) {
      expect(channel).not.toContain("hidden-servr");
    }
  });
});
