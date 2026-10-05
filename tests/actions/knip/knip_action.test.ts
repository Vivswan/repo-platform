// knip, at the version the action pins, honors git's excludes in its default and plugin globs and in neither form
// (`.git/info/exclude`, a `.gitignore` line) for a repository's own configured pattern (external; the fleet
// repository with `**/*.test.ts` in its knip.json went red on the platform checkout's imports). The end-to-end rows run
// this repository's installed knip over a fixture: the control names a file in the checkout; under the configuration
// the action writes, only a dependency the checkout alone imports is reported, unused, so knip analyzed nothing there.
// Dependabot bumps package.json and never the action's literal, so the pin is held to the devDependency the rows ran.

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveConfig, knipArguments } from "../../../actions/knip/run";
import { PLATFORM_CHECKOUT_DIR } from "../../../actions/shared/platform";
import { loadAction, REPO_ROOT, stepNamed } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { fixtureGit } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const PINNED = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).devDependencies
  .knip as string;
const KNIP = join(REPO_ROOT, "node_modules/knip/bin/knip.js");
const CHECKOUT = PLATFORM_CHECKOUT_DIR;
const OWN_FINDING = "Unused dependencies (1)\ncolorjs.io  package.json";

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

// The fleet's shape: a bun repository (knip's bun plugin reads its `bun test` script as `**/*.test.ts` entries) whose
// only use of a listed dependency sits in the platform checkout, beside a package the repository never listed.
const MANIFEST = {
  name: "fixture",
  dependencies: { "colorjs.io": "0.7.1" },
  scripts: { test: "bun test" },
};

function fixture(files: Record<string, string>, excludeLine: boolean): string {
  const repo = temp.dir("knip-fixture-");
  write(repo, {
    "package.json": JSON.stringify(MANIFEST),
    "bun.lock": "",
    "src/main.ts": "export const one = 1;\n",
    [`${CHECKOUT}/package.json`]: JSON.stringify({ name: "platform", private: true }),
    [`${CHECKOUT}/tests/theme.test.ts`]:
      'import Color from "colorjs.io";\nimport { x } from "not-listed";\nexport const c = new Color(x);\n',
    ...files,
  });
  fixtureGit(repo, ["init", "-q"]);
  if (excludeLine) appendFileSync(join(repo, ".git/info/exclude"), `/${CHECKOUT}/\n`);
  return repo;
}

// Under node, as `npx knip` runs it in the fleet. knip's jiti writes its cache under the temp dir, so the child gets a
// fixture of this file as TMPDIR, removed with the rest; the launcher counts anything else left there as a leak.
const knip = (cwd: string, args: string[]) =>
  boundedSpawnSync(["node", KNIP, "--no-progress", ...args], {
    cwd,
    timeoutMs: 60_000,
    env: { ...process.env, TMPDIR: temp.dir("knip-child-tmp-") },
  });

