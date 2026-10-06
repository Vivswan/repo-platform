// GitHub answers the Pages read with 200 (a site), 404 (none yet: the settings apply creates it, so the deploy waits),
// or anything else (fail, naming the status and the body), and a connection that never answers must fail too. All of it
// is external to this repository. The script is executed against a GitHub stand-in answering each way, and the request
// it sends is pinned with the whole outcome.
// The 500 body spans five lines, the shape a pretty-printed JSON error takes, so the error line must carry all of it.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { type Reply, spawnGithubStub } from "../../shared/github_stub";
import { deadLoopback } from "../../shared/loopback_server";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/pages-site/pages_exists.ts");
const TOKEN = "stub-token";

/** A null reply is a host nothing answers on. */
const asked = async (reply: Reply | null) => {
  const root = temp.dir("pages-exists-");
  const github =
    reply === null
      ? null
      : await spawnGithubStub(root, [{ requests: ["GET /repos/o/r/pages"], replies: [reply] }]);
  const output = join(root, "output");
  writeFileSync(output, "");
  let run: ReturnType<typeof boundedSpawnSync>;
  try {
    run = boundedSpawnSync([process.execPath, SCRIPT], {
      env: {
        GITHUB_API_URL: github === null ? deadLoopback() : github.host,
        GH_TOKEN: TOKEN,
        GITHUB_OUTPUT: output,
        GITHUB_REPOSITORY: "o/r",
      },
    });
  } finally {
    github?.stop();
  }
  const calls = github === null ? [] : github.calls();
  for (const call of calls) {
    expect([call.authorization, call.accept, call.contentType, call.body]).toEqual([
      `Bearer ${TOKEN}`,
      "application/vnd.github+json",
      null,
      "",
    ]);
  }
  return {
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    output: readFileSync(output, "utf8"),
    calls: calls.map(({ method, path }) => [method, path]),
  };
};

const ASKED = [["GET", "/repos/o/r/pages"]];

describe("pages_exists.ts", () => {
  test.each<{
    reason: string;
    reply: Reply | null;
    outcome: {
      exitCode: number;
      stdout: string | ReturnType<typeof expect.stringMatching>;
      stderr: string;
      output: string;
      calls: string[][];
    };
  }>([
    {
      reason: "200: a site, deploy",
      reply: {
        status: 200,
        body: '{"url":"https://api.github.com/repos/o/r/pages","status":"built"}',
      },
      outcome: { exitCode: 0, stdout: "", stderr: "", output: "exists=true\n", calls: ASKED },
    },
    {
      reason: "404: no site yet, wait with a warning",
      reply: { status: 404, body: '{"message":"Not Found","status":"404"}' },
      outcome: {
        exitCode: 0,
        stdout:
          "::warning::no Pages site yet: repo-platform's settings apply creates it on its next run (daily), and the nightly rebuild deploys; nothing to do here.\n",
        stderr: "",
        output: "exists=false\n",
        calls: ASKED,
      },
    },
    {
      reason: "500: fail, naming the status and the whole body",
      reply: {
        status: 500,
        body: [
          "{",
          '  "message": "Server Error",',
          '  "documentation_url": "https://docs.github.com/rest",',
          '  "status": "500"',
          "}",
        ].join("\n"),
      },
      outcome: {
        exitCode: 1,
        stdout:
          '::error::reading the Pages site answered HTTP 500: { "message": "Server Error", "documentation_url": "https://docs.github.com/rest", "status": "500" }\n',
        stderr: "",
        output: "",
        calls: ASKED,
      },
    },
    {
      // No response at all (the connection refused): the failure's own message stands in for the body.
      reason: "nothing: fail, naming the failure",
      reply: null,
      outcome: {
        exitCode: 1,
        stdout: expect.stringMatching(/^::error::reading the Pages site answered nothing: \S.*\n$/),
        stderr: "",
        output: "",
        calls: [],
      },
    },
  ])("against $reason", async ({ reply, outcome }) => {
    expect(await asked(reply)).toEqual(outcome);
  });
});
