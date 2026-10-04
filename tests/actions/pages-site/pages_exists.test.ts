// GitHub answers the Pages read with 200 (a site), 404 (none yet: the settings apply creates it, so the deploy waits),
// or anything else (fail, naming the status and the body); gh's `--include` wire format (a status line, CRLF headers, a
// blank line, the body, exit 1 off 2xx) is what the parser reads. Both are external to this repository. The script is
// executed against a gh stub answering each way, and the request it sends is pinned with the whole outcome.
// The 500 body spans five lines, the shape a pretty-printed JSON error takes, so the error line must carry all of it.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argvStub } from "../../shared/argv_stub";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../../actions/pages-site/pages_exists.ts");

const ask = (status: string, body: string, answers = true) => {
  const root = temp.dir("pages-exists-");
  const gh = argvStub(
    root,
    "gh",
    answers
      ? [
          'printf \'HTTP/2.0 %s\\nContent-Type: application/json; charset=utf-8\\r\\n\\r\\n%s\' "$GH_STATUS" "$GH_BODY"',
        ]
      : ["echo 'error connecting to api.github.com' >&2"],
  );
  const output = join(root, "output");
  writeFileSync(output, "");
  const run = boundedSpawnSync([process.execPath, SCRIPT], {
    env: {
      PATH: `${gh.bin}:${process.env.PATH ?? ""}`,
      GH_STATUS: status,
      GH_BODY: body,
      STUB_EXIT: status.startsWith("2") ? "0" : "1",
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: "o/r",
    },
  });
  expect(gh.calls()).toEqual([["gh", "api", "--include", "repos/o/r/pages"]]);
  return { exitCode: run.exitCode, stdout: run.stdout, output: readFileSync(output, "utf8") };
};

describe("pages_exists.ts", () => {
  test.each<{
    status: string;
    body: string;
    answers?: boolean;
    outcome: { exitCode: number; stdout: string; output: string };
  }>([
    {
      status: "200 OK",
      body: '{"url":"https://api.github.com/repos/o/r/pages","status":"built"}',
      outcome: { exitCode: 0, stdout: "", output: "exists=true\n" },
    },
    {
      status: "404 Not Found",
      body: '{"message":"Not Found","status":"404"}',
      outcome: {
        exitCode: 0,
        stdout:
          "::warning::no Pages site yet: repo-platform's settings apply creates it on its next run (daily), and the nightly rebuild deploys; nothing to do here.\n",
        output: "exists=false\n",
      },
    },
    {
      status: "500 Internal Server Error",
      body: [
        "{",
        '  "message": "Server Error",',
        '  "documentation_url": "https://docs.github.com/rest",',
        '  "status": "500"',
        "}",
      ].join("\n"),
      outcome: {
        exitCode: 1,
        stdout:
          '::error::reading the Pages site answered HTTP 500: { "message": "Server Error", "documentation_url": "https://docs.github.com/rest", "status": "500" }\n',
        output: "",
      },
    },
    {
      // No status line at all (gh never reached the API): gh's first stderr line stands in for the body.
      status: "nothing (no response)",
      body: "",
      answers: false,
      outcome: {
        exitCode: 1,
        stdout:
          "::error::reading the Pages site answered HTTP nothing: error connecting to api.github.com\n",
        output: "",
      },
    },
  ])("against HTTP $status: deploys, waits, or fails", ({ status, body, answers, outcome }) => {
    expect(ask(status, body, answers)).toEqual(outcome);
  });
});
