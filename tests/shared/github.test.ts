import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { GitHubClient, type Read } from "../../.github/scripts/shared/github.ts";
import { clientOver, type FakeReply, type FakeRoutes, fakeGithub } from "./fake_github";

const REGISTRATION = "repos/example-owner/hidden-server/contents/.repo-platform.yml";
const BASE = "https://api.github.test";
const BAD_GATEWAY: FakeReply = { status: 502 };
const FILE: FakeReply = { status: 200, body: "modules: [base]\n" };
const HOUR_AWAY = String(Math.floor(Date.now() / 1000) + 3600);

/** The client over a table, under a short deadline for the rows that stall. */
function over(routes: FakeRoutes, deadlineMs = 5000) {
  return clientOver(routes, { deadlineMs });
}

describe("GitHubClient", () => {
  // The policy is the plugins' and GitHub's, not this repository's: a library bump that starts retrying a 404, or stops
  // retrying a 502, changes what an outage does to the weekly sync without a line of this repository changing.
  const outcomes: [string, FakeReply[], Read<string>, number][] = [
    ["a 200 is the file", [FILE], { kind: "ok", value: "modules: [base]\n" }, 1],
    [
      "a 502 then a 200 is the file",
      [BAD_GATEWAY, FILE],
      { kind: "ok", value: "modules: [base]\n" },
      2,
    ],
    [
      "a 502 on every attempt fails after three retries",
      [BAD_GATEWAY],
      { kind: "failed", reason: "HTTP 502" },
      4,
    ],
    [
      "a reply cut off mid-body is retried like a 5xx",
      [{ ...FILE, cut: true }, FILE],
      { kind: "ok", value: "modules: [base]\n" },
      2,
    ],
    ["a 404 is not-found by status, never retried", [{ status: 404 }], { kind: "not-found" }, 1],
    [
      "a 403 is a failure, never retried",
      [{ status: 403 }],
      { kind: "failed", reason: "HTTP 403" },
      1,
    ],
    [
      "a 409 is a failure, never retried: an empty repository's commits/HEAD answers it for good",
      [{ status: 409 }],
      { kind: "failed", reason: "HTTP 409" },
      1,
    ],
    [
      "a 408 is a failure, never retried: every 4xx fails at once",
      [{ status: 408 }],
      { kind: "failed", reason: "HTTP 408" },
      1,
    ],
    [
      "a rate limit that lifts at once is waited out",
      [{ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" } }, FILE],
      { kind: "ok", value: "modules: [base]\n" },
      2,
    ],
    [
      "a rate limit an hour long fails instead of holding the runner",
      [
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": HOUR_AWAY } },
        FILE,
      ],
      { kind: "failed", reason: "HTTP 403" },
      1,
    ],
    [
      "a second rate limit after the one wait fails",
      [{ status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" } }],
      { kind: "failed", reason: "HTTP 429" },
      2,
    ],
  ];

  test.each(outcomes)("%s", async (_name, replies, expected, attempts) => {
    const { client, github } = over({ [REGISTRATION]: replies });

    expect(await client.text(REGISTRATION)).toEqual(expected);
    expect(github.calls().length).toBe(attempts);
  });

  test("a dropped connection is retried like a 5xx, then reported without the transport's message", async () => {
    let attempts = 0;
    const dropping = (async () => {
      attempts++;
      throw new TypeError(`connect ECONNRESET ${BASE}/${REGISTRATION}`);
    }) as unknown as typeof fetch;
    const client = new GitHubClient({
      token: "stub-token",
      baseUrl: BASE,
      fetch: dropping,
      retryBaseMs: 0,
    });

    expect(await client.text(REGISTRATION)).toEqual({ kind: "failed", reason: "no response" });
    expect(attempts).toBe(4);
  });

  test("a stalled network ends at the deadline, in one attempt: a billed runner never waits on a retry of a timeout", async () => {
    const { client, github } = over({ [REGISTRATION]: [{ status: 200, hang: true }] }, 50);

    expect(await client.text(REGISTRATION)).toEqual({
      kind: "failed",
      reason: "no answer within 50ms",
    });
    expect(github.calls().length).toBe(1);
  });

  describe("on a private repository's path", () => {
    const logged = [spyOn(console, "warn"), spyOn(console, "error"), spyOn(console, "log")];
    afterEach(() => {
      for (const spy of logged) spy.mockClear();
    });

    // The library's error message and its deprecation warning both spell the request URL, and GitHub's error body can
    // quote the repository; the selectors print a failure's reason into a public log.
    const leaky: [string, FakeReply][] = [
      [
        "an error body naming the repository",
        { status: 500, body: { message: "example-owner/hidden-server is down" } },
      ],
      [
        "a 403 naming the repository",
        { status: 403, body: { message: "hidden-server: resource not accessible" } },
      ],
      ["a deprecated endpoint", { status: 500, headers: { deprecation: "true", sunset: "soon" } }],
      ["a stalled read", { status: 200, hang: true }],
      ["a reply of the wrong shape", { status: 200, body: { owner: "hidden-server" } }],
    ];

    test.each(leaky)(
      "%s leaves no part of the name in the outcome or on the console",
      async (_name, reply) => {
        const { client } = over({ [REGISTRATION]: [reply] }, 50);

        const outcome = await client.get(REGISTRATION, z.object({ sha: z.string() }));

        expect(outcome.kind).toBe("failed");
        expect(JSON.stringify(outcome)).not.toMatch(/hidden|example-owner|github\.test/i);
        expect(logged.flatMap((spy) => spy.mock.calls)).toEqual([]);
      },
    );
  });

  // GitHub answers an anonymous read of a private repository with 404, which the selectors read as "not adopted": a
  // client that lost the workflows' token would drop every private repository from the fleet, green.
  test.each<[string, Record<string, string>, string | null]>([
    [
      "GH_TOKEN wins, as it does for gh",
      { GH_TOKEN: "first", GITHUB_TOKEN: "second" },
      "token first",
    ],
    ["GITHUB_TOKEN alone is used", { GITHUB_TOKEN: "second" }, "token second"],
    [
      "an empty GH_TOKEN is skipped, as gh skips it",
      { GH_TOKEN: "", GITHUB_TOKEN: "second" },
      "token second",
    ],
  ])(
    "the token comes from the environment the workflows set: %s",
    async (_name, tokens, authorization) => {
      const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      Object.assign(process.env, tokens);
      const github = fakeGithub({ [REGISTRATION]: [FILE] });
      try {
        await new GitHubClient({ baseUrl: BASE, fetch: github.fetch }).text(REGISTRATION);
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }

      expect(github.calls()).toEqual([{ path: REGISTRATION, authorization }]);
    },
  );

  // GitHub answers an anonymous read of a private repository with 404, so a client with no token would read "not
  // adopted" where the truth is "no access".
  test.each<[string, Record<string, string>]>([
    ["neither variable set", {}],
    ["both empty", { GH_TOKEN: "", GITHUB_TOKEN: "" }],
  ])("no token is no client: %s", (_name, tokens) => {
    const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    Object.assign(process.env, tokens);
    try {
      expect(() => new GitHubClient({ baseUrl: BASE })).toThrow(
        "GH_TOKEN or GITHUB_TOKEN must be set: the GitHub API is never read anonymously",
      );
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("a rate-limit wait longer than the deadline ends at the deadline: the green gate's 15 seconds are its bound", async () => {
    const limited: FakeReply = {
      status: 403,
      headers: { "retry-after": "60" },
      body: { message: "You have exceeded a secondary rate limit." },
    };
    const { client } = clientOver(
      { [REGISTRATION]: [limited, FILE] },
      { deadlineMs: 50, retryBaseMs: 10 },
    );

    const started = performance.now();
    const outcome = await client.text(REGISTRATION);

    expect(outcome).toEqual({ kind: "failed", reason: "no answer within 50ms" });
    expect(performance.now() - started).toBeLessThan(400);
  });

  test("a file that is itself JSON comes back as its text, not parsed: the selectors read a first line and a YAML document from it", async () => {
    const { client } = over({
      [REGISTRATION]: [{ status: 200, body: { modules: ["base"] } }],
    });

    expect(await client.text(REGISTRATION)).toEqual({ kind: "ok", value: '{"modules":["base"]}' });
  });

  test("a listing is every page, in order, asked for 100 at a time under the token", async () => {
    const { client, github } = over({
      "user/repos": [
        { status: 200, body: [{ name: "one" }, { name: "two" }], next: true },
        { status: 200, body: [{ name: "three" }] },
      ],
    });

    const listing = await client.paginate("user/repos", z.object({ name: z.string() }));

    expect(listing).toEqual({
      kind: "ok",
      value: [{ name: "one" }, { name: "two" }, { name: "three" }],
    });
    expect(github.calls()).toEqual([
      { path: "user/repos?per_page=100", authorization: "token stub-token" },
      { path: "user/repos?per_page=100&page=2", authorization: "token stub-token" },
    ]);
  });

  // The weekly sync reads "nothing to sync" off an empty listing and stays green, so a listing GitHub did not really
  // give must never read as an empty or a shorter one.
  const ONE: FakeReply = { status: 200, body: [{ name: "one" }], next: true };
  const untrusted: [string, FakeReply[], string][] = [
    [
      "a null body",
      [{ status: 200, body: null }],
      "the reply: unexpected shape - (root): invalid_type",
    ],
    [
      "an empty body",
      [{ status: 200, body: "" }],
      "the reply: unexpected shape - (root): invalid_type",
    ],
    ["a 409", [{ status: 409 }], "HTTP 409"],
    [
      "a null second page",
      [ONE, { status: 200, body: null }],
      "the reply: unexpected shape - (root): invalid_type",
    ],
    ["a 409 on the second page", [ONE, { status: 409 }], "HTTP 409"],
    [
      "a next link the client cannot read",
      [
        {
          status: 200,
          body: [{ name: "one" }],
          headers: {
            link: '<https://api.github.test/user/repos?page=2>; title="more"; rel="next"',
          },
        },
      ],
      "the reply: a Link header whose next page cannot be read",
    ],
  ];

  test.each(untrusted)("a listing with %s is no listing", async (_name, replies, reason) => {
    const { client } = over({ "user/repos": replies });

    expect(await client.paginate("user/repos", z.object({ name: z.string() }))).toEqual({
      kind: "failed",
      reason,
    });
  });

  test("an empty array is an empty listing: a user with no repositories is not an outage", async () => {
    const { client } = over({ "user/repos": [{ status: 200, body: [] }] });

    expect(await client.paginate("user/repos", z.object({ name: z.string() }))).toEqual({
      kind: "ok",
      value: [],
    });
  });

  test("a listing whose second page stalls ends at the deadline: one deadline covers every page", async () => {
    const { client } = over(
      {
        "user/repos": [
          { status: 200, body: [{ name: "one" }], next: true },
          { status: 200, hang: true },
        ],
      },
      50,
    );

    expect(await client.paginate("user/repos", z.object({ name: z.string() }))).toEqual({
      kind: "failed",
      reason: "no answer within 50ms",
    });
  });
});
