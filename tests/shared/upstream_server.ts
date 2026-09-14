// A raw-content host over a directory: /<owner>/<name>/<sha>/<path> answers with <dir>/<path>, anything else 404.
// Loopback only: the default 0.0.0.0 listener collides in sandboxed runs.
//
// Two shapes for two callers. An async test serves in-process; a test that runs the writer through spawnSync blocks its
// own event loop for the child's whole run, so an in-process server would never answer: that test spawns the host as
// its own process (`bun tests/shared/upstream_server.ts <dir>` prints the port and serves until killed).

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type FilesConfig, upstreamRefs } from "../../actions/plan/files_config.ts";

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

export interface Upstream {
  host: string;
  stop: () => void;
}

export function serveUpstream(dir: string): Upstream {
  const server = serve(dir);
  return { host: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Bound: the only read is the port line, and a child that exits without printing ends it; the child itself lives until
 *  stop() kills it, which the caller's afterAll owns. */
export async function spawnUpstream(dir: string): Promise<Upstream> {
  const proc = Bun.spawn(["bun", import.meta.path, dir], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the upstream server exited before printing its port");
    text += new TextDecoder().decode(value);
  }
  return { host: `http://127.0.0.1:${text.trim()}`, stop: () => proc.kill() };
}

/** A one-line stub of every file files.yml fetches, served from its own process: for a test that runs the writer over
 *  the real files.yml and reads a file no fetch renders, since the writer fetches every ref first. */
export async function spawnStubUpstream(
  config: Pick<FilesConfig, "files">,
  dir: string,
): Promise<Upstream> {
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
