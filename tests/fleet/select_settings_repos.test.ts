import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  notAdoptedNotice,
  notRenderedNotice,
  PRIVATE_DISPLAY,
  pushProbeSkipNotice,
} from "../../.github/scripts/fleet/discovery.ts";
import { supersededNotice } from "../../.github/scripts/fleet/newest_main.ts";
import { maskForms } from "../../.github/scripts/shared/mask.ts";
import { moduleRoster } from "../../.github/scripts/sync/modules.ts";
import { matrixRows, rowKeyOf } from "../../.github/scripts/sync/resolve_row.ts";
import { RENDERED_HEADER } from "../../.github/scripts/sync/writer/settings_entry.ts";
import { tempDirs } from "../shared/temp_dir";

const SHA = "8096c4920f84ec4122d14c5bd884703dd0d382ba";
const NEWER_SHA = "0f1e2d3c4b5a69788796a5b4c3d2e1f0a1b2c3d4";

const temp = tempDirs();

// End-to-end harness against stub `gh` and `curl` on PATH; PROBE_RETRY_DELAY_MS is zeroed so the retry loop costs no wall time.
// PRIVATE personas' every public line says "a private repository" while the masks cover the slug,
// and the matrix output names no target at all: each row rides as its index and the plan's key.
const PERSONAS: { name: string; private: boolean }[] = [
  { name: "deadapi", private: false },
  { name: "deadprobe", private: false },
  { name: "flaky", private: false },
  { name: "handwritten", private: false },
  { name: "hidden-deadapi", private: true },
  { name: "hidden-locked", private: true },
  { name: "hidden-nomods", private: true },
  { name: "hidden-server", private: true },
  { name: "hidden-unrendered", private: true },
  { name: "locked", private: false },
  { name: "nomodule", private: false },
  { name: "repo-platform", private: false },
  { name: "steady", private: false },
  { name: "unadopted", private: false },
  { name: "unrendered", private: false },
];
const PRIVATE_SLUGS = PERSONAS.filter((p) => p.private).map((p) => `Vivswan/${p.name}`);
const RUN_ID = "4242";
const keyOf = rowKeyOf("stub-token", RUN_ID);

