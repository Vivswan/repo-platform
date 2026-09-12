import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notAdoptedNotice, pushProbeSkipNotice } from "../../.github/scripts/fleet/discovery.ts";
import { moduleRoster } from "../../.github/scripts/sync/modules.ts";
import { ROWS_FILE } from "../../.github/scripts/sync/verdict.ts";
import { harnessBound } from "../shared/harness_bound";
import { tempDirs } from "../shared/temp_dir";

const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";

const temp = tempDirs();

// End-to-end harness for the sync fan-out selector, stub-gh/curl style (see select_settings_repos.test.ts).
// The personas carry the facts the stubs cannot show:
//   PRIVATE ones            -> never reach the public log: skips counted, the rows file alone carries their slugs
//   revoked push, public    -> stays discoverable and prints a notice
//   revoked push, private   -> vanishes from GET /user/repos, so the stubs admit hidden-gone only in the control run
//   badlist, hidden-nomods  -> unreadable modules list, so filter runs only: anywhere else they would select and shift each exact row list
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
    { repo: "Vivswan/locked", private: false },
    { repo: "Vivswan/repo-platform", private: false },
  ];
  const HIDDEN_GONE = { repo: "Vivswan/hidden-gone", private: true };
  const HIDDEN_NOMODS = { repo: "Vivswan/hidden-nomods", private: true };
  const BADLIST = { repo: "Vivswan/badlist", private: false };

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
        // A private repo whose adoption check fails hard, with the slug
        // and bare name woven through the error text (a URL, a sentence,
        // a repeat, a case variant): the selector must scrub them all. The
        // partial body left on stdout (as a timed-out raw read leaves it)
        // names another private repo and must not print at all.
        "  repos/Vivswan/hidden-blocked/contents/.repo-platform.yml)",
        "    echo 'modules: [site] # shared with Vivswan/hidden-billing'",
        '    echo "HTTP 500: https://api.github.com/repos/Vivswan/hidden-blocked failed; hidden-blocked unavailable, retry HIDDEN-BLOCKED later" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/steady/contents/.repo-platform.yml) echo 'modules: [uv, site]' ;;",
        "  repos/Vivswan/hidden-server/contents/.repo-platform.yml) echo 'modules: [site, release-please]' ;;",
        "  repos/Vivswan/hidden-nomods/contents/.repo-platform.yml) echo 'notmodules: true' ;;",
        "  repos/Vivswan/badlist/contents/.repo-platform.yml) echo 'modules: notalist' ;;",
        "  repos/*/contents/.repo-platform.yml) echo 'modules: [uv]' ;;",
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
        '  *"/Vivswan/hidden-locked.git/"*|*"/Vivswan/locked.git/"*) printf 403 ;;',
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
    rows: { repo: string; private: boolean }[] | null;
  }

  // Same spawn-heavy harness and bounds as select_settings_repos.test.ts
  // (the full cold-start/load rationale lives there): unbounded, these
  // spawns died under bun-test's default 5s per-test/hook cap, observed
  // here as a ~5003ms test timeout with exitCode null under host load.
  const SPAWN_TIMEOUT_MS = harnessBound(15_000);
  const TEST_TIMEOUT_MS = harnessBound(20_000);

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
        OWNER: "Vivswan",
        GITHUB_REPOSITORY: "Vivswan/repo-platform",
        ONLY_REPO: "",
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
    const rowsFile = join(work, "temp", ROWS_FILE);
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      output: readFileSync(outputFile, "utf-8"),
      rows: existsSync(rowsFile) ? JSON.parse(readFileSync(rowsFile, "utf-8")) : null,
    };
  }

  let main: Run;
  beforeAll(() => {
    main = run("main");
  }, TEST_TIMEOUT_MS);

  const HIDDEN_SERVER_ROW = { repo: "Vivswan/hidden-server", private: true };
  const STEADY_ROW = { repo: "Vivswan/steady", private: false };

  test("selects adopted repos and exits 0", () => {
    expect(main.stderr).not.toContain("::error::");
    expect(main.exitCode).toBe(0);
  });

  test("the rows file carries the real slugs, sorted, with the visibility; the output carries the count alone", () => {
    expect(main.rows).toEqual([HIDDEN_SERVER_ROW, STEADY_ROW]);
    expect(main.output).toBe("count=2\n");
  });

  test("the operator repository is discovered but never a row", () => {
    expect(main.rows?.map((row) => row.repo)).not.toContain("Vivswan/repo-platform");
    expect(main.stdout).not.toContain("Vivswan/repo-platform");
  });

  test("no private slug reaches stdout, stderr, or the job output", () => {
    for (const channel of [main.stdout, main.stderr, main.output]) {
      expect(channel).not.toContain("hidden-server");
      expect(channel).not.toContain("hidden-locked");
    }
  });

  test("skip notices name public repos by slug and count private ones", () => {
    expect(main.stdout).toContain(`::notice::${pushProbeSkipNotice("a private repository")}`);
    expect(main.stdout).toContain(`::notice::${pushProbeSkipNotice("Vivswan/locked")}`);
    expect(main.stdout).toContain("::notice::Vivswan/unadopted: skipped - no .repo-platform.yml");
  });

  test(
    "a private repo the token can no longer see leaves without a trace; discovered, it would select",
    () => {
      // Control first: with the persona in the discovered list the same
      // stubs select it, so its absence from the main run's exact rows and
      // every channel is discovery's doing, not a stub that never admitted it.
      const control = run("gone-present", { ONLY_REPO: "private", TARGET_SHA: SHA }, [
        ...discovered,
        HIDDEN_GONE,
      ]);
      expect(control.exitCode).toBe(0);
      expect(control.rows?.map((row) => row.repo)).toEqual([
        "Vivswan/hidden-gone",
        "Vivswan/hidden-server",
      ]);
      for (const channel of [main.stdout, main.stderr, main.output]) {
        expect(channel).not.toContain("hidden-gone");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test("the roster line names public repos and counts private ones", () => {
    expect(main.stdout).toContain("syncing: Vivswan/steady and 1 private repository");
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
      expect(r.rows).toEqual([HIDDEN_SERVER_ROW]);
      expect(r.stdout).toContain("syncing: 1 private repository\n");
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
      expect(r.rows).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  // The called path (post-green's sync-fleet leg): the scope is public text
  // off the merged PRs of the judged range, so a private repo rides only
  // under the token. Whole outcome per row: every log line, the rows, exit code.
  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const UNADOPTED = `::notice::${notAdoptedNotice("Vivswan/unadopted")}`;
  const LOCKED = `::notice::${pushProbeSkipNotice("a private repository")}`;
  const LOCKED_PUBLIC = `::notice::${pushProbeSkipNotice("Vivswan/locked")}`;
  const NO_FLEET_REPO = (missing: number, total: number) =>
    `::error::${missing} of ${total} scoped repos matched no fleet repository (values withheld - ` +
    "they may be private slugs): not among the fleet token's pushable repositories under Vivswan - " +
    "the grant was revoked, the repository is archived or owned by someone else, or the slug is " +
    "misspelled (matching ignores case)\n";
  test.each<{
    reason: string;
    scope: string;
    discoveredList: typeof discovered;
    rows: Run["rows"];
    stdout: string;
  }>([
    {
      reason: "a public slug list selects exactly those (the unadopted one drops with its notice)",
      scope: "Vivswan/steady,Vivswan/unadopted",
      discoveredList: discovered,
      rows: [STEADY_ROW],
      stdout: lines(UNADOPTED, "syncing: Vivswan/steady"),
    },
    {
      reason: "public selects the public repos (the revoked public one drops with its notice)",
      scope: "public",
      discoveredList: discovered,
      rows: [STEADY_ROW],
      stdout: lines(LOCKED_PUBLIC, UNADOPTED, "syncing: Vivswan/steady"),
    },
    {
      reason: "private selects the private repos, counted (the locked one drops on its probe)",
      scope: "private",
      discoveredList: discovered,
      rows: [HIDDEN_SERVER_ROW],
      stdout: lines(LOCKED, "syncing: 1 private repository"),
    },
    {
      reason: "a token unions with a slug",
      scope: "private, Vivswan/steady",
      discoveredList: discovered,
      rows: [HIDDEN_SERVER_ROW, STEADY_ROW],
      stdout: lines(LOCKED, "syncing: Vivswan/steady and 1 private repository"),
    },
    {
      reason:
        "a repo discovery did not list is not in the fleet: public simply never sees it, no warning",
      scope: "public",
      discoveredList: discovered.filter((entry) => entry.repo !== "Vivswan/steady"),
      rows: [],
      stdout: lines(
        LOCKED_PUBLIC,
        UNADOPTED,
        "::notice::no adopted repos selected; nothing to sync.",
      ),
    },
  ])(
    "called with $scope: $reason",
    ({ scope, discoveredList, rows, stdout }) => {
      const r = run(
        `called-${Bun.hash(scope + discoveredList.length).toString(16)}`,
        { ONLY_REPO: scope, TARGET_SHA: SHA },
        discoveredList,
      );
      expect(r).toEqual({
        exitCode: 0,
        stdout,
        stderr: "",
        output: `count=${rows?.length ?? 0}\n`,
        rows,
      });
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
      stdout: `::error::1 of 2 scoped repos are private: name private repositories with the \`private\` token, never by slug - a directive is public text (the range judged at ${SHA.slice(0, 12)})\n`,
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
      expect(r).toEqual({ exitCode: 1, stdout, stderr: "", output: "", rows: null });
      if (withheld !== null) {
        for (const channel of [r.stdout, r.stderr, r.output]) {
          expect(channel).not.toContain(withheld);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The modules: filters, dispatched (the typed input arrives via the event payload);
  // a candidate whose declared list the filter cannot read is left out with a warning (naming it when public), never silently.
  const BADLIST_ROW = { repo: "Vivswan/badlist", private: false };
  const UNREADABLE = (display: string) =>
    `::warning::${display}: its .repo-platform.yml has no readable top-level modules list, so the modules filter cannot judge it - left out of this run; fix the file (the sync would fail on it too), then dispatch the repo by slug or re-run.`;
  const LEFT_OUT = (count: number) =>
    `modules filter: ${count} adopted ${count === 1 ? "repo" : "repos"} left out (selecting none of the listed module sets)`;
  const FILTER_FLEET = [...discovered, HIDDEN_NOMODS, BADLIST];
  test.each<{
    reason: string;
    repo: string;
    rows: Run["rows"];
    stdout: string;
  }>([
    {
      reason:
        "one module selects every visibility that selects it; the two unreadable lists are reported, the private one counted (case folds)",
      repo: "Modules: Site",
      rows: [HIDDEN_SERVER_ROW, STEADY_ROW],
      stdout: lines(
        UNREADABLE("Vivswan/badlist"),
        LOCKED,
        UNREADABLE("a private repository"),
        LOCKED_PUBLIC,
        UNADOPTED,
        LEFT_OUT(0),
        "syncing: Vivswan/steady and 1 private repository",
      ),
    },
    {
      reason: "AND: every named module must be selected",
      repo: "modules:site+release-please",
      rows: [HIDDEN_SERVER_ROW],
      stdout: lines(
        UNREADABLE("Vivswan/badlist"),
        LOCKED,
        UNREADABLE("a private repository"),
        LOCKED_PUBLIC,
        UNADOPTED,
        LEFT_OUT(1),
        "syncing: 1 private repository",
      ),
    },
    {
      reason: "a visibility token intersects: only public candidates are probed and judged",
      repo: "public,modules:site",
      rows: [STEADY_ROW],
      stdout: lines(
        UNREADABLE("Vivswan/badlist"),
        LOCKED_PUBLIC,
        UNADOPTED,
        LEFT_OUT(0),
        "syncing: Vivswan/steady",
      ),
    },
    {
      reason: "a filter no private candidate passes selects nothing, green",
      repo: "private,modules:uv",
      rows: [],
      stdout: lines(
        LOCKED,
        UNREADABLE("a private repository"),
        LEFT_OUT(1),
        "::notice::no adopted repos selected; nothing to sync.",
      ),
    },
    {
      reason: "a slug unions in as typed: its unreadable list is not judged",
      repo: "Vivswan/badlist,modules:release-please",
      rows: [BADLIST_ROW, HIDDEN_SERVER_ROW],
      stdout: lines(
        LOCKED,
        UNREADABLE("a private repository"),
        LOCKED_PUBLIC,
        UNADOPTED,
        LEFT_OUT(1),
        "syncing: Vivswan/badlist and 1 private repository",
      ),
    },
    {
      reason: "two filters union: a repo passing either selects",
      repo: "modules:uv,modules:release-please",
      rows: [HIDDEN_SERVER_ROW, STEADY_ROW],
      stdout: lines(
        UNREADABLE("Vivswan/badlist"),
        LOCKED,
        UNREADABLE("a private repository"),
        LOCKED_PUBLIC,
        UNADOPTED,
        LEFT_OUT(0),
        "syncing: Vivswan/steady and 1 private repository",
      ),
    },
  ])(
    "dispatched with $repo: $reason",
    ({ repo, rows, stdout }) => {
      const name = `filter-${Bun.hash(repo).toString(16)}`;
      const eventFile = join(root, `${name}-event.json`);
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo } }));
      const r = run(name, { GITHUB_EVENT_PATH: eventFile }, FILTER_FLEET);
      expect(r).toEqual({
        exitCode: 0,
        stdout,
        stderr: "",
        output: `count=${rows?.length ?? 0}\n`,
        rows,
      });
      for (const channel of [r.stdout, r.stderr, r.output]) {
        expect(channel).not.toContain("hidden-server");
        expect(channel).not.toContain("hidden-nomods");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a filter naming no module files.yml knows fails before any probe, naming the roster",
    () => {
      const eventFile = join(root, "filter-unknown-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "public,modules:pagez" } }));
      const r = run("filter-unknown", { GITHUB_EVENT_PATH: eventFile }, FILTER_FLEET);
      expect(r).toEqual({
        exitCode: 1,
        stdout: `::error::1 of 1 module names in the modules: filters is not a module files.yml knows (values withheld - this log is public); the modules are: ${moduleRoster().join(", ")}\n`,
        stderr: "",
        output: "",
        rows: null,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "repo=all selects the same fleet as an empty repo",
    () => {
      const r = run("all-plain", { ONLY_REPO: "all" });
      expect(r.exitCode).toBe(0);
      expect(r.rows).toEqual(main.rows);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a private repo's hard adoption failure names no slug, wherever the slug hid",
    () => {
      // The stub's error text carries the slug in a URL, the bare name, and
      // an uppercase variant; the failure must surface (exit 1) with every
      // spelling scrubbed.
      const eventFile = join(root, "hidden-blocked-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-blocked" } }));
      const r = run("hidden-blocked", { GITHUB_EVENT_PATH: eventFile }, [
        ...discovered,
        { repo: "Vivswan/hidden-blocked", private: true },
      ]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain("adoption check failed for a private repository");
      expect(r.stdout).toContain("https://api.github.com/repos/a private repository failed");
      for (const channel of [r.stdout, r.stderr, r.output]) {
        expect(channel.toLowerCase()).not.toContain("hidden-blocked");
        expect(channel.toLowerCase()).not.toContain("hidden-billing");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
