// A stand-in for api.github.com as its own process (tests/shared/loopback_server.ts): a test that runs its script
// through spawnSync cannot answer from in-process. Each rule answers one request, and every request is logged with the
// headers GitHub requires for the test to pin.
// Loopback only: the default 0.0.0.0 listener collides in sandboxed runs.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LoopbackServer, spawnLoopback } from "./loopback_server";

export interface Reply {
  status: number;
  body: string;
}

export interface Rule {
  /** `METHOD /path`, exact. */
  request: string;
  reply: Reply;
}

/** A request as the script sent it: the headers GitHub requires, and the body (empty for a read). */
export interface Call {
  method: string;
  path: string;
  authorization: string | null;
  accept: string | null;
  contentType: string | null;
  body: string;
}

export interface GithubStub extends LoopbackServer {
  calls(): Call[];
}

function serve(specPath: string, logPath: string): ReturnType<typeof Bun.serve> {
  const rules = JSON.parse(readFileSync(specPath, "utf8")) as Rule[];
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const call: Call = {
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
        contentType: request.headers.get("content-type"),
        body: await request.text(),
      };
      appendFileSync(logPath, `${JSON.stringify(call)}\n`);
      const asked = `${request.method} ${path}`;
      const rule = rules.find((candidate) => candidate.request === asked);
      if (rule === undefined) {
        return new Response(`stub github: unexpected ${asked}`, { status: 500 });
      }
      return new Response(rule.reply.body, {
        status: rule.reply.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });
}

export async function spawnGithubStub(root: string, rules: Rule[]): Promise<GithubStub> {
  const spec = join(root, "github-rules.json");
  const log = join(root, "github-calls.jsonl");
  writeFileSync(spec, JSON.stringify(rules));
  writeFileSync(log, "");
  const server = await spawnLoopback([import.meta.path, spec, log], "github stub");
  return {
    ...server,
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Call),
  };
}

if (import.meta.main) {
  const server = serve(process.argv[2], process.argv[3]);
  console.log(server.port);
}
