import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureNetwork,
  parseDiscovered,
  readDispatchAddModules,
  readDispatchBranch,
  readDispatchRepo,
} from "../../.github/scripts/fleet/discovery.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { type FakeReply, spawnFakeGithub } from "../shared/fake_github";
import type { LoopbackServer } from "../shared/loopback_server";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const DISCOVERY = join(import.meta.dir, "../../.github/scripts/fleet/discovery.ts");
const GITHUB = join(import.meta.dir, "../../actions/github-client/github.ts");

/** The whole subprocess outcome of a payload the parser refuses: the process exits with the label and the path, and the
 *  offending value reaches no channel (it may be a private slug). */
function refusal(
  proc: { exitCode: number; stdout: string; stderr: string },
  label: string,
  diagnostic: string,
  path: string | null,
  value: string,
) {
  const line = `^::error::${RegExp.escape(label)}: ${RegExp.escape(diagnostic)}${path === null ? "" : `.*${RegExp.escape(path)}`}`;
  return {
    got: {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      leaked: `${proc.stdout}${proc.stderr}`.includes(value),
    },
    want: { exitCode: 1, stdout: expect.stringMatching(new RegExp(line)), leaked: false },
  };
}

describe("captureNetwork", () => {
  // A SIGKILLed child prints nothing, so the synthesized stderr line is the only trace of the deadline. It names the
  // program and never the argv tail: a real tail carries a private slug.
  test.each<{
    reason: string;
    command: string[];
    timeoutMs: number | undefined;
    outcome: { exited0: boolean; timedOut: boolean; stdout: string; stderr: unknown };
  }>([
    {
      reason: "a hung command dies at expiry with a line naming the program, never its arguments",
      command: ["sleep", "31337"],
      timeoutMs: 250,
      outcome: {
        exited0: false,
        timedOut: true,
        stdout: "",
        stderr: expect.stringMatching(/^sleep timed out after 250ms \(stalled network\?\)\n$/),
      },
    },
    {
      reason: "a command that answers in time is untouched by the deadline",
      command: ["echo", "ok"],
      timeoutMs: undefined,
      outcome: { exited0: true, timedOut: false, stdout: "ok\n", stderr: "" },
    },
  ])("$reason", ({ command, timeoutMs, outcome }) => {
    const started = Date.now();
    const result = captureNetwork(command, timeoutMs);
    expect(Date.now() - started).toBeLessThan(10_000);
    const got: typeof outcome = {
      exited0: result.exitCode === 0,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    expect(got).toEqual(outcome);
  });

  // The fleet scripts ask GitHub through the client (actions/github-client/github.ts), which carries the deadline, the retry rule, and
  // the fixed failure text. A spawned gh or curl, bounded or not, brings back stderr that spells a private slug.
  test("no fleet script spawns gh or curl (class sweep)", () => {
    const SPAWNED = /\[\s*"(?:gh|curl)"/g;
    // The sweep's own controls: an empty offender list is evidence only if the pattern catches the offender shapes
    // and the scan reaches the scripts.
    const catches = (line: string) => new RegExp(SPAWNED.source).test(line);
    expect(catches('capture(["gh", "api", "user"])')).toBe(true);
    expect(catches('captureNetwork([ "curl", "-sS"])')).toBe(true);
    expect(catches('captureNetwork(["git", "ls-remote"])')).toBe(false);

    const dir = join(import.meta.dir, "../../.github/scripts/fleet");
    const scanned = readdirSync(dir).filter((entry) => entry.endsWith(".ts"));
    const offenders = scanned.flatMap((entry) =>
      (readFileSync(join(dir, entry), "utf-8").match(SPAWNED) ?? []).map(
        (match) => `${entry}: ${match.replace(/\s+/g, " ")}`,
      ),
    );
    expect(offenders).toEqual([]);
    expect(scanned).toContain("discovery.ts");
  });
});

describe("the dispatch inputs", () => {
  const root = temp.dir("discovery-dispatch-");

  function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  // One grammar for both selectors: a bare name rides through unchanged for the scope parser to refuse (sync_scope.ts).
  // The branch rides the same payload verbatim: a padded or case-changed value must reach the resolve probe as typed,
  // never as the branch it resembles. The two external facts: GitHub identity is case-insensitive, and a schedule or
  // release event carries no `inputs` key while an inputs-less API dispatch writes `"inputs": null`.
  test.each<{
    reason: string;
    onlyRepo?: string;
    eventBody?: string;
    repo: string;
    branch: string;
    addModules?: string;
  }>([
    {
      reason: "ONLY_REPO is trimmed and case-folded",
      onlyRepo: "  Vivswan/Steady  ",
      repo: "vivswan/steady",
      branch: "",
    },
    {
      reason: "a bare name stays bare: nothing here spells an owner onto it",
      onlyRepo: "Central-Home",
      repo: "central-home",
      branch: "",
    },
    {
      reason: 'the literal "all" is the whole-fleet scope',
      onlyRepo: "All",
      repo: "all",
      branch: "",
    },
    {
      reason: "the visibility tokens are scope tokens",
      onlyRepo: " Public,private ",
      repo: "public,private",
      branch: "",
    },
    {
      reason: "a comma list is trimmed per entry; empties survive for the scope parser to reject",
      onlyRepo: " Central-Home, Other/Shared ,,Vivswan/Third, ",
      repo: "central-home,other/shared,,vivswan/third,",
      branch: "",
    },
    { reason: "a lone comma is not an empty scope", onlyRepo: ",", repo: ",", branch: "" },
    {
      reason: "a list from the event payload folds the same way",
      eventBody: JSON.stringify({ inputs: { repo: "Vivswan/A,Vivswan/B" } }),
      repo: "vivswan/a,vivswan/b",
      branch: "",
    },
    {
      reason: "an empty ONLY_REPO falls back to the event payload's repo input",
      eventBody: JSON.stringify({ inputs: { repo: "Vivswan/Hidden-Server" } }),
      repo: "vivswan/hidden-server",
      branch: "",
    },
    {
      reason: "a non-empty ONLY_REPO overrides the event payload",
      onlyRepo: "Vivswan/from-env",
      eventBody: JSON.stringify({ inputs: { repo: "Vivswan/from-event" } }),
      repo: "vivswan/from-env",
      branch: "",
    },
    {
      reason: "the branch input beside the repo, whitespace and case kept",
      eventBody: JSON.stringify({ inputs: { repo: "Vivswan/A", branch: " Feat/Add-Site " } }),
      repo: "vivswan/a",
      branch: " Feat/Add-Site ",
    },
    {
      reason: "a no-break space in the branch is kept too",
      eventBody: JSON.stringify({ inputs: { branch: "feat/add-site\u00a0" } }),
      repo: "",
      branch: "feat/add-site\u00a0",
    },
    {
      reason:
        "add_modules folds like the scope, per entry; empties survive for its parser to reject (it never reads ONLY_REPO)",
      onlyRepo: "Vivswan/from-env",
      eventBody: JSON.stringify({
        inputs: { repo: "Vivswan/A", add_modules: " Site, Nightly ,," },
      }),
      repo: "vivswan/from-env",
      branch: "",
      addModules: "site,nightly,,",
    },
    {
      reason: "an event payload without a repo or branch input reads as empty",
      eventBody: JSON.stringify({ inputs: {} }),
      repo: "",
      branch: "",
    },
    {
      reason: "a null inputs key reads as empty (an inputs-less API dispatch)",
      eventBody: JSON.stringify({ inputs: null }),
      repo: "",
      branch: "",
    },
    {
      reason: "a payload without an inputs key reads as empty (schedule, release, and push events)",
      eventBody: JSON.stringify({ action: "published", ref: "refs/heads/main" }),
      repo: "",
      branch: "",
    },
    { reason: "nothing set reads as empty", repo: "", branch: "" },
  ])("$reason", ({ onlyRepo = "", eventBody, repo, branch, addModules = "" }) => {
    let eventPath = "";
    if (eventBody !== undefined) {
      eventPath = join(root, `event-${Bun.hash(eventBody).toString(16)}.json`);
      writeFileSync(eventPath, eventBody);
    }
    withEnv({ ONLY_REPO: onlyRepo, GITHUB_EVENT_PATH: eventPath }, () => {
      expect([readDispatchRepo(), readDispatchBranch(), readDispatchAddModules()]).toEqual([
        repo,
        branch,
        addModules,
      ]);
    });
  });

  // The malformed cases exit the process (parseJsonWith), so they run behind
  // a subprocess entry file.
  const dispatchEntry = join(root, "dispatch_entry.ts");
  writeFileSync(
    dispatchEntry,
    [
      `import { readDispatchAddModules, readDispatchBranch, readDispatchRepo } from ${JSON.stringify(DISCOVERY)};`,
      "console.log(JSON.stringify([readDispatchRepo(), readDispatchBranch(), readDispatchAddModules()]));",
      "",
    ].join("\n"),
  );

  // A bare identifier is the leaking form of an unparsable payload: Bun's raw JSON.parse error echoes it
  // ('Unexpected identifier "hiddenserver"'), so the fixed diagnostic must replace it.
  test.each<{
    reason: string;
    payload: string;
    diagnostic: string;
    path: string | null;
    value: string;
  }>([
    {
      reason: "a wrong-typed repo input",
      payload: JSON.stringify({ inputs: { repo: 31337 } }),
      diagnostic: "unexpected shape",
      path: "inputs.repo",
      value: "31337",
    },
    {
      reason: "a wrong-typed branch input",
      payload: JSON.stringify({ inputs: { branch: 31337 } }),
      diagnostic: "unexpected shape",
      path: "inputs.branch",
      value: "31337",
    },
    {
      reason: "a wrong-typed add_modules input",
      payload: JSON.stringify({ inputs: { add_modules: 31337 } }),
      diagnostic: "unexpected shape",
      path: "inputs.add_modules",
      value: "31337",
    },
    {
      reason: "a non-object payload",
      payload: JSON.stringify("Vivswan/hidden-server"),
      diagnostic: "unexpected shape",
      path: null,
      value: "hidden-server",
    },
    {
      reason: "an unparsable payload",
      payload: '{"inputs": {"repo": hiddenserver}}',
      diagnostic: "not valid JSON",
      path: null,
      value: "hiddenserver",
    },
  ])(
    "$reason fails loudly, never echoing the value",
    ({ reason, payload, diagnostic, path, value }) => {
      const eventFile = join(root, `event-${Bun.hash(reason).toString(16)}.json`);
      writeFileSync(eventFile, payload);
      const proc = boundedSpawnSync(["bun", dispatchEntry], {
        env: { ...process.env, ONLY_REPO: "", GITHUB_EVENT_PATH: eventFile },
      });
      const { got, want } = refusal(
        proc,
        "dispatch inputs: event payload",
        diagnostic,
        path,
        value,
      );
      expect(got).toEqual(want);
    },
  );
});

// discoverWritableRepos exits the process on failure, so it runs behind a
// subprocess entry file against a loopback API.
describe("discoverWritableRepos", () => {
  const root = temp.dir("discovery-proc-");
  const LABEL = "discovery.test: user/repos response";

  function repoEntry(full_name: string, overrides: Record<string, unknown> = {}) {
    return {
      full_name,
      archived: false,
      private: true,
      owner: { login: full_name.split("/")[0] },
      permissions: { push: true },
      ...overrides,
    };
  }

  // One listing per run name: the first segment of the run's GITHUB_API_URL.
  const LISTINGS: Record<string, FakeReply[]> = {
    pages: [
      {
        status: 200,
        next: true,
        body: [
          repoEntry("Vivswan/keep"),
          repoEntry("Vivswan/archived-out", { archived: true }),
          repoEntry("Vivswan/read-only", { permissions: { push: false } }),
          repoEntry("Vivswan/no-permissions", { permissions: undefined }),
        ],
      },
      {
        status: 200,
        body: [repoEntry("Other/cross-owner"), repoEntry("Vivswan/pub", { private: false })],
      },
    ],
    malformed: [{ status: 200, body: [{ full_name: "Vivswan/shapeless" }] }],
    unparsable: [{ status: 200, body: '[{"full_name": hiddenserver}]' }],
    outage: [{ status: 502, body: { message: "Vivswan/hiddenserver is unreachable" } }],
    absent: [{ status: 404 }],
    bodiless: [{ status: 200, body: null }],
    truncated: [{ status: 200, next: true, body: [repoEntry("Vivswan/keep")] }, { status: 409 }],
  };
  const servers: Record<string, LoopbackServer> = {};
  beforeAll(async () => {
    for (const [name, replies] of Object.entries(LISTINGS)) {
      servers[name] = await spawnFakeGithub({ "user/repos": replies }, join(root, `${name}.log`));
    }
  });
  afterAll(() => {
    for (const server of Object.values(servers)) server.stop();
  });

  const discoverEntry = join(root, "discover_entry.ts");
  writeFileSync(
    discoverEntry,
    [
      `import { discoverWritableRepos } from ${JSON.stringify(DISCOVERY)};`,
      `import { GitHubClient } from ${JSON.stringify(GITHUB)};`,
      `const repos = await discoverWritableRepos(new GitHubClient(), ${JSON.stringify(LABEL)});`,
      "console.log(JSON.stringify(repos.map((repo) => repo.full_name)));",
      "",
    ].join("\n"),
  );

  function runDiscover(name: string) {
    return boundedSpawnSync(["bun", discoverEntry], {
      env: {
        ...process.env,
        GH_TOKEN: "stub-token",
        GITHUB_API_URL: `${servers[name].host}/${name}`,
        GITHUB_RETRY_BASE_MS: "0",
      },
    });
  }

  test("keeps writable non-archived repos across pages and owners, drops the rest", () => {
    // `permissions` is optional in user/repos and `push` reports the USER's permission, not the token's grant; the
    // cross-owner pass-through is the boundary with discoverOwnerRepos, which drops them.
    const r = runDiscover("pages");
    expect({ ...r, stdout: JSON.parse(r.stdout) }).toEqual({
      exitCode: 0,
      stdout: ["Vivswan/keep", "Other/cross-owner", "Vivswan/pub"],
      stderr: "",
    });
  });

  // Fail closed: without a trustworthy fleet list nothing downstream may run, and a listing that reads as empty
  // would be "no repositories", green.
  test.each<{ name: string; reason: string; diagnostic: string }>([
    {
      name: "malformed",
      reason: "a listing off user/repos' shape",
      diagnostic:
        "the reply: unexpected shape - 0.archived: invalid_type; 0.private: invalid_type; 0.owner: invalid_type",
    },
    {
      name: "unparsable",
      reason: "a listing that is not JSON",
      diagnostic: "the reply: unexpected shape - (root): invalid_type",
    },
    { name: "outage", reason: "an outage the retries do not outlast", diagnostic: "HTTP 502" },
    { name: "absent", reason: "a 404, which is no empty fleet", diagnostic: "HTTP 404" },
    {
      name: "bodiless",
      reason: "a 200 with no array, which is no empty fleet",
      diagnostic: "the reply: unexpected shape - (root): invalid_type",
    },
    {
      name: "truncated",
      reason: "a second page that fails, which is no shorter fleet",
      diagnostic: "HTTP 409",
    },
  ])("$reason exits 1 with the caller's label, never a value", ({ name, diagnostic }) => {
    expect(runDiscover(name)).toEqual({
      exitCode: 1,
      stdout: `::error::${LABEL} could not be read (${diagnostic})\n`,
      stderr: "",
    });
  });
});

describe("parseDiscovered", () => {
  // One malformed entry rejects the WHOLE list: a silently dropped row would drop a repository from the sync, green.
  test.each<{ reason: string; input: unknown; accepted: boolean }>([
    {
      reason: "{repo, private} entries pass through",
      input: [{ repo: "o/a", private: true }],
      accepted: true,
    },
    { reason: "a missing private", input: [{ repo: "o/a" }], accepted: false },
    { reason: "a non-boolean private", input: [{ repo: "o/a", private: "true" }], accepted: false },
    {
      reason: "one bad entry among good ones",
      input: [{ repo: "o/a", private: true }, { repo: "o/b" }],
      accepted: false,
    },
    { reason: "a non-object entry", input: ["o/a"], accepted: false },
    { reason: "a non-string repo", input: [{ repo: 7, private: true }], accepted: false },
    { reason: "a non-array payload", input: { repo: "o/a", private: true }, accepted: false },
  ])("$reason", ({ input, accepted }) => {
    expect<unknown>(parseDiscovered(input)).toEqual(accepted ? input : null);
  });
});
