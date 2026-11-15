import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { GitHubClient, type Read } from "../../.github/scripts/shared/github.ts";
import { type FakeReply, type FakeRoutes, fakeGithub } from "./fake_github";

const REGISTRATION = "repos/example-owner/hidden-server/contents/.repo-platform.yml";
const BASE = "https://api.github.test";
const BAD_GATEWAY: FakeReply = { status: 502 };
const FILE: FakeReply = { status: 200, body: "modules: [base]\n" };
const HOUR_AWAY = String(Math.floor(Date.now() / 1000) + 3600);

function clientOver(routes: FakeRoutes, deadlineMs = 5000) {
  const github = fakeGithub(routes);
  const client = new GitHubClient({
    token: "stub-token",
    baseUrl: BASE,
    fetch: github.fetch,
    deadlineMs,
    retryBaseMs: 0,
  });
  return { client, github };
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
    const { client, github } = clientOver({ [REGISTRATION]: replies });

    expect(await client.text(REGISTRATION)).toEqual(expected);
    expect(github.calls().length).toBe(attempts);
  });

  test("a dropped connection is retried like a 5xx, then reported without the transport's message", async () => {
    let attempts = 0;
    const dropping = (async () => {
      attempts++;
      throw new TypeError(`connect ECONNRESET ${BASE}/${REGISTRATION}`);
    }) as unknown as typeof fetch;
    const client = new GitHubClient({ baseUrl: BASE, fetch: dropping, retryBaseMs: 0 });

    expect(await client.text(REGISTRATION)).toEqual({ kind: "failed", reason: "no response" });
    expect(attempts).toBe(4);
  });

  test("a stalled network ends at the deadline, in one attempt: a billed runner never waits on a retry of a timeout", async () => {
    const { client, github } = clientOver({ [REGISTRATION]: [{ status: 200, hang: true }] }, 50);

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
        const { client } = clientOver({ [REGISTRATION]: [reply] }, 50);

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
    ["neither reads anonymously", {}, null],
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

  test("a file that is itself JSON comes back as its text, not parsed: the selectors read a first line and a YAML document from it", async () => {
    const { client } = clientOver({
      [REGISTRATION]: [{ status: 200, body: { modules: ["base"] } }],
    });

    expect(await client.text(REGISTRATION)).toEqual({ kind: "ok", value: '{"modules":["base"]}' });
  });

  test("a listing is every page, in order, asked for 100 at a time under the token", async () => {
    const { client, github } = clientOver({
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

  test("a listing whose second page stalls ends at the deadline: the plugin's page requests carry the read's signal", async () => {
    const { client } = clientOver(
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
