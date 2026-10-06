// A stand-in for api.github.com as its own process (tests/shared/loopback_server.ts): a test that runs its script
// through spawnSync cannot answer from in-process. Each rule answers its requests in order, the last reply repeating,
// so a re-read after a refused write can answer differently; every request is logged for the test to pin.
// Loopback only: the default 0.0.0.0 listener collides in sandboxed runs.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type LoopbackServer, spawnLoopback } from "./loopback_server";

export interface Reply {
  status: number;
  body: string;
}

export interface Rule {
  /** `METHOD /path`, exact, or a prefix when the path ends with "/". Several share one reply sequence. */
  requests: string[];
  replies: [Reply, ...Reply[]];
}

/** A request as the script sent it: the headers GitHub requires, and the body of a write. */
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

const matches = (pattern: string, request: string): boolean =>
  pattern.endsWith("/") ? request.startsWith(pattern) : request === pattern;

function serve(specPath: string, logPath: string): ReturnType<typeof Bun.serve> {
  const rules = JSON.parse(readFileSync(specPath, "utf8")) as Rule[];
  const served = rules.map(() => 0);
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
      const index = rules.findIndex((rule) => rule.requests.some((p) => matches(p, asked)));
      if (index === -1) {
        return new Response(`stub github: unexpected ${asked}`, { status: 500 });
      }
      const { replies } = rules[index];
      const reply = replies[Math.min(served[index]++, replies.length - 1)];
      return new Response(reply.body, {
        status: reply.status,
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
