// knip, at the version the action pins, globs a repository's own configured `entry` with git's excludes off (an entry
// a repository names is analyzed however git hides it), where its project and plugin globs honor the `.git/info/exclude`
// line fleet-ci.yml writes (external; the fleet repository with `**/*.test.ts` in its knip.json went red on the
// platform checkout's imports). The end-to-end rows run the action's knip over a fixture carrying that line: the
// control names a file in the checkout; under the written module, only a dependency the checkout alone imports is
// reported, unused, so knip analyzed nothing there, and stderr is empty, so the module drew no configuration hint.

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveConfig, KNIP_BIN, knipArguments, knipModule } from "../../../actions/knip/run";
import { PLATFORM_CHECKOUT_DIR } from "../../../actions/shared/platform";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { fixtureGit } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const CHECKOUT = PLATFORM_CHECKOUT_DIR;
const NEGATION = `!${CHECKOUT}/**`;
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

// Real paths throughout: node's process.cwd() is one, and knip maps a file to a workspace by string prefix.
function fixture(files: Record<string, string>): string {
  const repo = realpathSync(temp.dir("knip-fixture-"));
  write(repo, {
    "package.json": JSON.stringify(MANIFEST),
    "bun.lock": "",
    "src/main.ts": "export const one = 1;\n",
    // A test of the repository's own, so its `**/*.test.ts` entry matches a file once the checkout is negated: a
    // pattern matching nothing is a hint, and a hint fails the run.
    "src/main.test.ts":
      'import { one } from "./main.ts";\nif (one !== 1) throw new Error("one");\n',
    [`${CHECKOUT}/package.json`]: JSON.stringify({ name: "platform", private: true }),
    [`${CHECKOUT}/tests/theme.test.ts`]:
      'import Color from "colorjs.io";\nimport { x } from "not-listed";\nexport const c = new Color(x);\n',
    ...files,
  });
  fixtureGit(repo, ["init", "-q"]);
  appendFileSync(join(repo, ".git/info/exclude"), `/${CHECKOUT}/\n`);
  return repo;
}