describe("select_settings_repos.ts", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/select_settings_repos.ts");
  const root = temp.dir("select-settings-");
  const bin = join(root, "bin");

  beforeAll(() => {
    mkdirSync(bin);
    const listing = PERSONAS.map(
      (p) =>
        `{"full_name":"Vivswan/${p.name}","private":${p.private},"archived":false,"owner":{"login":"Vivswan"},"permissions":{"push":true}}`,
    ).join(",");
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/usr/bin/env bash",
        'if [ "$2" = "user/repos" ]; then',
        '  if [ -n "$STUB_FAIL_DISCOVERY" ]; then',
        '    echo "HTTP 500 from stub" >&2',
        "    exit 1",
        "  fi",
        `  printf '[[%s]]\\n' '${listing}'`,
        "  exit 0",
        "fi",
        'case "$2" in',
        "  repos/Vivswan/flaky/contents/.repo-platform.yml)",
        '    if [ -e "$STUB_STATE/flaky-opt-in" ]; then echo "modules: [settings-sync]"; exit 0; fi',
        '    touch "$STUB_STATE/flaky-opt-in"',
        '    echo "HTTP 502 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/flaky/contents/.github/settings.yml)",
        `    if [ -e "$STUB_STATE/flaky-rendered" ]; then echo "${RENDERED_HEADER}"; exit 0; fi`,
        '    touch "$STUB_STATE/flaky-rendered"',
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
        "  repos/Vivswan/repo-platform/contents/.repo-platform.yml)",
        '    echo "modules: [bun, pr-title]"',
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
        // three to the display.
        "  repos/Vivswan/hidden-deadapi/contents/.repo-platform.yml)",
        '    echo "HTTP 502: https://api.github.com/repos/Vivswan/hidden-deadapi bad gateway; HIDDEN-DEADAPI unreachable" >&2',
        "    exit 1",
        "    ;;",
        "  repos/*/contents/.repo-platform.yml)",
        '    echo "modules: [settings-sync]"',
        "    ;;",
        "  repos/Vivswan/unrendered/contents/.github/settings.yml|repos/Vivswan/hidden-unrendered/contents/.github/settings.yml)",
        '    echo "HTTP 404 from stub" >&2',
        "    exit 1",
        "    ;;",
        "  repos/Vivswan/handwritten/contents/.github/settings.yml)",
        '    printf "repository:\\n  description: mine\\n"',
        "    ;;",
        // The rendered document: the header line, then target-owned
        // content the selector must never print.
        "  repos/*/contents/.github/settings.yml)",
        `    printf '%s\\n# Rendered by the sync\\nrepository:\\n  description: %s\\n' "${RENDERED_HEADER}" "$2"`,
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
    // The newest-wins read: main's tip is STUB_MAIN_TIP (the run's own
    // commit unless a test moves it), or a dead remote.
    writeFileSync(
      join(bin, "git"),
      [
        "#!/usr/bin/env bash",
        '[ "$1" = "ls-remote" ] || { echo "stub git: unexpected $*" >&2; exit 64; }',
        'if [ -n "$STUB_GIT_FAIL" ]; then',
        "  echo \"fatal: unable to access 'origin': Could not resolve host\" >&2",
        "  exit 128",
        "fi",
        'printf "%s\\trefs/heads/main\\n" "$STUB_MAIN_TIP"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
  });

  interface Run {
    exitCode: number;
    /** stdout without the leading ::add-mask:: lines. */
    stdout: string;
    /** The values the ::add-mask:: lines registered, in order. */
    masked: string[];
    stderr: string;
    output: string;
    summary: string;
  }

  // A cold start pushed the spawning hooks past bun-test's default 5s cap;
  // SPAWN_TIMEOUT_MS turns a wedged child into a diagnostic throw and
  // TEST_TIMEOUT_MS sits above it so that throw beats bun's value-free kill.
  const SPAWN_TIMEOUT_MS = 15_000;
  const TEST_TIMEOUT_MS = 20_000;

  function run(name: string, env: Record<string, string> = {}): Run {
    const work = join(root, `work-${name}`);
    mkdirSync(join(work, "state"), { recursive: true });
    const outputFile = join(work, "output.txt");
    const summaryFile = join(work, "summary.md");
    writeFileSync(outputFile, "");
    writeFileSync(summaryFile, "");
    const proc = Bun.spawnSync(["bun", script], {
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      cwd: work,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PAT: "stub-token",
        PROBE_RETRY_DELAY_MS: "0",
        GH_TOKEN: "stub-token",
        OWNER: "Vivswan",
        GITHUB_RUN_ID: RUN_ID,
        GITHUB_SHA: SHA,
        STUB_MAIN_TIP: SHA,
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        STUB_STATE: join(work, "state"),
        // The spread above carries CI's real event file; the dispatch
        // tests supply their own.
        GITHUB_EVENT_PATH: "",
        ONLY_REPO: "",
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
        `select_settings_repos.ts (run "${name}") ${cause}\n` +
          `${proc.stdout.toString()}${proc.stderr.toString()}`,
      );
    }
    const lines = proc.stdout.toString().split("\n");
    const masked: string[] = [];
    while (lines[0]?.startsWith("::add-mask::")) {
      masked.push((lines.shift() as string).slice("::add-mask::".length));
    }
    return {
      exitCode: proc.exitCode,
      stdout: lines.join("\n"),
      masked,
      stderr: proc.stderr.toString(),
      output: readFileSync(outputFile, "utf-8"),
      summary: readFileSync(summaryFile, "utf-8"),
    };
  }

  /** The whole output file read back: the count, and the matrix's rows read back to slugs the way
   *  the resolver reads them (each key matched against the personas' keys under the stub token and
   *  run id), in the selector's order. The matrix text names no target. */
  function outputsOf(result: Run): { count: string; repos: (string | null)[] } {
    const count = /^count=(.*)$/m.exec(result.output)?.[1];
    const matrix = /^matrix=(.*)$/m.exec(result.output)?.[1];
    if (count === undefined || matrix === undefined) {
      throw new Error(`no count= and matrix= lines in: ${result.output}`);
    }
    expect(result.output).toBe(`count=${count}\nmatrix=${matrix}\n`);
    for (const form of PRIVATE_SLUGS.flatMap(maskForms)) expect(matrix).not.toContain(form);
    const rows = JSON.parse(matrix) as { row: number; key: string }[];
    expect(rows.map((row) => row.row)).toEqual(rows.map((_, index) => index));
    const slugs = PERSONAS.map((persona) => `Vivswan/${persona.name}`);
    return {
      count,
      repos: rows.map((row) => slugs.find((slug) => keyOf(slug) === row.key) ?? null),
    };
  }

  /** The public channels a private slug may never reach: the log (masks aside), stderr, the step
   *  summary, and the output file (its matrix becomes a job output, which the run's views show). */
  function publicChannels(result: Run): string[] {
    return [result.stdout, result.stderr, result.summary, result.output];
  }

  let main: Run;
  beforeAll(() => {
    main = run("main");
  }, TEST_TIMEOUT_MS);

  const RETRY = (display: string, probe: string, detail: string) =>
    [1, 2].map(
      (attempt) => `${display}: ${probe} failed (attempt ${attempt}/3: ${detail}); retrying...`,
    );
  const GAVE_UP = (display: string, probe: string, detail: string) =>
    `${display}: the ${probe} failed 3 times (last error: ${detail}) - no answer, so the repo is skipped this run; the nightly apply retries it. If this persists, check the repo's availability and the fleet token.`;
  const DEADAPI_DETAIL = "HTTP 502 from stub";
  const DEADPROBE_DETAIL = "HTTP 500";
  const HIDDEN_DEADAPI_DETAIL = `HTTP 502: https://api.github.com/repos/${PRIVATE_DISPLAY} bad gateway; ${PRIVATE_DISPLAY} unreachable`;
  const NOMODS_WARNING =
    `${PRIVATE_DISPLAY}: its .repo-platform.yml has no readable top-level modules list, so the ` +
    "modules filter cannot judge it - left out of this run; fix the file (the sync would fail on " +
    "it too), then dispatch the repo by slug or re-run.";
  const UNADOPTED_NOTICE = notAdoptedNotice(
    "Vivswan/unadopted",
    "The settings apply only manages adopted repos.",
  );
  const lines = (...items: string[]) => items.map((text) => `${text}\n`).join("");
  const summaryOf = (...warnings: string[]) =>
    warnings.length === 0
      ? ""
      : `### Settings apply warnings\n${warnings.map((line) => `- ${line}\n`).join("")}`;

  // Every public persona's probe output, in slug order; the rendered probe
  // runs after the modules filter, so a filter run never reaches flaky's
  // third retry or the un-rendered notices.
  const PUBLIC_PROBES_HEAD = [
    ...RETRY("Vivswan/deadapi", "adoption check", DEADAPI_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadapi", "adoption check", DEADAPI_DETAIL)}`,
    ...RETRY("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
    `::warning::${GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL)}`,
    "Vivswan/flaky: push-permission probe failed (attempt 1/3: HTTP 500); retrying...",
    "Vivswan/flaky: adoption check failed (attempt 1/3: HTTP 502 from stub); retrying...",
  ];
  const PUBLIC_PROBES = [
    ...PUBLIC_PROBES_HEAD,
    "Vivswan/flaky: rendered settings check failed (attempt 1/3: HTTP 502 from stub); retrying...",
    `::notice::${notRenderedNotice("Vivswan/handwritten")}`,
  ];
  const PUBLIC_PROBES_TAIL_HEAD = [
    `::notice::${pushProbeSkipNotice("Vivswan/locked")}`,
    `::notice::${UNADOPTED_NOTICE}`,
  ];
  const PUBLIC_PROBES_TAIL = [
    ...PUBLIC_PROBES_TAIL_HEAD,
    `::notice::${notRenderedNotice("Vivswan/unrendered")}`,
  ];
  const PUBLIC_WARNINGS = [
    GAVE_UP("Vivswan/deadapi", "adoption check", DEADAPI_DETAIL),
    GAVE_UP("Vivswan/deadprobe", "push-permission probe", DEADPROBE_DETAIL),
  ];
  // Every private persona's, named only as a private repository.
  const PRIVATE_PROBES_HEAD = [
    ...RETRY(PRIVATE_DISPLAY, "adoption check", HIDDEN_DEADAPI_DETAIL),
    `::warning::${GAVE_UP(PRIVATE_DISPLAY, "adoption check", HIDDEN_DEADAPI_DETAIL)}`,
    `::notice::${pushProbeSkipNotice(PRIVATE_DISPLAY)}`,
  ];
  const PRIVATE_PROBES = [
    ...PRIVATE_PROBES_HEAD,
    `::notice::${notRenderedNotice(PRIVATE_DISPLAY)}`,
  ];
  const PRIVATE_WARNINGS = [GAVE_UP(PRIVATE_DISPLAY, "adoption check", HIDDEN_DEADAPI_DETAIL)];
  const ALL_PROBES = [...PUBLIC_PROBES, ...PRIVATE_PROBES, ...PUBLIC_PROBES_TAIL];
  const ALL_WARNINGS = [...PUBLIC_WARNINGS, ...PRIVATE_WARNINGS];
  const PUBLIC_TARGETS = [
    "Vivswan/flaky",
    "Vivswan/nomodule",
    "Vivswan/repo-platform",
    "Vivswan/steady",
  ];
  const PRIVATE_TARGETS = ["Vivswan/hidden-nomods", "Vivswan/hidden-server"];
  const ALL_TARGETS = [
    "Vivswan/flaky",
    "Vivswan/hidden-nomods",
    "Vivswan/hidden-server",
    "Vivswan/nomodule",
    "Vivswan/repo-platform",
    "Vivswan/steady",
  ];

  test("the whole fleet: flaky probes retried, dead ones warned, un-rendered and unadopted repos skipped, self selected", () => {
    // Adoption and a rendered document are the opt-in: a declaration still
    // naming settings-sync (steady) and one that never did (nomodule) select
    // alike; the operator repository rides in like any other target.
    expect({ ...main, masked: main.masked.length > 0 }).toEqual({
      exitCode: 0,
      stdout: lines(
        ...ALL_PROBES,
        "settings targets: Vivswan/flaky, Vivswan/nomodule, Vivswan/repo-platform, Vivswan/steady and 2 private repositories",
      ),
      masked: true,
      stderr: "",
      output: expect.stringMatching(/^count=6\nmatrix=\[\{"row":0,"key":"/),
      summary: summaryOf(...ALL_WARNINGS),
    });
    expect(outputsOf(main)).toEqual({ count: "6", repos: ALL_TARGETS });
  });

  test("every discovered private slug is masked in every spelling before anything else prints", () => {
    for (const slug of PRIVATE_SLUGS) {
      for (const form of maskForms(slug)) expect(main.masked).toContain(form);
    }
    expect(main.masked).toHaveLength(PRIVATE_SLUGS.flatMap(maskForms).length);
    // The masks are the first lines: the run() split above consumed them
    // all, so no add-mask line remains anywhere in the log.
    expect(main.stdout).not.toContain("::add-mask::");
    for (const channel of publicChannels(main)) {
      expect(channel.toLowerCase()).not.toContain("hidden-");
    }
    // The stub's rendered document names its slug; the selector reads the
    // header only and never prints the content.
    expect(main.stdout).not.toContain("# Rendered by the sync");
    expect(main.stdout).not.toContain("description:");
  });

  test("the matrix is the plan's keyed rows: N rows for N targets, each an index and the key its resolver matches, no slug in the text", () => {
    const rows = ALL_TARGETS.map((repo) => ({ repo, private: repo.includes("/hidden-") }));
    expect(main.output).toBe(`count=6\nmatrix=${JSON.stringify(matrixRows(rows, keyOf))}\n`);
    expect(outputsOf(main)).toEqual({ count: "6", repos: ALL_TARGETS });
    for (const persona of PERSONAS) {
      expect(main.output.toLowerCase()).not.toContain(persona.name);
    }
  });

  test(
    "a private dispatch input arrives via the event payload and never prints",
    () => {
      // The workflow passes no ONLY_REPO env (the runner would print it);
      // the script reads the typed input from GITHUB_EVENT_PATH instead.
      const eventFile = join(root, "dispatch-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-server" } }));
      const r = run("dispatch", { GITHUB_EVENT_PATH: eventFile });
      expect({ ...r, masked: r.masked.length, output: outputsOf(r) }).toEqual({
        exitCode: 0,
        stdout: lines("settings targets: 1 private repository"),
        masked: PRIVATE_SLUGS.flatMap(maskForms).length,
        stderr: "",
        output: { count: "1", repos: ["Vivswan/hidden-server"] },
        summary: "",
      });
      for (const channel of publicChannels(r)) expect(channel).not.toContain("hidden-server");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a bare name scopes the apply, the operator repository's own included",
    () => {
      const r = run("dispatch-self", { ONLY_REPO: "repo-platform" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(lines("settings targets: Vivswan/repo-platform"));
      expect(outputsOf(r)).toEqual({ count: "1", repos: ["Vivswan/repo-platform"] });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a mistyped dispatch input is refused as unknown without echoing the input",
    () => {
      const eventFile = join(root, "dispatch-miss-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "Vivswan/hidden-servr" } }));
      const r = run("dispatch-miss", { GITHUB_EVENT_PATH: eventFile });
      expect({ ...r, masked: r.masked.length }).toEqual({
        exitCode: 1,
        stdout:
          "::error::1 of 1 scoped repos matched no fleet repository (values withheld - they may be " +
          "private slugs): not among the fleet token's pushable repositories under Vivswan - the grant " +
          "was revoked, the repository is archived or owned by someone else, or the slug is misspelled " +
          "(matching ignores case)\n",
        masked: PRIVATE_SLUGS.flatMap(maskForms).length,
        stderr: "",
        output: "",
        summary: "",
      });
      for (const channel of publicChannels(r)) expect(channel).not.toContain("hidden-servr");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a failed discovery fails the whole run before any mask or output",
    () => {
      // Discovery exits with gh's own code and forwards its stderr.
      const r = run("no-discovery", { STUB_FAIL_DISCOVERY: "1" });
      expect(r).toEqual({
        exitCode: 1,
        stdout: "",
        masked: [],
        stderr: "HTTP 500 from stub\n",
        output: "",
        summary: "",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a run whose commit main moved past stands down with an empty plan, before any discovery",
    () => {
      const r = run("superseded", { STUB_MAIN_TIP: NEWER_SHA, ONLY_REPO: "all" });
      expect(r).toEqual({
        exitCode: 0,
        stdout: lines(`::notice::${supersededNotice(SHA, NEWER_SHA)}`),
        masked: [],
        stderr: "",
        output: `count=0\nmatrix=${JSON.stringify(matrixRows([], keyOf))}\n`,
        summary: "",
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a tip that cannot be read fails the run, never guessing newest or superseded",
    () => {
      const r = run("no-tip", { STUB_GIT_FAIL: "1" });
      expect(r).toEqual({
        exitCode: 1,
        stdout: lines(
          "::error::git ls-remote for refs/heads/main could not answer (exit 128); refusing to guess: fatal: unable to access 'origin': Could not resolve host",
        ),
        masked: [],
        stderr: "",
        output: "",
        summary: "",
      });
    },
    TEST_TIMEOUT_MS,
  );

  // The scope as the call input passes it (ONLY_REPO; post-green's settings-fleet leg sends
  // `all`). Whole outcome per scope: every log line, the summary, the outputs.
  test.each<{ reason: string; scope: string; repos: string[]; stdout: string; summary: string }>([
    {
      reason: "a public slug selects it alone, and slugs alone never probe other repos",
      scope: "Vivswan/steady",
      repos: ["Vivswan/steady"],
      stdout: lines("settings targets: Vivswan/steady"),
      summary: "",
    },
    {
      reason: "public selects the public repos, self included, and probes only them",
      scope: "public",
      repos: PUBLIC_TARGETS,
      stdout: lines(
        ...PUBLIC_PROBES,
        ...PUBLIC_PROBES_TAIL,
        `settings targets: ${PUBLIC_TARGETS.join(", ")}`,
      ),
      summary: summaryOf(...PUBLIC_WARNINGS),
    },
    {
      reason: "private selects the private repos, every line naming only a private repository",
      scope: "private",
      repos: PRIVATE_TARGETS,
      stdout: lines(...PRIVATE_PROBES, "settings targets: 2 private repositories"),
      summary: summaryOf(...PRIVATE_WARNINGS),
    },
    {
      reason: "a token unions with a slug",
      scope: "private, Vivswan/steady",
      repos: [...PRIVATE_TARGETS, "Vivswan/steady"],
      stdout: lines(
        ...PRIVATE_PROBES,
        "settings targets: Vivswan/steady and 2 private repositories",
      ),
      summary: summaryOf(...PRIVATE_WARNINGS),
    },
  ])(
    "called with $scope: $reason",
    ({ scope, repos, stdout, summary }) => {
      const r = run(`called-${Bun.hash(scope).toString(16)}`, { ONLY_REPO: scope });
      expect({ ...r, masked: r.masked.length, output: outputsOf(r) }).toEqual({
        exitCode: 0,
        stdout,
        masked: PRIVATE_SLUGS.flatMap(maskForms).length,
        stderr: "",
        output: { count: String(repos.length), repos },
        summary,
      });
      for (const channel of publicChannels(r)) expect(channel).not.toContain("hidden-");
    },
    TEST_TIMEOUT_MS,
  );

  // The modules: filters, dispatched. A repo the filter leaves out is counted, never named,
  // so each exact count rests on the module lists the stub gh declares above.
  const LEFT_OUT = (count: number) =>
    `modules filter: ${count} adopted ${count === 1 ? "repo" : "repos"} left out (selecting none of the listed module sets)`;
  const FILTER_PROBES = [
    ...PUBLIC_PROBES_HEAD,
    ...PRIVATE_PROBES_HEAD,
    `::warning::${NOMODS_WARNING}`,
    ...PUBLIC_PROBES_TAIL_HEAD,
  ];
  test.each<{ reason: string; repo: string; repos: string[]; stdout: string; summary: string }>([
    {
      reason:
        "a filter alone probes every visibility and keeps the repos selecting the module; an unreadable list is warned, not counted",
      repo: "modules:uv",
      repos: ["Vivswan/hidden-server", "Vivswan/nomodule"],
      stdout: lines(
        ...FILTER_PROBES,
        LEFT_OUT(6),
        "settings targets: Vivswan/nomodule and 1 private repository",
      ),
      summary: summaryOf(...ALL_WARNINGS, NOMODS_WARNING),
    },
    {
      reason: "a visibility token intersects: only public candidates are probed",
      repo: "public,modules:release-please",
      repos: ["Vivswan/nomodule"],
      stdout: lines(
        ...PUBLIC_PROBES_HEAD,
        ...PUBLIC_PROBES_TAIL_HEAD,
        LEFT_OUT(5),
        "settings targets: Vivswan/nomodule",
      ),
      summary: summaryOf(...PUBLIC_WARNINGS),
    },
    {
      reason: "a bare name unions in as typed, its selection unread",
      repo: "steady,modules:bun",
      repos: ["Vivswan/repo-platform", "Vivswan/steady"],
      stdout: lines(
        ...FILTER_PROBES,
        LEFT_OUT(6),
        "settings targets: Vivswan/repo-platform, Vivswan/steady",
      ),
      summary: summaryOf(...ALL_WARNINGS, NOMODS_WARNING),
    },
  ])(
    "dispatched with $repo: $reason",
    ({ repo, repos, stdout, summary }) => {
      const name = `filter-${Bun.hash(repo).toString(16)}`;
      const eventFile = join(root, `${name}-event.json`);
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo } }));
      const r = run(name, { GITHUB_EVENT_PATH: eventFile });
      expect({ ...r, masked: r.masked.length, output: outputsOf(r) }).toEqual({
        exitCode: 0,
        stdout,
        masked: PRIVATE_SLUGS.flatMap(maskForms).length,
        stderr: "",
        output: { count: String(repos.length), repos },
        summary,
      });
      for (const channel of publicChannels(r))
        expect(channel.toLowerCase()).not.toContain("hidden-");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a filter naming no module of files.yml fails before discovery, naming the roster",
    () => {
      const eventFile = join(root, "filter-unknown-event.json");
      writeFileSync(eventFile, JSON.stringify({ inputs: { repo: "modules:uv+pagez" } }));
      const r = run("filter-unknown", { GITHUB_EVENT_PATH: eventFile });
      expect(r).toEqual({
        exitCode: 1,
        stdout: `::error::1 of 2 module names in the modules: filters is not a module files.yml knows (values withheld - this log is public); the modules are: ${moduleRoster().join(", ")}\n`,
        masked: [],
        stderr: "",
        output: "",
        summary: "",
      });
    },
    TEST_TIMEOUT_MS,
  );

  // The two transports of one scope meet at readDispatchRepo; past it the selector cannot tell them apart.
  const LIST = "Vivswan/steady, vivswan/hidden-server";
  test.each<{ transport: string; env: () => Record<string, string> }>([
    { transport: "the call input", env: () => ({ ONLY_REPO: LIST }) },
    {
      transport: "the dispatch payload",
      env: () => {
        const eventFile = join(root, "dispatch-list-event.json");
        writeFileSync(eventFile, JSON.stringify({ inputs: { repo: LIST } }));
        return { GITHUB_EVENT_PATH: eventFile };
      },
    },
  ])(
    "a slug list from $transport selects every listed target, the private one counted, never named",
    ({ transport, env }) => {
      const r = run(`list-${Bun.hash(transport).toString(16)}`, env());
      expect({ ...r, masked: r.masked.length, output: outputsOf(r) }).toEqual({
        exitCode: 0,
        stdout: lines("settings targets: Vivswan/steady and 1 private repository"),
        masked: PRIVATE_SLUGS.flatMap(maskForms).length,
        stderr: "",
        output: { count: "2", repos: ["Vivswan/hidden-server", "Vivswan/steady"] },
        summary: "",
      });
      for (const channel of publicChannels(r)) expect(channel).not.toContain("hidden-server");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    '"all" is the whole fleet, byte-identical to no scope at all',
    () => {
      const r = run("all", { ONLY_REPO: "all" });
      expect({ ...r, output: outputsOf(r) }).toEqual({ ...main, output: outputsOf(main) });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a list with one unknown entry fails the whole run, counting rather than naming",
    () => {
      const r = run("list-miss", { ONLY_REPO: "Vivswan/steady,Vivswan/hidden-servr" });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain(
        "::error::1 of 2 scoped repos matched no fleet repository (values withheld",
      );
      expect(r.output).toBe("");
      for (const channel of publicChannels(r)) expect(channel).not.toContain("hidden-servr");
    },
    TEST_TIMEOUT_MS,
  );

  test.each([
    {
      reason: "an unadopted repo",
      scope: "Vivswan/unadopted",
      notice: UNADOPTED_NOTICE,
    },
    {
      reason: "a repo whose settings the sync has not rendered yet",
      scope: "Vivswan/unrendered",
      notice: notRenderedNotice("Vivswan/unrendered"),
    },
    {
      reason: "a repo with a hand-written settings.yml",
      scope: "Vivswan/handwritten",
      notice: notRenderedNotice("Vivswan/handwritten"),
    },
  ])(
    "a scope selecting only $reason selects nothing: green, the notice, count 0, an empty matrix",
    ({ scope, notice }) => {
      // A scoped run may legitimately select nothing: the settings apply
      // that follows a fleet sync must not go red for a target whose sync
      // PR has not merged. Count 0 skips the apply job; the empty matrix
      // is still valid JSON for its fromJSON.
      const r = run(`none-${Bun.hash(scope).toString(16)}`, { ONLY_REPO: scope });
      expect({ ...r, masked: r.masked.length }).toEqual({
        exitCode: 0,
        stdout: lines(
          `::notice::${notice}`,
          "::notice::no settings targets selected; nothing to apply.",
        ),
        masked: PRIVATE_SLUGS.flatMap(maskForms).length,
        stderr: "",
        output: "count=0\nmatrix=[]\n",
        summary: "",
      });
      expect(outputsOf(r)).toEqual({ count: "0", repos: [] });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "an empty scope entry is refused before discovery, so it can neither widen nor narrow the scope",
    () => {
      const r = run("list-empty", { ONLY_REPO: "Vivswan/steady,,Vivswan/flaky" });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("::error::the scope has an empty entry");
      expect(r.masked).toEqual([]);
      expect(r.summary).toBe("");
      expect(r.output).toBe("");
    },
    TEST_TIMEOUT_MS,
  );
});
