// The writer run over a stub upstream, as the tests under tests/files drive it: one registration, one checkout,
// and a failed or complaining run fails the test in place.

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "./bounded_spawn";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SYNC = join(REPO_ROOT, ".github/scripts/sync/writer/sync.ts");

export interface SyncOptions {
  /** The checkout the writer fills, a directory the caller's tempDirs minted. */
  target: string;

  /** The stub upstream's host (tests/shared/upstream_server.ts), so no run reaches the network. */
  upstream: string;

  /** The registration's module selection; none when omitted. */
  modules?: string[];

  /** The repository's visibility as the writer's own flag; public when omitted. */
  private?: boolean;
}

/** Writes a demo registration into `target`, runs the writer over it, and returns `target`. */
export function syncedCheckout({
  target,
  upstream,
  modules = [],
  private: isPrivate = false,
}: SyncOptions): string {
  writeFileSync(
    join(target, ".repo-platform.yml"),
    [
      `modules: ${JSON.stringify(modules)}`,
      "project:",
      "  name: Demo",
      "  slug: demo",
      "  description: A demo",
      "  copyright_holder: Owner",
      "",
    ].join("\n"),
  );
  const result = boundedSpawnSync(
    [
      "bun",
      SYNC,
      "--files",
      join(REPO_ROOT, "files.yml"),
      "--tree",
      join(REPO_ROOT, "files"),
      "--target",
      target,
      "--build",
      "0".repeat(40),
      "--repository",
      "owner/demo",
      "--private",
      String(isPrivate),
      "--upstream",
      upstream,
    ],
    { cwd: REPO_ROOT, timeoutMs: 60_000 },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return target;
}