/** Where the action writes its module in the fleet: its own directory inside the platform checkout. */
function actionDir(repo: string): string {
  const dir = join(repo, CHECKOUT, "actions", "knip");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Under node, as the action runs it in the fleet. knip's jiti writes its cache under the temp dir, so the child gets a
// fixture of this file as TMPDIR, removed with the rest; the launcher counts anything else left there as a leak.
const knip = (cwd: string, args: string[]) =>
  boundedSpawnSync(["node", KNIP_BIN, "--no-progress", ...args], {
    cwd,
    timeoutMs: 60_000,
    env: { ...process.env, TMPDIR: temp.dir("knip-child-tmp-") },
  });

async function withModule(repo: string) {
  return knip(repo, knipArguments(knipModule(await effectiveConfig(repo), actionDir(repo))));
}

describe("actions/knip", () => {
  test.each<{ reason: string; files: Record<string, string> }>([
    {
      reason:
        "the incident: the repository's own entry glob reaches the checkout past the exclude line",
      files: {
        "knip.json": '{"entry": ["src/main.ts", "**/*.test.ts"], "project": ["src/**/*.ts"]}',
      },
    },
    {
      reason: "a jsonc file layered over package.json's knip key",
      files: {
        "package.json": JSON.stringify({ ...MANIFEST, knip: { project: ["src/**/*.ts"] } }),
        ".knip.jsonc":
          '{\n  // the repository\'s entries\n  "entry": ["src/main.ts", "**/*.test.ts",],\n}\n',
      },
    },
    {
      // knip reads the root workspace's lists under `workspaces["."]` when that key exists and ignores the top-level
      // ones, so the negation belongs there, or the configured entry reaches the checkout as in the incident.
      reason: "the root workspace configured under workspaces['.']",
      files: {
        "knip.json":
          '{"project": ["never/**"], "workspaces": {".": {"entry": ["src/main.ts", "**/*.test.ts"], "project": ["src/**/*.ts"]}}}',
      },
    },
    {
      // Under knip's default project globs, so knip.ts and its import are project files: knip keeps them referenced
      // through its configuration-file entry, and the written module keeps that edge or they are reported unused. The
      // RegExp has no JSON form (knip's schema refuses the `{}` a serialization leaves), and the named export is
      // exempt from exports analysis as knip exempts its configuration file's. The entry list is read where knip
      // runs, under node: the manifest's list applies when the function sets none there, whatever it set under bun,
      // so tools/build.ts is an entry, and the checkout's negation joins the manifest's list.
      reason:
        "a knip.ts exporting a promise of a function and a named RegExp list, importing a sibling TypeScript module, setting an entry list under bun alone over a manifest list, under knip's default project globs",
      files: {
        "package.json": JSON.stringify({
          ...MANIFEST,
          dependencies: { ...MANIFEST.dependencies, "left-pad": "1.3.0" },
          knip: { entry: ["src/main.ts", "**/*.test.ts", "tools/*.ts"] },
        }),
        "knip.ts":
          'import { options } from "./config/options.ts";\nexport const ignored = [/^left-/];\nexport default Promise.resolve(() => ({ ...options, ignoreDependencies: ignored, ...(process.versions.bun ? { entry: ["src/main.ts"] } : {}) }));\n',
        "config/options.ts": "export const options = { ignoreExportsUsedInFile: true };\n",
        // An entry only the manifest's list names: a module that resolved the function under bun reports it unused.
        "tools/build.ts": "export const built = 1;\n",
      },
    },
  ])(
    "end to end, $reason: red on the checkout as the repository is; with the written module, red on the repository's own unused dependency alone, no hint",
    async ({ files }) => {
      const repo = fixture(files);
      const control = knip(repo, []);
      const fixed = await withModule(repo);
      expect({
        control: {
          exitCode: control.exitCode,
          namesTheCheckout: control.stdout.includes(`  ${CHECKOUT}/`),
        },
        fixed: { exitCode: fixed.exitCode, stdout: fixed.stdout.trim(), stderr: fixed.stderr },
      }).toEqual({
        control: { exitCode: 1, namesTheCheckout: true },
        fixed: { exitCode: 1, stdout: OWN_FINDING, stderr: "" },
      });
    },
  );

  // The premise the module rests on, pinned at the action's knip version: with no configured entry the module adds
  // nothing, and knip's default globs and the bun plugin's `**/*.test.ts` honor the exclude line. A knip that stopped
  // honoring it would go red on the checkout here before the fleet does.
  test("no configuration: the module adds nothing, and the exclude line alone keeps the defaults and the bun plugin out of the checkout", async () => {
    const repo = fixture({});
    const run = await withModule(repo);
    expect({ exitCode: run.exitCode, stdout: run.stdout.trim(), stderr: run.stderr }).toEqual({
      exitCode: 1,
      stdout: OWN_FINDING,
      stderr: "",
    });
  });

  // A repository with nothing unused, so a configuration hint is the run's only fault and the exit code is the hint's
  // alone. The flag could revert to suppressing hints, or the module could draw one again, with every row above still
  // green: this pair is where either shows.
  test.each([
    {
      verdict: "a hint in the repository's own configuration fails the run, named on stderr",
      config: '{"entry": ["src/main.ts"], "ignoreDependencies": ["never-used"]}',
      exitCode: 1,
      hinted: true,
    },
    {
      verdict: "the written module draws no hint of its own: the run passes",
      config: '{"entry": ["src/main.ts", "**/*.test.ts"]}',
      exitCode: 0,
      hinted: false,
    },
  ])("$verdict", async ({ config, exitCode, hinted }) => {
    const repo = fixture({
      "knip.json": config,
      "src/main.ts": 'import Color from "colorjs.io";\nexport const red = new Color("red");\n',
    });
    const run = await withModule(repo);
    expect({
      exitCode: run.exitCode,
      stdout: run.stdout.trim(),
      hinted:
        run.stderr.includes("Remove from ignoreDependencies") && run.stderr.includes("never-used"),
    }).toEqual({ exitCode, stdout: "", hinted });
  });

  // Where no configured pattern can reach the checkout, the module changes nothing knip reads: a falsy `entry` is
  // knip's defaults, and a list of knip's default patterns alone stays one (a negation beside them would make the
  // list explicit, and knip then analyzes a script entry's exports under `includeEntryExports`). Each row runs knip
  // alone and under the module and expects the same report.
  test.each<{ shape: string; files: Record<string, string> }>([
    {
      shape: "an empty string under entry and project, knip's defaults",
      files: { "knip.json": '{"entry": "", "project": ""}' },
    },
    {
      shape:
        "knip's default entry pattern spelled out, includeEntryExports, a script entry with an unused export",
      files: {
        "package.json": JSON.stringify({
          ...MANIFEST,
          scripts: { ...MANIFEST.scripts, start: "node index.ts" },
        }),
        "index.ts": "export const publicValue = 1;\n",
        "knip.json":
          '{"entry": ["{index,cli,main}.{js,mjs,cjs,jsx,ts,tsx,mts,cts}!"], "includeEntryExports": true}',
      },
    },
  ])("$shape: the module's report is knip's own", async ({ files }) => {
    const repo = fixture(files);
    const report = ({ exitCode, stdout, stderr }: ReturnType<typeof knip>) => ({
      exitCode,
      stdout: stdout.trim(),
      stderr,
    });
    const control = report(knip(repo, []));
    expect(control).toEqual({ exitCode: 1, stdout: OWN_FINDING, stderr: "" });
    expect(report(await withModule(repo))).toEqual(control);
  });

  // The module reads the configuration where knip runs, so a shape knip's schema never saw here can reach it there;
  // the module leaves it as it came, and knip refuses it, where a spread would have made patterns of a string's
  // characters or an object of a list.
  test.each([
    {
      shape: "a number under entry",
      yields: "{ entry: process.versions.bun ? [] : 42 }",
      refusal: "entry",
    },
    {
      shape: "a list as the whole configuration",
      yields: "process.versions.bun ? {} : []",
      refusal: "Expected an object as configuration",
    },
  ])("$shape, yielded under node alone, reaches knip as it came", async ({ yields, refusal }) => {
    const repo = fixture({ "knip.ts": `export default () => (${yields});\n` });
    const run = await withModule(repo);
    expect({ exitCode: run.exitCode, refused: run.stderr.includes(refusal) }).toEqual({
      exitCode: 2,
      refused: true,
    });
  });

  test("the written module yields knip's own resolution of the configuration, the checkout negated once in entry and project; what knip refuses stays refused; a module outside the repository too", async () => {
    const layered = realpathSync(temp.dir("knip-config-"));
    write(layered, {
      "package.json": JSON.stringify({
        name: "x",
        knip: { project: ["src/**/*.ts", NEGATION], ignoreWorkspaces: ["old"] },
      }),
      ".knip.jsonc": '{\n  // a comment\n  "entry": "src/main.ts",\n}\n',
    });
    const effective = await effectiveConfig(layered);
    const modulePath = knipModule(effective, actionDir(layered));
    const refused = realpathSync(temp.dir("knip-config-"));
    write(refused, {
      "package.json": JSON.stringify({ name: "x" }),
      "knip.json": '{"ignoreWorkspaces": "packages/legacy"}',
    });
    await expect(effectiveConfig(refused)).rejects.toThrow('"ignoreWorkspaces"');
    write(refused, { "knip.json": "null" });
    await expect(effectiveConfig(refused)).rejects.toThrow(
      `Expected an object as configuration from ${join(refused, "knip.json")}`,
    );
    const outside = temp.dir("knip-runner-temp-");
    expect(await (await import(modulePath)).default({})).toEqual({
      project: ["src/**/*.ts", NEGATION],
      ignoreWorkspaces: ["old"],
      entry: ["src/main.ts", NEGATION],
    });
    expect(() => knipModule(effective, outside)).toThrow(
      `${outside} is outside ${layered}, where knip analyzes files`,
    );
  });
});
