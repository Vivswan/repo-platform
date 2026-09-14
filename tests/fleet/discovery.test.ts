import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  captureNetwork,
  parseDiscovered,
  readDispatchBranch,
  readDispatchRepo,
  scrubSlug,
} from "../../.github/scripts/fleet/discovery.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const DISCOVERY = join(import.meta.dir, "../../.github/scripts/fleet/discovery.ts");

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
  // program and never the argv tail: a real tail carries a private slug or, for the curl push probe, the PAT itself.
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

  test("every fleet gh/curl subprocess goes through captureNetwork (class sweep)", () => {
    // A bare capture/spawnSync around a gh or curl argv reintroduces the
    // unbounded-hang class this helper closed; new network calls must
    // carry the deadline too.
    const BARE = /\b(?:capture|mustCapture|spawnSync)\(\s*\[\s*"(?:gh|curl)"/g;
    // The sweep's own controls: an empty offender list is evidence only
    // if the pattern catches the offender shapes and the scan reaches the
    // real call sites.
    const catches = (line: string) => new RegExp(BARE.source).test(line);
    expect(catches('capture(["gh", "api", "user"])')).toBe(true);
    expect(catches('mustCapture(["gh", "api"])')).toBe(true);
    expect(catches('spawnSync([ "curl", "-sS"])')).toBe(true);
    expect(catches('captureNetwork(["gh", "api"])')).toBe(false);

    const dir = join(import.meta.dir, "../../.github/scripts/fleet");
    const offenders: string[] = [];
    let bounded = 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(join(dir, entry), "utf-8");
      bounded += source.match(/\bcaptureNetwork\(\s*\[\s*"(?:gh|curl)"/g)?.length ?? 0;
      const bare = source.match(BARE);
      for (const match of bare ?? []) offenders.push(`${entry}: ${match.replace(/\s+/g, " ")}`);
    }
    expect(offenders).toEqual([]);
    // The scan read the scripts that make network calls, not an empty or
    // misaddressed directory.
    expect(bounded).toBeGreaterThan(0);
  });
});

// scrubSlug keeps a private repo's slug and bare name out of captured error
// text that both selectors print into publicly readable logs.
describe("scrubSlug", () => {
  const SLUG = "Vivswan/hidden-server";
  const HINT = "h**-s**r";

  test.each([
    {
      reason: "every occurrence goes: slugs in URLs, bare names, and repeats alike",
      detail:
        "fatal: 'https://github.com/Vivswan/hidden-server.git/': fetch of hidden-server failed; retrying hidden-server, then Vivswan/hidden-server again",
      slug: SLUG,
      hint: HINT,
      expected:
        "fatal: 'https://github.com/h**-s**r.git/': fetch of h**-s**r failed; retrying h**-s**r, then h**-s**r again",
    },
    {
      reason: "a name embedded in a longer token is still masked (substring semantics)",
      detail: "branch hidden-server-backup rejected",
      slug: SLUG,
      hint: HINT,
      expected: "branch h**-s**r-backup rejected",
    },
    {
      // GitHub identity is case-insensitive: error text may echo a casing
      // other than discovery's canonical full_name (a redirect, a tool that
      // lowercases URLs), and each variant is as private as the original.
      reason: "every casing of the slug and bare name is scrubbed",
      detail:
        "GET https://api.github.com/repos/other/shared-private: 502; SHARED-PRIVATE is unreachable, Shared-Private retried",
      slug: "Other/Shared-Private",
      hint: "S**-P**e",
      expected:
        "GET https://api.github.com/repos/S**-P**e: 502; S**-P**e is unreachable, S**-P**e retried",
    },
    {
      reason: "regex metacharacters in a slug are treated literally",
      detail: "cannot read Vivswan/dotted.repo today",
      slug: "Vivswan/dotted.repo",
      hint: "d**.r**",
      expected: "cannot read d**.r** today",
    },
    {
      // The control for the row above: the "." must not match arbitrary
      // characters, so an unrelated name one character apart stays untouched.
      reason: "a near-miss of a metacharacter slug is left alone",
      detail: "cannot read Vivswan/dottedXrepo today",
      slug: "Vivswan/dotted.repo",
      hint: "d**.r**",
      expected: "cannot read Vivswan/dottedXrepo today",
    },
    {
      reason: "a no-op when the display IS the slug: the bare name must not expand into the slug",
      detail: "push to hidden-server rejected",
      slug: SLUG,
      hint: SLUG,
      expected: "push to hidden-server rejected",
    },
    {
      reason: "a slug without an owner segment scrubs as its own bare name",
      detail: "cloning monorepo into monorepo",
      slug: "monorepo",
      hint: "m**o",
      expected: "cloning m**o into m**o",
    },
  ])("$reason", ({ detail, slug, hint, expected }) => {
    expect(scrubSlug(detail, slug, hint)).toBe(expected);
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
  ])("$reason", ({ onlyRepo = "", eventBody, repo, branch }) => {
    let eventPath = "";
    if (eventBody !== undefined) {
      eventPath = join(root, `event-${Bun.hash(eventBody).toString(16)}.json`);
      writeFileSync(eventPath, eventBody);
    }
    withEnv({ ONLY_REPO: onlyRepo, GITHUB_EVENT_PATH: eventPath }, () => {
      expect([readDispatchRepo(), readDispatchBranch()]).toEqual([repo, branch]);
    });
  });

  // The malformed cases exit the process (parseJsonWith), so they run behind
  // a subprocess entry file.
  const dispatchEntry = join(root, "dispatch_entry.ts");
  writeFileSync(
    dispatchEntry,
    [
      `import { readDispatchBranch, readDispatchRepo } from ${JSON.stringify(DISCOVERY)};`,
      "console.log(JSON.stringify([readDispatchRepo(), readDispatchBranch()]));",
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
    "$reason fails loudly, naming the path but never the value",
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
// subprocess entry file with a stub gh on PATH.
describe("discoverWritableRepos", () => {
  const root = temp.dir("discovery-proc-");
  const bin = join(root, "bin");
  const LABEL = "discovery.test: user/repos response";

  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/usr/bin/env bash\ncat "$STUB_PAYLOAD"\n', { mode: 0o755 });

  const discoverEntry = join(root, "discover_entry.ts");
  writeFileSync(
    discoverEntry,
    [
      `import { discoverWritableRepos } from ${JSON.stringify(DISCOVERY)};`,
      `const repos = discoverWritableRepos(${JSON.stringify(LABEL)});`,
      "console.log(JSON.stringify(repos.map((repo) => repo.full_name)));",
      "",
    ].join("\n"),
  );

  function runDiscover(name: string, payload: string) {
    const payloadFile = join(root, `${name}.json`);
    writeFileSync(payloadFile, payload);
    return boundedSpawnSync(["bun", discoverEntry], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_PAYLOAD: payloadFile },
    });
  }

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

  test("keeps writable non-archived repos across pages and owners, drops the rest", () => {
    // `permissions` is optional in user/repos and `push` reports the USER's permission, not the token's grant; the
    // cross-owner pass-through is the boundary with discoverOwnerRepos, which drops them.
    const r = runDiscover(
      "pages",
      JSON.stringify([
        [
          repoEntry("Vivswan/keep"),
          repoEntry("Vivswan/archived-out", { archived: true }),
          repoEntry("Vivswan/read-only", { permissions: { push: false } }),
          repoEntry("Vivswan/no-permissions", { permissions: undefined }),
        ],
        [repoEntry("Other/cross-owner"), repoEntry("Vivswan/pub", { private: false })],
      ]),
    );
    expect({ ...r, stdout: JSON.parse(r.stdout) }).toEqual({
      exitCode: 0,
      stdout: ["Vivswan/keep", "Other/cross-owner", "Vivswan/pub"],
      stderr: "",
    });
  });

  test.each<{ reason: string; payload: string; diagnostic: string; value: string }>([
    {
      reason: "a malformed payload",
      payload: JSON.stringify([[{ full_name: "Vivswan/shapeless" }]]),
      diagnostic: "unexpected shape",
      value: "shapeless",
    },
    {
      reason: "an unparsable listing",
      payload: '[[{"full_name": hiddenserver}]]',
      diagnostic: "not valid JSON",
      value: "hiddenserver",
    },
  ])(
    "$reason fails loudly with the caller's label, never a value",
    ({ reason, payload, diagnostic, value }) => {
      const proc = runDiscover(Bun.hash(reason).toString(16), payload);
      const { got, want } = refusal(proc, LABEL, diagnostic, null, value);
      expect(got).toEqual(want);
    },
  );
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
