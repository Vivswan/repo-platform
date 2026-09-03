import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/select_modules.ts");

const COPIER = ["modules:", "  choices:", "    uv: uv", "    bun: bun", ""].join("\n");

/** A scratch root holding target/.repo-platform.yml and a RUNNER_TEMP with
 * the template's copier-new.yml, the way the sync workflow lays them out. */
function makeRoot(repoFile: string, copier: string = COPIER): { root: string; temp: string } {
  const root = mkdtempSync(join(tmpdir(), "select-modules-"));
  const temp = join(root, "temp");
  mkdirSync(join(root, "target"), { recursive: true });
  mkdirSync(temp);
  writeFileSync(join(root, "target", ".repo-platform.yml"), repoFile);
  writeFileSync(join(temp, "copier-new.yml"), copier);
  return { root, temp };
}

function runScript(
  root: string,
  temp: string,
  extraEnv: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const proc = boundedSpawnSync(["bun", script], {
    cwd: root,
    env: {
      ...process.env,
      RUNNER_TEMP: temp,
      TARGET_DISPLAY: "Vivswan/demo",
      HIDE_DETAILS: "false",
      ...extraEnv,
    },
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
}

describe("select_modules", () => {
  test("writes the filtered selection to modules.json and prints the names", () => {
    const { root, temp } = makeRoot("modules:\n  - uv\n");
    const result = runScript(root, temp);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(temp, "modules.json"), "utf-8")).toBe('["uv"]');
    expect(readFileSync(join(temp, "retired-modules.txt"), "utf-8")).toBe("");
    expect(result.stdout).toContain('selected modules: ["uv"]');
  });

  test("a hide-details target gets counts, not names", () => {
    const { root, temp } = makeRoot("modules:\n  - uv\n  - bun\n");
    const result = runScript(root, temp, { HIDE_DETAILS: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("selected modules: 2 (names hidden: private repository)");
    expect(result.stdout).not.toContain("uv");
  });

  test("an unknown module fails loudly with ::error:: on stdout", () => {
    const { root, temp } = makeRoot("modules:\n  - typo-module\n");
    const result = runScript(root, temp);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("typo-module");
  });

  test("hide-details withholds selection failure detail on every stream", () => {
    const { root, temp } = makeRoot("modules:\n  - secret-module-name\n");
    const result = runScript(root, temp, { HIDE_DETAILS: "true" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("detail hidden: private repository");
    for (const channel of [result.stdout, result.stderr]) {
      expect(channel).not.toContain("secret-module-name");
    }
  });

  test("hide-details keeps YAML diagnostics off stderr too", () => {
    // An explicit unknown !!tag makes the yaml parser WARN with the source
    // line unless the read passes logLevel error; the sync inlines the
    // parse, so a leak here would print target file content unmediated.
    const { root, temp } = makeRoot("modules: !!secret-tag-name [uv]\n");
    const result = runScript(root, temp, { HIDE_DETAILS: "true" });
    // Positive control: the tagged document was parsed and selected, so
    // the absence below is a silenced warning, not a run that died first.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("selected modules: 1 (names hidden: private repository)");
    for (const channel of [result.stdout, result.stderr]) {
      expect(channel).not.toContain("secret-tag-name");
    }
  });

  test("a malformed template copier.yml is named on stdout when details may print", () => {
    const { root, temp } = makeRoot("modules:\n  - uv\n", "not a mapping");
    const result = runScript(root, temp);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("copier-new.yml");
  });
});
