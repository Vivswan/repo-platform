// A fixture server as its own process. A test that runs its subject through spawnSync blocks its own event loop for
// the child's whole run, so an in-process server would never answer; the server module instead serves from a child
// (`bun <module> <args>`), printing its port as the first line and serving until killed.

export interface LoopbackServer {
  host: string;
  stop: () => void;
}

/** Bound: the only read is the port line, and a child that exits without printing ends it; the child itself lives until
 *  stop() kills it, which the caller's afterAll owns. */
export async function spawnLoopback(argv: string[], label: string): Promise<LoopbackServer> {
  const proc = Bun.spawn(["bun", ...argv], { stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the ${label} exited before printing its port`);
    text += new TextDecoder().decode(value);
  }
  return { host: `http://127.0.0.1:${text.trim()}`, stop: () => proc.kill() };
}

/** A loopback host nothing listens on (a port just released), for a subject whose connection must be refused. */
export function deadLoopback(): string {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const host = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return host;
}
