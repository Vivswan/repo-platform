// A raw-content host over a directory: /<owner>/<name>/<sha>/<path> answers with <dir>/<path>, anything else 404.
// Loopback only: the default 0.0.0.0 listener collides in sandboxed runs.
//
// Two shapes for two callers: an async test serves in-process; a test that runs the writer through spawnSync spawns
// the host as its own process (tests/shared/loopback_server.ts): `bun tests/shared/upstream_server.ts <dir>`.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FilesConfig, upstreamRefs } from "../../actions/plan/files_config.ts";
import { type LoopbackServer, spawnLoopback } from "./loopback_server";

function serve(dir: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const segments = new URL(request.url).pathname.split("/").slice(1);
      const rel = segments.slice(3).join("/");
      const file = join(dir, rel);
      const found =
        segments.length >= 4 &&
        !segments.includes("..") &&
        existsSync(file) &&
        statSync(file).isFile();
      return found ? new Response(readFileSync(file)) : new Response("not found", { status: 404 });
    },
  });
}

export function serveUpstream(dir: string): LoopbackServer {
  const server = serve(dir);
  return { host: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

export function spawnUpstream(dir: string): Promise<LoopbackServer> {
  return spawnLoopback([import.meta.path, dir], "upstream server");
}

/** A one-line stub of every file files.yml fetches, served from its own process: for a test that runs the writer over
 *  the real files.yml and reads a file no fetch renders, since the writer fetches every ref first. */
export async function spawnStubUpstream(
  config: Pick<FilesConfig, "files">,
  dir: string,
): Promise<LoopbackServer> {
  for (const { path } of upstreamRefs(config.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "# stub\n");
  }
  return spawnUpstream(dir);
}

if (import.meta.main) {
  const server = serve(process.argv[2]);
  console.log(server.port);
}
