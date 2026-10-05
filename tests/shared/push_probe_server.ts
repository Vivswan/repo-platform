// A loopback stand-in for GitHub's push-service advertisement (fleet/push_probe.ts), answering per slug from a table of
// statuses. The leading path segment is the run: a selector run sets GITHUB_SERVER_URL to <host>/<run>, so a slug whose
// entry lists several statuses hands them out in order per run (a flaky probe) and no run sees another's state.
//
// Its own process (tests/shared/loopback_server.ts): `bun tests/shared/push_probe_server.ts <token> <table json>`.

import { type LoopbackServer, spawnLoopback } from "./loopback_server";

export type ProbeTable = Record<string, number[]>;

function serve(token: string, table: ProbeTable): ReturnType<typeof Bun.serve> {
  const served = new Map<string, number>();
  const expected = `Basic ${btoa(`x-access-token:${token}`)}`;
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (request.headers.get("authorization") !== expected)
        return new Response("", { status: 401 });
      const match = /^\/([^/]+)\/([^/]+\/[^/]+)\.git\/info\/refs$/.exec(
        new URL(request.url).pathname,
      );
      if (match === null) return new Response("", { status: 404 });
      const [, run, slug] = match;
      const statuses = table[slug] ?? [200];
      const key = `${run} ${slug}`;
      const index = served.get(key) ?? 0;
      served.set(key, index + 1);
      return new Response("", { status: statuses[Math.min(index, statuses.length - 1)] });
    },
  });
}

export function spawnPushProbeServer(token: string, table: ProbeTable): Promise<LoopbackServer> {
  return spawnLoopback([import.meta.path, token, JSON.stringify(table)], "push probe server");
}

if (import.meta.main) {
  const server = serve(process.argv[2], JSON.parse(process.argv[3]) as ProbeTable);
  console.log(server.port);
}
