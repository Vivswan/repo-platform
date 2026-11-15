// The all-green check runs a fixture commit carries (shared/all_green.ts reads them), served by one loopback API per
// conclusion: the tag mover's and the build resolver's tests run their script against a commit that is green or red.

import { afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { type FakeGithubServer, spawnFakeGithub } from "./fake_github";
import type { TempDirs } from "./temp_dir";

/** The conclusions a scenario may ask for. */
const CONCLUSIONS = ["success", "failure"];

export interface VerdictApis {
  /** The API whose every commit of `o/r` carries a completed all-green check with this conclusion. */
  answering(conclusion: string): FakeGithubServer;

  /** A fresh run name: a run reads `${host}/<name>` and its requests are listed under it. */
  nextRun(): string;
}

/** Call at the test file's top level: the servers start in its beforeAll and stop in its afterAll. */
export function verdictApis(temp: TempDirs, prefix: string): VerdictApis {
  const servers = new Map<string, FakeGithubServer>();
  let runs = 0;
  beforeAll(async () => {
    const logs = temp.dir(prefix);
    for (const conclusion of CONCLUSIONS) {
      const check = {
        name: "all-green",
        status: "completed",
        conclusion,
        app: { slug: "github-actions" },
      };
      servers.set(
        conclusion,
        await spawnFakeGithub(
          { "repos/o/r/commits/*/check-runs": [{ status: 200, body: { check_runs: [check] } }] },
          join(logs, `${conclusion}.log`),
        ),
      );
    }
  });
  afterAll(() => {
    for (const server of servers.values()) server.stop();
  });
  return {
    answering(conclusion) {
      const server = servers.get(conclusion);
      if (server === undefined) throw new Error(`no fixture API answers '${conclusion}'`);
      return server;
    },
    nextRun: () => `run-${++runs}`,
  };
}
