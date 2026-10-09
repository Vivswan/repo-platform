// knip, at the version the action pins, exits 0 on a configuration hint unless the flag the manifest's step passes
// turns it into an error: external, so a bump that keeps the flag but not its effect would pass hints silently. A
// repository with nothing unused, so a hint is the run's only fault. The step runs as the manifest spells it, under node.

import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT, RUNNER_BASH, stepNamed } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const step = stepNamed(
  loadAction("actions/knip/action.yml"),
  "Find unused files, exports, and dependencies",
);

// Real paths throughout: node's process.cwd() is one, and knip maps a file to a workspace by string prefix.
function fixture(config: string): string {
  const repo = realpathSync(temp.dir("knip-fixture-"));
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { "colorjs.io": "0.7.1" } }),
  );
  writeFileSync(join(repo, "bun.lock"), "");
  writeFileSync(
    join(repo, "src/main.ts"),
    'import Color from "colorjs.io";\nexport const red = new Color("red");\n',
  );
  writeFileSync(join(repo, "knip.json"), config);
  return repo;
}

test.each([
  {
    verdict: "a hint in the repository's own configuration fails the run, named on stderr",
    config: '{"entry": ["src/main.ts"], "ignoreDependencies": ["never-used"]}',
    exitCode: 1,
    hinted: true,
  },
  {
    verdict: "a configuration drawing no hint passes",
    config: '{"entry": ["src/main.ts"]}',
    exitCode: 0,
    hinted: false,
  },
])("$verdict", ({ config, exitCode, hinted }) => {
  // knip's jiti writes its cache under the temp dir, so the child gets a fixture of this file as TMPDIR, removed with
  // the rest; the launcher counts anything else left there as a leak.
  const run = boundedSpawnSync([...RUNNER_BASH, String(step.run)], {
    cwd: fixture(config),
    timeoutMs: 60_000,
    env: {
      ...process.env,
      GITHUB_ACTION_PATH: join(REPO_ROOT, "actions/knip"),
      TMPDIR: temp.dir("knip-child-tmp-"),
    },
  });
  expect({
    exitCode: run.exitCode,
    stdout: run.stdout.trim(),
    hinted:
      run.stderr.includes("Remove from ignoreDependencies") && run.stderr.includes("never-used"),
  }).toEqual({ exitCode, stdout: "", hinted });
});
