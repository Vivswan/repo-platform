// What would drift silently: a fixture server that outlives its spawner. bun runs no afterAll in a file whose tests a
// name filter empties, so a spawner that only promises stop() left a `bun upstream_server.ts` behind on every such run.

import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();
const UPSTREAM_SERVER = join(import.meta.dir, "upstream_server.ts");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A dying process answers signal 0 until it is reaped, so the look waits two seconds at most. */
function outlived(pid: number): boolean {
  for (let look = 0; look < 40 && alive(pid); look++) Bun.sleepSync(50);

  return alive(pid);
}

test("a spawner that exits without stop() takes its server with it", () => {
  const root = temp.dir("loopback-server-");
  const report = join(root, "children.json");
  const spawner = join(root, "spawner.ts");
  // The spawner reports its children by pid before it exits, so a server that survived is stopped by pid below.
  writeFileSync(
    spawner,
    [
      'import { writeFileSync } from "node:fs";',
      `import { spawnUpstream } from ${JSON.stringify(UPSTREAM_SERVER)};`,
      `await spawnUpstream(${JSON.stringify(root)});`,
      'const listed = Bun.spawnSync(["pgrep", "-P", String(process.pid)]).stdout.toString();',
      `writeFileSync(${JSON.stringify(report)}, JSON.stringify(listed.split("\\n").filter((line) => line !== "").map(Number)));`,
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  const children = (): number[] =>
    existsSync(report) ? (JSON.parse(readFileSync(report, "utf-8")) as number[]) : [];

  try {
    const run = boundedSpawnSync(["bun", spawner]);
    expect({ ...run, servers: children().length, outlived: children().filter(outlived) }).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
      servers: 1,
      outlived: [],
    });
  } finally {
    for (const pid of children().filter(alive)) process.kill(pid);
  }
});
