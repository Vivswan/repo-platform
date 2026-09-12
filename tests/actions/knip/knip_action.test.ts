import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/knip/action.yml");
const FLEET_CONFIG = join(REPO_ROOT, "actions/knip/knip.jsonc");
const FLEET_FLAG = "--config /opt/action/knip.jsonc --no-config-hints";

describe("actions/knip", () => {
  test("a composite of the config resolution and the pinned knip run, no inputs to loosen it", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.inputs).toBeUndefined();
    const [resolve, run] = action.runs.steps;
    expect(resolve.id).toBe("config");
    expect(run.env).toEqual({ CONFIG_FLAG: "${{ steps.config.outputs.flag }}" });
    // npx, not a bun runner: the caller's toolchain may be node alone.
    expect(String(run.run).trim()).toMatch(/^npx --yes knip@\d+\.\d+\.\d+ \$CONFIG_FLAG$/);
  });

  test("the fleet runs the knip this repository tests with", () => {
    const [, run] = action.runs.steps;
    const pinned = /knip@(\d+\.\d+\.\d+)/.exec(String(run.run))?.[1];
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    expect(pinned).toBe(pkg.devDependencies.knip);
  });

  const resolveConfig = (repo: string) =>
    runBashStep(stepNamed(action, "Resolve the configuration"), {
      fills: { "${{ github.action_path }}": "/opt/action" },
      cwd: repo,
      root: repo,
    });

  test("resolve: the fleet default when the repository carries no knip configuration", () => {
    const repo = temp.dir("knip-none-");
    writeFileSync(join(repo, "package.json"), '{"name": "x"}');
    const run = resolveConfig(repo);
    expect([run.exitCode, run.outputs]).toEqual([0, { flag: FLEET_FLAG }]);
  });

  // knip's own discovery list (KNIP_CONFIG_LOCATIONS in the pinned release)
  // plus the package.json key: each must win, or a repository using it would
  // silently get the fleet default instead of its own entries and ignores.
  const OWN_CONFIGS = [
    "knip.json",
    "knip.jsonc",
    ".knip.json",
    ".knip.jsonc",
    "knip.ts",
    "knip.js",
    "knip.config.ts",
    "knip.config.js",
  ];
  for (const own of OWN_CONFIGS) {
    test(`resolve: the repository's own ${own} wins (knip discovers it; no --config)`, () => {
      const repo = temp.dir("knip-own-");
      writeFileSync(join(repo, own), "");
      const run = resolveConfig(repo);
      expect([run.exitCode, run.outputs]).toEqual([0, { flag: "" }]);
    });
  }

  test("resolve: a knip key in package.json wins; a package.json without one does not", () => {
    const withKey = temp.dir("knip-pkg-");
    writeFileSync(join(withKey, "package.json"), '{"name": "x", "knip": {"entry": ["a.ts"]}}');
    expect(resolveConfig(withKey).outputs).toEqual({ flag: "" });
    const without = temp.dir("knip-pkg-none-");
    writeFileSync(join(without, "package.json"), '{"name": "x"}');
    expect(resolveConfig(without).outputs).toEqual({ flag: FLEET_FLAG });
  });

  test("the fleet default: same-file exports relaxed, the fleet layout as entry files with knip's defaults restated, the fleet-installed tools as known binaries", () => {
    // A jsonc file so each list carries its reason; knip parses it itself.
    const config = JSON.parse(
      readFileSync(FLEET_CONFIG, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n"),
    );
    expect(config).toEqual({
      $schema: "https://unpkg.com/knip@6/schema.json",
      ignoreExportsUsedInFile: true,
      entry: [
        "{index,cli,main}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
        "src/{index,cli,main}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
        "**/*.test.{ts,mts,js,mjs}",
        "tests/**/*.{ts,mts,js,mjs}",
        ".githooks/**/*.{ts,mts,js,mjs}",
        "**/scripts/**/*.{ts,mts,js,mjs}",
      ],
      ignoreBinaries: ["uv", "uvx", "actionlint", "gitleaks"],
    });
  });

  // Run as the action runs it, on a fleet-shaped repository whose tests run through a launcher script, not `bun test`.
  // knip's bun plugin misses those, so the entry globs must name them; the controls pin the shapes the default misses.
  const knip = (repo: string) =>
    boundedSpawnSync(
      [join(REPO_ROOT, "node_modules/.bin/knip"), "--config", FLEET_CONFIG, "--no-config-hints"],
      {
        cwd: repo,
        timeoutMs: 60_000,
        // knip loads its config through jiti, whose disk cache would land in
        // the run's TMPDIR and read as a leaked fixture.
        env: { ...process.env, JITI_FS_CACHE: "false", JITI_CACHE: "false" },
      },
    );
  function fleetShapedRepo(): string {
    const repo = temp.dir("knip-e2e-");
    // The scripts run the fleet-installed tools beside the launcher.
    writeFileSync(
      join(repo, "package.json"),
      '{"name": "x", "type": "module", "bin": {"x": "bin/x.js"}, "scripts": {"test": "bun scripts/run_tests.ts", "lint:yaml": "uvx yamllint .", "lint:actions": "actionlint && gitleaks detect && uv run ruff"}}',
    );
    mkdirSync(join(repo, "bin"));
    writeFileSync(join(repo, "bin/x.js"), "console.log(5);\n");
    // A bun repository's tsconfig: knip resolves the .ts-suffixed imports
    // only under allowImportingTsExtensions.
    writeFileSync(
      join(repo, "tsconfig.json"),
      '{"compilerOptions": {"module": "esnext", "moduleResolution": "bundler", "allowImportingTsExtensions": true, "noEmit": true}}',
    );
    writeFileSync(join(repo, "cli.ts"), "console.log(3);\n");
    mkdirSync(join(repo, ".github/actions/other"), { recursive: true });
    writeFileSync(
      join(repo, ".github/actions/other/action.yml"),
      "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun ${{ github.action_path }}/other.ts\n",
    );
    writeFileSync(join(repo, ".github/actions/other/other.ts"), "console.log(1);\n");
    mkdirSync(join(repo, ".github/workflows"));
    writeFileSync(
      join(repo, ".github/workflows/ci.yml"),
      "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun scripts/x.ts\n",
    );
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts/x.ts"), "console.log(2);\n");
    writeFileSync(join(repo, "scripts/run_tests.ts"), "console.log(6);\n");
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks/pre-commit.mts"), "console.log(7);\n");
    mkdirSync(join(repo, "skills/tool/scripts"), { recursive: true });
    writeFileSync(join(repo, "skills/tool/scripts/probe.mts"), "console.log(8);\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/lib.ts"), "export function helper(): number {\n  return 1;\n}\n");
    mkdirSync(join(repo, "tests/helpers"), { recursive: true });
    writeFileSync(
      join(repo, "tests/helpers/check_failure.ts"),
      "export function fail(): void {}\n",
    );
    writeFileSync(
      join(repo, "tests/lib.test.ts"),
      'import { helper } from "../src/lib.ts";\nimport { fail } from "./helpers/check_failure.ts";\nhelper();\nfail();\n',
    );
    return repo;
  }
  const unusedFiles = (stdout: string) =>
    stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .sort();

  test("end to end: the fleet-shaped repository is clean under the fleet default", () => {
    const run = knip(fleetShapedRepo());
    expect([run.exitCode, run.stdout, run.stderr]).toEqual([0, "", ""]);
  });

  test("end to end, control: a test file outside every entry glob, and what only it imports, are unused", () => {
    const repo = fleetShapedRepo();
    mkdirSync(join(repo, "spec"));
    writeFileSync(
      join(repo, "spec/lib.spec.ts"),
      'import { other } from "../src/other.ts";\nother();\n',
    );
    writeFileSync(
      join(repo, "src/other.ts"),
      "export function other(): number {\n  return 2;\n}\n",
    );
    const run = knip(repo);
    expect([run.exitCode, unusedFiles(run.stdout)]).toEqual([
      1,
      ["spec/lib.spec.ts", "src/other.ts"],
    ]);
  });

  test("end to end, control: a composite action outside .github is an unused file", () => {
    const repo = fleetShapedRepo();
    mkdirSync(join(repo, "actions/tool"), { recursive: true });
    writeFileSync(
      join(repo, "actions/tool/action.yml"),
      "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun ${{ github.action_path }}/tool.ts\n",
    );
    writeFileSync(join(repo, "actions/tool/tool.ts"), "console.log(4);\n");
    const run = knip(repo);
    expect([run.exitCode, unusedFiles(run.stdout)]).toEqual([1, ["actions/tool/tool.ts"]]);
  });

  test("end to end, control: a binary the fleet does not install is unlisted", () => {
    const repo = fleetShapedRepo();
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    pkg.scripts.shell = "shellcheck scripts/*.sh";
    writeFileSync(join(repo, "package.json"), JSON.stringify(pkg));
    const run = knip(repo);
    expect([run.exitCode, run.stdout.trim().split("\n")]).toEqual([
      1,
      ["Unlisted binaries (1)", "shellcheck  package.json"],
    ]);
  });

  test("end to end, control: a dead file still fails under the fleet default", () => {
    const repo = fleetShapedRepo();
    writeFileSync(join(repo, "src/dead.ts"), "export const dead = 1;\n");
    const run = knip(repo);
    expect([run.exitCode, unusedFiles(run.stdout)]).toEqual([1, ["src/dead.ts"]]);
  });
});
