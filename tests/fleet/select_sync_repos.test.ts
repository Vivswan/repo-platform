import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notAdoptedNotice, pushProbeSkipNotice } from "../../.github/scripts/fleet/discovery.ts";
import { tempDirs } from "../shared/temp_dir";

const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";

const temp = tempDirs();

// End-to-end harness for the sync fan-out selector, stub-gh/curl style
// (see select_settings_repos.test.ts). Personas, all discovered:
//   steady        - public, adopted
//   unadopted     - public, no .repo-platform.yml (skip notice)
//   hidden-server - PRIVATE, adopted: every public surface (log, matrix,
//                   roster) must carry its hint
//   hidden-locked - PRIVATE, push probe 403s (the token cannot push, so it
//                   is not a fleet member): the notice must carry its hint
// The matrix rows are this job's output contract: a private row holds
// {repo: <hint>, private: true, verify} and never the slug.
describe("select_sync_repos.ts", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/select_sync_repos.ts");
  const root = temp.dir("select-sync-");
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
        // A redacted repo whose adoption check fails hard, with the slug
        // and bare name woven through the error text (a URL, a sentence,
        // a repeat, a case variant): the selector must scrub them all.
        "  repos/Vivswan/hidden-blocked/contents/.repo-platform.yml)",
        '    echo "HTTP 500: https://api.github.com/repos/Vivswan/hidden-blocked failed; hidden-blocked unavailable, retry HIDDEN-BLOCKED later" >&2',
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

    // The fixture root stands in for the checked-out repo (the script's
    // cwd); nothing in it is read.
    mkdirSync(fixture, { recursive: true });
  });

  interface Run {
    exitCode: number;
    stdout: string;
    stderr: string;
    output: string;
  }

  // Same spawn-heavy harness and bounds as select_settings_repos.test.ts
  // (the full cold-start/load rationale lives there): unbounded, these
  // spawns died under bun-test's default 5s per-test/hook cap, observed
  // here as a ~5003ms test timeout with exitCode null under host load.
  const SPAWN_TIMEOUT_MS = 15_000;
  const TEST_TIMEOUT_MS = 20_000;

  function run(
    name: string,
    env: Record<string, string> = {},
    discoveredList: { repo: string; private: boolean }[] = discovered,
  ): Run {
    const work = join(root, `work-${name}`);
    mkdirSync(join(work, "temp"), { recursive: true });
    const outputFile = join(work, "output.txt");
    writeFileSync(outputFile, "");
    writeFileSync(join(work, "temp", "discovered.json"), JSON.stringify(discoveredList));
    const proc = Bun.spawnSync(["bun", script], {
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAT: "stub-token",
        GH_TOKEN: "stub-token",
        GITHUB_RUN_ID: "8675309",
        ONLY_REPO: "",
        RECOVER: "",
        // Neutralize the real event payload CI runs carry; the dispatch
        // tests set their own.
        GITHUB_EVENT_PATH: "",
        RUNNER_TEMP: join(work, "temp"),
        GITHUB_OUTPUT: outputFile,
        ...env,
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
        `select_sync_repos.ts (run "${name}") ${cause}\n` +
          `${proc.stdout.toString()}${proc.stderr.toString()}`,
      );
    }
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
  }, TEST_TIMEOUT_MS);

  function reposOf(result: Run): Record<string, unknown>[] {
    const line = result.output.split("\n").find((l) => l.startsWith("repos="));
    if (line === undefined) throw new Error(`no repos= line in: ${result.output}`);
    return JSON.parse(line.slice("repos=".length));
  }

  test("selects adopted repos and exits 0", () => {
    expect(main.stderr).not.toContain("::error::");
    expect(main.exitCode).toBe(0);
  });

  test("matrix rows carry the private flag; private rows carry the hint", () => {
    expect(reposOf(main)).toEqual([
      {
        repo: "h**-s**r",
        private: true,
        verify: expect.stringMatching(/^[0-9a-f]{32}$/),
      },
      { repo: "Vivswan/steady", private: false, verify: "" },
    ]);
  });

  test("no private slug reaches stdout, stderr, or the job output", () => {
    for (const channel of [main.stdout, main.stderr, main.output]) {
      expect(channel).not.toContain("hidden-server");
      expect(channel).not.toContain("hidden-locked");
    }
  });

  test("skip notices print hints for private repos and slugs for public ones", () => {
    expect(main.stdout).toContain("::notice::h**-l**d: not in the fleet - the fleet token cannot");
    expect(main.stdout).toContain("::notice::Vivswan/unadopted: skipped - no .repo-platform.yml");
  });

  test("the roster line lists hints, not slugs", () => {
    expect(main.stdout).toContain("syncing: h**-s**r, Vivswan/steady");
  });

  test(
    "a private dispatch input arrives via the event payload and never prints",
    () => {
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
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mistyped private dispatch input is withheld from the no-match error",
    () => {
      const eventFile = join(root, "dispatch-miss-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-servr" } }));
      const r = run("dispatch-miss", { ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain("matched no fleet repository (values withheld");
      for (const channel of [r.stdout, r.stderr, r.output]) {
        expect(channel).not.toContain("hidden-servr");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "recover=recopy with an empty repo input is rejected before selection",
    () => {
      // The real fat-finger shape: a dispatch payload whose repo input was
      // left blank, not the harness's empty GITHUB_EVENT_PATH short-circuit.
      const eventFile = join(root, "recover-unscoped-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "", recover: "recopy" } }));
      const r = run("recover-unscoped", { GITHUB_EVENT_PATH: eventFile, RECOVER: "recopy" });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain(
        "::error::recover=recopy needs an explicit scope: dispatch it with repo=<owner/name>",
      );
      expect(r.output).not.toContain("repos=");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "recover=none (the dispatch default) with an empty repo selects normally",
    () => {
      const eventFile = join(root, "recover-none-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "", recover: "none" } }));
      const r = run("recover-none", { GITHUB_EVENT_PATH: eventFile, RECOVER: "none" });
      expect(r.exitCode).toBe(0);
      expect(reposOf(r).map((row) => row.repo)).toEqual(reposOf(main).map((row) => row.repo));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "repo=all with recover=recopy fans out to the whole selected fleet",
    () => {
      // The real dispatch shape: repo arrives via the event payload,
      // recover via the RECOVER step env.
      const eventFile = join(root, "recover-all-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "all", recover: "recopy" } }));
      const r = run("recover-all", { GITHUB_EVENT_PATH: eventFile, RECOVER: "recopy" });
      expect(r.exitCode).toBe(0);
      expect(reposOf(r).map((row) => row.repo)).toEqual(reposOf(main).map((row) => row.repo));
    },
    TEST_TIMEOUT_MS,
  );

  // The called path (post-green's sync-fleet leg): the scope is public text
  // off the judged main commit, so a private repo rides only under the
  // token. Whole outcome per row: every log line, the matrix, exit code.
  const HIDDEN_SERVER_ROW = {
    repo: "h**-s**r",
    private: true,
    verify: expect.stringMatching(/^[0-9a-f]{32}$/),
  };
  const STEADY_ROW = { repo: "Vivswan/steady", private: false, verify: "" };
  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const UNADOPTED = `::notice::${notAdoptedNotice("Vivswan/unadopted")}`;
  const LOCKED = `::notice::${pushProbeSkipNotice("h**-l**d", 403)}`;
  const NO_FLEET_REPO = (missing: number, total: number) =>
    `::error::${missing} of ${total} scoped repos matched no fleet repository (values withheld - ` +
    "they may be private slugs): a repo you scoped to was not discovered this run - the fleet " +
    "token cannot push to it, or it is archived - or the slug is misspelled (matching ignores case)\n";
  test.each([
    {
      reason: "a public slug list selects exactly those (the unadopted one drops with its notice)",
      scope: "Vivswan/steady,Vivswan/unadopted",
      discoveredList: discovered,
      repos: [STEADY_ROW],
      stdout: lines(UNADOPTED, "syncing: Vivswan/steady"),
    },
    {
      reason: "public selects the public repos",
      scope: "public",
      discoveredList: discovered,
      repos: [STEADY_ROW],
      stdout: lines(UNADOPTED, "syncing: Vivswan/steady"),
    },
    {
      reason: "private selects the private repos, by hint (the locked one drops on its probe)",
      scope: "private",
      discoveredList: discovered,
      repos: [HIDDEN_SERVER_ROW],
      stdout: lines(LOCKED, "syncing: h**-s**r"),
    },
    {
      reason: "a token unions with a slug",
      scope: "private, Vivswan/steady",
      discoveredList: discovered,
      repos: [HIDDEN_SERVER_ROW, STEADY_ROW],
      stdout: lines(LOCKED, "syncing: h**-s**r, Vivswan/steady"),
    },
    {
      reason:
        "a repo discovery did not list is not in the fleet: public simply never sees it, no warning",
      scope: "public",
      discoveredList: discovered.filter((entry) => entry.repo !== "Vivswan/steady"),
      repos: [],
      stdout: lines(UNADOPTED, "::notice::no adopted repos selected; nothing to sync."),
    },
  ])(
    "called with $scope: $reason",
    ({ scope, discoveredList, repos, stdout }) => {
      const r = run(
        `called-${Bun.hash(scope + discoveredList.length).toString(16)}`,
        { ONLY_REPO: scope, TARGET_SHA: SHA },
        discoveredList,
      );
      expect({ ...r, output: r.output.split("\n")[0].slice(0, "repos=".length) }).toEqual({
        exitCode: 0,
        stdout,
        stderr: "",
        output: "repos=",
      });
      expect(r.output.split("\n")).toHaveLength(2);
      expect(reposOf(r)).toEqual(repos);
      for (const channel of [r.stdout, r.stderr, r.output]) {
        expect(channel).not.toContain("hidden-server");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test.each([
    {
      reason:
        "a private slug on the called path is refused, naming the judged commit: private repos ride under the token",
      scope: "Vivswan/steady,Vivswan/hidden-server",
      stdout: `::error::1 of 2 scoped repos are private: name private repositories with the \`private\` token, never by slug - a directive is public text on main (the range judged at ${SHA.slice(0, 12)})\n`,
      withheld: "hidden-server",
    },
    {
      reason: "a list with one miss fails the whole plan",
      scope: "Vivswan/steady,Vivswan/hidden-servr",
      stdout: NO_FLEET_REPO(1, 2),
      withheld: "hidden-servr",
    },
    {
      reason: "a lone comma fails the plan instead of fanning out",
      scope: ",",
      stdout:
        "::error::the scope has an empty entry: pass owner/name slugs, public, or private separated by commas, with no stray or trailing comma\n",
      withheld: null,
    },
    {
      reason:
        "a slug-only scope whose own slug discovery missed is refused as unknown: not in the fleet is not a skip",
      scope: "Vivswan/steady",
      discoveredList: discovered.filter((entry) => entry.repo !== "Vivswan/steady"),
      stdout: NO_FLEET_REPO(1, 1),
      withheld: null,
    },
  ])(
    "$reason, counting only",
    ({ scope, stdout, withheld, discoveredList = discovered }) => {
      const r = run(
        `refused-${Bun.hash(scope + discoveredList.length).toString(16)}`,
        { ONLY_REPO: scope, TARGET_SHA: SHA },
        discoveredList,
      );
      expect(r).toEqual({ exitCode: 1, stdout, stderr: "", output: "" });
      if (withheld !== null) {
        for (const channel of [r.stdout, r.stderr, r.output]) {
          expect(channel).not.toContain(withheld);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "repo=all without recover selects the same fleet as an empty repo",
    () => {
      const r = run("all-plain", { ONLY_REPO: "all" });
      expect(r.exitCode).toBe(0);
      expect(reposOf(r).map((row) => row.repo)).toEqual(reposOf(main).map((row) => row.repo));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a single-repo recovery keeps its scope and never prints the slug",
    () => {
      const eventFile = join(root, "recover-single-event.json");
      writeFileSync(
        eventFile,
        JSON.stringify({ inputs: { repo: "Vivswan/hidden-server", recover: "recopy" } }),
      );
      const r = run("recover-single", { GITHUB_EVENT_PATH: eventFile, RECOVER: "recopy" });
      expect(r.exitCode).toBe(0);
      expect(reposOf(r).map((row) => row.repo)).toEqual(["h**-s**r"]);
      for (const channel of [r.stdout, r.stderr, r.output]) {
        expect(channel).not.toContain("hidden-server");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a redacted repo's hard adoption failure prints only the hint, wherever the slug hid",
    () => {
      // The stub's error text carries the slug in a URL, the bare name, and
      // an uppercase variant; the failure must surface (exit 1) with every
      // spelling scrubbed to the hint.
      const eventFile = join(root, "hidden-blocked-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-blocked" } }));
      const r = run("hidden-blocked", { GITHUB_EVENT_PATH: eventFile }, [
        ...discovered,
        { repo: "Vivswan/hidden-blocked", private: true },
      ]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain("adoption check failed for h**-b**d");
      expect(r.stdout).toContain("https://api.github.com/repos/h**-b**d failed");
      for (const channel of [r.stdout, r.stderr, r.output]) {
        expect(channel.toLowerCase()).not.toContain("hidden-blocked");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