describe("actions/knip", () => {
  test("the fleet runs the knip this repository tests with, and the rows below ran", () => {
    const step = stepNamed(
      loadAction("actions/knip/action.yml"),
      "Find unused files, exports, and dependencies",
    );
    const installed = JSON.parse(
      readFileSync(join(REPO_ROOT, "node_modules/knip/package.json"), "utf8"),
    ).version;
    expect([(step.env as Record<string, string>).KNIP_VERSION, installed]).toEqual([
      PINNED,
      PINNED,
    ]);
  });

  test.each<{ reason: string; files: Record<string, string>; excludeLine: boolean }>([
    {
      reason:
        "the incident: the repository's own entry glob reaches the checkout past the exclude line",
      files: {
        "knip.json": '{"entry": ["src/main.ts", "**/*.test.ts"], "project": ["src/**/*.ts"]}',
      },
      excludeLine: true,
    },
    {
      reason:
        "no configuration and nothing in git hiding the directory: the defaults and the bun plugin reach it",
      files: {},
      excludeLine: false,
    },
    {
      reason: "a jsonc file layered over package.json's knip key",
      files: {
        "package.json": JSON.stringify({ ...MANIFEST, knip: { project: ["src/**/*.ts"] } }),
        ".knip.jsonc":
          '{\n  // the repository\'s entries\n  "entry": ["src/main.ts", "**/*.test.ts",],\n}\n',
      },
      excludeLine: true,
    },
  ])(
    "end to end, $reason: red on the checkout as the repository is; with the written configuration, red on the repository's own unused dependency alone",
    ({ files, excludeLine }) => {
      const repo = fixture(files, excludeLine);
      const control = knip(repo, []);
      const fixed = knip(repo, knipArguments(effectiveConfig(repo), temp.dir("knip-runner-temp-")));
      expect({
        control: {
          exitCode: control.exitCode,
          namesTheCheckout: control.stdout.includes(`  ${CHECKOUT}/`),
        },
        fixed: { exitCode: fixed.exitCode, stdout: fixed.stdout.trim() },
      }).toEqual({
        control: { exitCode: 1, namesTheCheckout: true },
        fixed: { exitCode: 1, stdout: OWN_FINDING },
      });
    },
  );

  test("the written configuration is the repository's own, found in knip's search order over package.json's knip key, the checkout under ignoreWorkspaces once; a lone knip.ts is left to knip, and what knip refuses stays refused", () => {
    const repo = temp.dir("knip-config-");
    const runnerTemp = temp.dir("knip-runner-temp-");
    write(repo, {
      "package.json": JSON.stringify({
        name: "x",
        knip: { project: ["src/**/*.ts"], ignoreWorkspaces: ["old", CHECKOUT] },
      }),
      "knip.ts": "export default {};\n",
    });
    const asCode = effectiveConfig(repo);
    write(repo, { ".knip.jsonc": '{\n  // a comment\n  "entry": ["src/main.ts",],\n}\n' });
    const viaJsonc = effectiveConfig(repo);
    write(repo, { "knip.json": '{"entry": ["cli.ts"]}' });
    const viaJson = effectiveConfig(repo);
    const args = knipArguments(viaJson, runnerTemp);
    write(repo, { "knip.json": '{"ignoreWorkspaces": "packages/legacy"}' });
    const refusedString = effectiveConfig(repo);
    write(repo, { "knip.json": '{"ignoreWorkspaces": null}' });
    const refusedNull = effectiveConfig(repo);
    write(repo, { "knip.json": "null" });
    const layered = (entry: string[]) => ({
      project: ["src/**/*.ts"],
      ignoreWorkspaces: ["old", CHECKOUT],
      entry,
    });
    expect({
      asCode,
      codeArgs: knipArguments(asCode, runnerTemp),
      viaJsonc,
      viaJson,
      args,
      written: JSON.parse(readFileSync(args[args.length - 1], "utf8")),
      refusedString: refusedString.kind === "merged" ? refusedString.config : refusedString,
      refusedNull: refusedNull.kind === "merged" ? refusedNull.config : refusedNull,
    }).toEqual({
      asCode: { kind: "code", source: "knip.ts" },
      codeArgs: ["--no-config-hints"],
      viaJsonc: { kind: "merged", source: ".knip.jsonc", config: layered(["src/main.ts"]) },
      viaJson: { kind: "merged", source: "knip.json", config: layered(["cli.ts"]) },
      args: ["--no-config-hints", "--config", join(runnerTemp, "knip.json")],
      written: layered(["cli.ts"]),
      // knip's schema takes a list alone under ignoreWorkspaces; a string or a null leaves as it came, for knip to refuse.
      refusedString: { project: ["src/**/*.ts"], ignoreWorkspaces: "packages/legacy" },
      refusedNull: { project: ["src/**/*.ts"], ignoreWorkspaces: null },
    });
    expect(() => effectiveConfig(repo)).toThrow("knip.json is not a knip configuration object");
  });
});
