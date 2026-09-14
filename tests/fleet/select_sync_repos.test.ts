import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  notAdoptedNotice,
  PRIVATE_DISPLAY,
  pushProbeSkipNotice,
} from "../../.github/scripts/fleet/discovery.ts";
import { moduleRoster } from "../../.github/scripts/fleet/modules.ts";
import { matrixRows, rowKeyOf } from "../../.github/scripts/sync/resolve_row.ts";
import { ROWS_FILE } from "../../.github/scripts/sync/verdict.ts";
import { tempDirs } from "../shared/temp_dir";

const RUN_ID = "4242";
const keyOf = rowKeyOf("stub-token", RUN_ID);
const outputFor = (rows: { repo: string; private: boolean }[]) =>
  `count=${rows.length}\nmatrix=${JSON.stringify(matrixRows(rows, keyOf))}\n`;

const temp = tempDirs();

// End-to-end harness for the sync fan-out selector against stub gh and curl on PATH (the bounds rationale is
// select_settings_repos.test.ts's). The personas carry the facts the stubs cannot show:
//   private ones                  -> never reach the public log: skips counted, the rows file alone carries their slugs
//   locked (403), ungranted (404) -> the push advertisement's two "no grant" answers: a notice each, never a retry or a failure
//   deadprobe (500)               -> a transport answer fails the plan, so it is admitted only in the row expecting that
//   badlist, hidden-nomods        -> unreadable modules lists, filter runs only: anywhere else they would select and shift each exact row list
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
    { repo: "Vivswan/ungranted", private: false },
  ];
  const DEADPROBE = { repo: "Vivswan/deadprobe", private: false };
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
        '  *"/Vivswan/ungranted.git/"*) printf 404 ;;',
        '  *"/Vivswan/deadprobe.git/"*) printf 500 ;;',
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
        OWNER: "Vivswan",
        GITHUB_REPOSITORY: "Vivswan/repo-platform",
        ONLY_REPO: "",
        // Neutralize the real event payload CI runs carry; the dispatch
        // tests set their own.
        GITHUB_EVENT_PATH: "",
        GITHUB_RUN_ID: RUN_ID,
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

  /** The dispatch transport: the typed inputs ride the event payload on disk, never step env, which the runner prints. */
  function payloadEnv(name: string, inputs: Record<string, string>): Record<string, string> {
    const eventFile = join(root, `${name}-event.json`);
    writeFileSync(eventFile, JSON.stringify({ inputs }));
    return { GITHUB_EVENT_PATH: eventFile };
  }

  /** The public channels a private slug (or a branch name, which may name private work) must never reach. */
  const publicChannels = (r: Run) => [r.stdout, r.stderr, r.output];

  /** One `::error::` line opening with `prefix`; the count-only messages themselves are sync_scope.test.ts's. */
  const errorLine = (prefix: string) =>
    expect.stringMatching(new RegExp(`^::error::${RegExp.escape(prefix)}[^\\n]*\\n$`));

  const HIDDEN_SERVER_ROW = { repo: "Vivswan/hidden-server", private: true };
  const STEADY_ROW = { repo: "Vivswan/steady", private: false };
  const BADLIST_ROW = { repo: "Vivswan/badlist", private: false };
  const BRANCH = "feat/add-hidden-module";

  const lines = (...notices: string[]) => notices.map((text) => `${text}\n`).join("");
  const UNADOPTED = `::notice::${notAdoptedNotice("Vivswan/unadopted")}`;
  const LOCKED = `::notice::${pushProbeSkipNotice(PRIVATE_DISPLAY)}`;
  const LOCKED_PUBLIC = `::notice::${pushProbeSkipNotice("Vivswan/locked")}`;
  const UNGRANTED = `::notice::${pushProbeSkipNotice("Vivswan/ungranted")}`;
  const UNREADABLE = (display: string) =>
    `::warning::${display}: its .repo-platform.yml has no readable top-level modules list, so the modules filter cannot judge it - left out of this run; fix the file (the sync would fail on it too), then dispatch the repo by slug or re-run.`;
  const LEFT_OUT = (count: number) =>
    `modules filter: ${count} adopted ${count === 1 ? "repo" : "repos"} left out (selecting none of the listed module sets)`;

  let main: Run;
  beforeAll(() => {
    main = run("main");
  }, TEST_TIMEOUT_MS);

  test("the whole fleet: the rows file carries the real slugs, sorted, with the visibility; the log and the output name no private repository", () => {
    // Cross-file: the fan-out reads the rows file by ROWS_FILE (sync/verdict.ts) and matches each matrix key with
    // rowKeyOf (sync/resolve_row.ts); the job output is public, so it carries the count and the keyed rows alone.
    const rows = [HIDDEN_SERVER_ROW, STEADY_ROW];
    expect(main).toEqual({
      exitCode: 0,
      stdout: lines(
        LOCKED,
        LOCKED_PUBLIC,
        UNADOPTED,
        UNGRANTED,
        "syncing: Vivswan/steady and 1 private repository",
      ),
      stderr: "",
      output: outputFor(rows),
      rows,
    });
    for (const channel of publicChannels(main)) {
      expect(channel).not.toContain("hidden-server");
      expect(channel).not.toContain("hidden-locked");
    }
  });

  // The scope as the call input passes it (ONLY_REPO; post-green's sync-fleet leg sends `public` or `all`), or as the
  // dispatch payload, which may name a private repository or a branch of private work and so never prints.
  test.each<{
    reason: string;
    scope: string;
    env: (name: string) => Record<string, string>;
    rows: Run["rows"];
    stdout: string;
    withheld?: string;
  }>([
    {
      reason: "a public slug list selects exactly those (the unadopted one drops with its notice)",
      scope: "Vivswan/steady,Vivswan/unadopted",
      env: () => ({ ONLY_REPO: "Vivswan/steady,Vivswan/unadopted" }),
      rows: [STEADY_ROW],
      stdout: lines(UNADOPTED, "syncing: Vivswan/steady"),
    },
    {
      reason:
        "public selects the public repos (the two the token cannot push to drop with a notice)",
      scope: "public",
      env: () => ({ ONLY_REPO: "public" }),
      rows: [STEADY_ROW],
      stdout: lines(LOCKED_PUBLIC, UNADOPTED, UNGRANTED, "syncing: Vivswan/steady"),
    },
    {
      reason: "private selects the private repos, counted (the locked one drops on its probe)",
      scope: "private",
      env: () => ({ ONLY_REPO: "private" }),
      rows: [HIDDEN_SERVER_ROW],
      stdout: lines(LOCKED, "syncing: 1 private repository"),
    },
    {
      reason: "a token unions with a slug",
      scope: "private, Vivswan/steady",
      env: () => ({ ONLY_REPO: "private, Vivswan/steady" }),
      rows: [HIDDEN_SERVER_ROW, STEADY_ROW],
      stdout: lines(LOCKED, "syncing: Vivswan/steady and 1 private repository"),
    },
    {
      reason: "a slug list selects every listed repo, the private one counted, never named",
      scope: "Vivswan/steady,Vivswan/hidden-server",
      env: () => ({ ONLY_REPO: "Vivswan/steady,Vivswan/hidden-server" }),
      rows: [HIDDEN_SERVER_ROW, STEADY_ROW],
      stdout: lines("syncing: Vivswan/steady and 1 private repository"),
    },
    {
      reason: "a private slug from the dispatch payload selects it and never prints",
      scope: "Vivswan/hidden-server",
      env: (name) => payloadEnv(name, { repo: "Vivswan/hidden-server" }),
      rows: [HIDDEN_SERVER_ROW],
      stdout: lines("syncing: 1 private repository"),
    },
    {
      reason:
        "a branch dispatch over one repository selects that row and nothing else; the branch never prints",
      scope: "Vivswan/steady",
      env: (name) => payloadEnv(name, { repo: "Vivswan/steady", branch: BRANCH }),
      rows: [STEADY_ROW],
      stdout: lines("syncing: Vivswan/steady"),
      withheld: BRANCH,
    },
  ])(
    "$scope: $reason",
    ({ reason, env, rows, stdout, withheld }) => {
      const name = `called-${Bun.hash(reason).toString(16)}`;
      const r = run(name, env(name));
      expect(r).toEqual({ exitCode: 0, stdout, stderr: "", output: outputFor(rows ?? []), rows });
      for (const channel of publicChannels(r)) {
        expect(channel).not.toContain("hidden-server");
        if (withheld !== undefined) expect(channel).not.toContain(withheld);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // A refused plan echoes no entry: an entry may be a private slug and this log is public. A push probe answering neither
  // 200 nor a permission code is refused too: probed for adoption instead, the repository would be selected and the
  // writer's push would fail per row, late; that refusal names its repository, which the probe already judged public.
  test.each<{
    reason: string;
    scope: string;
    transport: "the call input" | "the dispatch payload";
    branch?: string;
    manual?: boolean;
    discoveredList?: typeof discovered;
    error: string;
    /** The one entry the refusal may name, when the selector has already read it as public. */
    named?: string;
  }>([
    {
      reason: "a list with one miss fails the whole plan",
      scope: "Vivswan/steady,Vivswan/hidden-servr",
      transport: "the call input",
      error: "1 of 2 scoped repos matched no fleet repository (values withheld",
    },
    {
      reason: "a mistyped private dispatch input is withheld from the no-match error",
      scope: "Vivswan/hidden-servr",
      transport: "the dispatch payload",
      error: "1 of 1 scoped repos matched no fleet repository (values withheld",
    },
    {
      reason:
        "a slug-only scope whose own slug discovery missed is refused as unknown: not in the fleet is not a skip",
      scope: "Vivswan/steady",
      transport: "the call input",
      discoveredList: discovered.filter((entry) => entry.repo !== "Vivswan/steady"),
      error: "1 of 1 scoped repos matched no fleet repository (values withheld",
    },
    {
      reason: "a filter naming no module files.yml knows fails before any probe, naming the roster",
      scope: "public,modules:pagez",
      transport: "the dispatch payload",
      error: `1 of 1 module names in the modules: filters is not a module files.yml knows (values withheld - this log is public); the modules are: ${moduleRoster().join(", ")}`,
    },
    {
      reason: "a branch dispatch over two repositories",
      scope: "Vivswan/hidden-server,Vivswan/steady",
      transport: "the dispatch payload",
      branch: BRANCH,
      error: "branch takes exactly one owner/name in repo",
    },
    {
      reason: "a branch dispatch beside manual",
      scope: "Vivswan/hidden-server",
      transport: "the dispatch payload",
      branch: BRANCH,
      manual: true,
      error: "manual is meaningless with branch",
    },
    {
      reason: "a push probe answering a transport code fails the plan instead of guessing",
      scope: "Vivswan/deadprobe",
      transport: "the call input",
      discoveredList: [...discovered, DEADPROBE],
      error:
        "push-permission probe for Vivswan/deadprobe failed with HTTP 500; not a permission answer, refusing to guess.",
      named: "Vivswan/deadprobe",
    },
  ])(
    "$reason: refused before any row is written",
    ({ reason, scope, transport, branch, manual, discoveredList = discovered, error, named }) => {
      const name = `refused-${Bun.hash(reason).toString(16)}`;
      const env: Record<string, string> =
        transport === "the call input"
          ? { ONLY_REPO: scope }
          : payloadEnv(name, { repo: scope, ...(branch === undefined ? {} : { branch }) });
      if (manual === true) env.MANUAL = "true";
      const r = run(name, env, discoveredList);
      expect(r).toEqual({
        exitCode: 1,
        stdout: errorLine(error),
        stderr: "",
        output: "",
        rows: null,
      });
      // The selector folds case, so an echo would be lowercased.
      const entries = scope.split(",").map((entry) => entry.trim());
      const withheld = [
        ...entries.filter((entry) => entry.includes("/") && entry !== named),
        ...entries
          .filter((entry) => entry.startsWith("modules:"))
          .flatMap((entry) => entry.slice("modules:".length).split("+")),
        ...(branch === undefined ? [] : [branch]),
      ];
      if (named === undefined) expect(withheld.length).toBeGreaterThan(0);
      for (const channel of publicChannels(r)) {
        for (const value of withheld)
          expect(channel.toLowerCase()).not.toContain(value.toLowerCase());
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The modules: filters, dispatched: the adoption body is read for the list and never printed; a candidate whose list
  // the filter cannot read is left out with a warning (naming it when public); one the filter leaves out is counted.
  // The AND/OR semantics are sync_scope.test.ts's.
  const FILTER_FLEET = [...discovered, HIDDEN_NOMODS, BADLIST];
  test.each<{ reason: string; repo: string; rows: Run["rows"]; stdout: string }>([
    {
      reason:
        "one module selects every visibility that selects it; the two unreadable lists are reported, the private one counted (case folds)",
      repo: "Modules: Site",
      rows: [HIDDEN_SERVER_ROW, STEADY_ROW],
      stdout: lines(
        UNREADABLE("Vivswan/badlist"),
        LOCKED,
        UNREADABLE(PRIVATE_DISPLAY),
        LOCKED_PUBLIC,
        UNADOPTED,
        UNGRANTED,
        LEFT_OUT(0),
        "syncing: Vivswan/steady and 1 private repository",
      ),
    },
    {
      reason: "a filter no private candidate passes selects nothing, green",
      repo: "private,modules:uv",
      rows: [],
      stdout: lines(
        LOCKED,
        UNREADABLE(PRIVATE_DISPLAY),
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
        UNREADABLE(PRIVATE_DISPLAY),
        LOCKED_PUBLIC,
        UNADOPTED,
        UNGRANTED,
        LEFT_OUT(1),
        "syncing: Vivswan/badlist and 1 private repository",
      ),
    },
  ])(
    "dispatched with $repo: $reason",
    ({ repo, rows, stdout }) => {
      const name = `filter-${Bun.hash(repo).toString(16)}`;
      const r = run(name, payloadEnv(name, { repo }), FILTER_FLEET);
      expect(r).toEqual({ exitCode: 0, stdout, stderr: "", output: outputFor(rows ?? []), rows });
      for (const channel of publicChannels(r)) {
        expect(channel).not.toContain("hidden-server");
        expect(channel).not.toContain("hidden-nomods");
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a private repo's hard adoption failure names no slug, wherever the slug hid",
    () => {
      // The stub's error text carries the slug in a URL, the bare name, and an uppercase variant, and its stdout names
      // another private repository: the failure surfaces with every spelling scrubbed and the body unprinted.
      const r = run(
        "hidden-blocked",
        payloadEnv("hidden-blocked", { repo: "Vivswan/hidden-blocked" }),
        [...discovered, { repo: "Vivswan/hidden-blocked", private: true }],
      );
      expect(r).toEqual({
        exitCode: 1,
        stdout: expect.stringMatching(
          /^::error::adoption check failed for a private repository: HTTP 500: https:\/\/api\.github\.com\/repos\/a private repository failed; a private repository unavailable, retry a private repository later%0A\n$/,
        ),
        stderr: "",
        output: "",
        rows: null,
      });
      for (const channel of publicChannels(r)) {
        expect(channel.toLowerCase()).not.toContain("hidden-blocked");
        expect(channel.toLowerCase()).not.toContain("hidden-billing");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
