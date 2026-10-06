// knip, at the version the action pins, honors git's excludes in its default and plugin globs and in neither form
// (`.git/info/exclude`, a `.gitignore` line) for a repository's own configured pattern (external; the fleet
// repository with `**/*.test.ts` in its knip.json went red on the platform checkout's imports). The end-to-end rows run
// the action's knip over a fixture: the control names a file in the checkout; under the written module, only a
// dependency the checkout alone imports is reported, unused, so knip analyzed nothing there.

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
function fixture(files: Record<string, string>, excludeLine: boolean): string {
  const repo = realpathSync(temp.dir("knip-fixture-"));
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

describe("actions/knip", () => {
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
    {
      // Under knip's default project globs, so knip.ts and its import are project files: knip keeps them referenced
      // through its configuration-file entry, and the written module keeps that edge or they are reported unused. The
      // RegExp has no JSON form (knip's schema refuses the `{}` a serialization leaves), and the named export is
      // exempt from exports analysis as knip exempts its configuration file's.
      reason:
        "a knip.ts exporting a function and a named RegExp list, importing a sibling TypeScript module, under knip's default project globs",
      files: {
        "knip.ts":
          'import { entry } from "./config/entry.ts";\nexport const ignored = [/^@types\\//];\nexport default () => ({ entry, ignoreDependencies: ignored });\n',
        "config/entry.ts": 'export const entry = ["src/main.ts", "**/*.test.ts"];\n',
      },
      excludeLine: true,
    },
  ])(
    "end to end, $reason: red on the checkout as the repository is; with the written module, red on the repository's own unused dependency alone",
    async ({ files, excludeLine }) => {
      const repo = fixture(files, excludeLine);
      const control = knip(repo, []);
      const fixed = knip(
        repo,
        knipArguments(knipModule(await effectiveConfig(repo), actionDir(repo))),
      );
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

  test("the written module yields knip's own resolution of the repository's configuration, the checkout under ignoreWorkspaces once; what knip refuses stays refused; a module outside the repository is refused", async () => {
    const layered = realpathSync(temp.dir("knip-config-"));
    write(layered, {
      "package.json": JSON.stringify({
        name: "x",
        knip: { project: ["src/**/*.ts"], ignoreWorkspaces: ["old", CHECKOUT] },
      }),
      ".knip.jsonc": '{\n  // a comment\n  "entry": ["src/main.ts",],\n}\n',
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
      project: ["src/**/*.ts"],
      ignoreWorkspaces: ["old", CHECKOUT],
      entry: ["src/main.ts"],
    });
    expect(() => knipModule(effective, outside)).toThrow(
      `${outside} is outside ${layered}, where knip analyzes files`,
    );
  });
});
