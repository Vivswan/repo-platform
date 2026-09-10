// The row resolver is the mask boundary: run as the workflow runs it, its
// stdout is nothing but ::add-mask:: commands for every form of the name,
// the name itself leaves through GITHUB_ENV alone, and every refusal names
// no repository.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyTag } from "../../.github/scripts/fleet/redact.ts";
import { maskForms, resolveRow } from "../../.github/scripts/sync/resolve_row.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const SCRIPT = join(import.meta.dir, "../../.github/scripts/sync/resolve_row.ts");
const PAT = "resolver-test-pat";
const RUN_ID = "31337";
const PUBLIC = "Vivswan/pub-repo";
const HIDDEN = "Vivswan/Hidden-Server";
const HIDDEN_TWIN = "Vivswan/hidden-twin";

const discovered = [
  { repo: PUBLIC, private: false },
  { repo: HIDDEN, private: true },
  { repo: HIDDEN_TWIN, private: true },
];
const rows = [
  { repo: PUBLIC, private: false, verify: "" },
  { repo: "H**-S**r", private: true, verify: verifyTag(PAT, RUN_ID, HIDDEN) },
];

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  env: string;
  outputs: string;
}

function run(env: Record<string, string>, list = discovered): Run {
  const root = temp.dir("resolve-row-");
  const runnerTemp = join(root, "temp");
  mkdirSync(runnerTemp);
  writeFileSync(join(runnerTemp, "discovered.json"), JSON.stringify(list));
  const envFile = join(root, "env.txt");
  const outputFile = join(root, "output.txt");
  writeFileSync(envFile, "");
  writeFileSync(outputFile, "");
  const result = boundedSpawnSync(["bun", SCRIPT], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RUNNER_TEMP: runnerTemp,
      GITHUB_ENV: envFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_RUN_ID: RUN_ID,
      PAT,
      ROWS: JSON.stringify(rows),
      PLANNED: String(rows.length),
      ...env,
    },
  });
  return {
    ...result,
    env: readFileSync(envFile, "utf-8"),
    outputs: readFileSync(outputFile, "utf-8"),
  };
}

const MASK = "::add-mask::";
const maskedValues = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      expect(line.startsWith(MASK)).toBe(true);
      return line.slice(MASK.length);
    });

describe("resolve_row.ts", () => {
  test("a public row resolves to its slug with every form masked before any other output", () => {
    const result = run({ ROW: "0" });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(maskedValues(result.stdout)).toEqual(maskForms(PUBLIC));
    expect(result.env).toBe(`TARGET=${PUBLIC}\nTARGET_PRIVATE=false\n`);
    expect(result.outputs).toBe("");
  });

  test("a private row resolves through its tag to the discovered repository", () => {
    const result = run({ ROW: "1" });
    expect(result.exitCode).toBe(0);
    const masked = maskedValues(result.stdout);
    for (const form of [
      HIDDEN,
      HIDDEN.toLowerCase(),
      "Hidden-Server",
      "hidden-server",
      `https://github.com/${HIDDEN}`,
      `https://github.com/${HIDDEN}.git`,
      `git@github.com:${HIDDEN}.git`,
    ]) {
      expect(masked).toContain(form);
    }
    expect(result.env).toBe(`TARGET=${HIDDEN}\nTARGET_PRIVATE=true\n`);
    expect(result.outputs).toBe("");
  });

  test.each<{ reason: string; env: Record<string, string> }>([
    { reason: "a plan count the re-run no longer matches", env: { ROW: "1", PLANNED: "3" } },
    { reason: "an index past the rows", env: { ROW: "2" } },
    { reason: "a non-numeric index", env: { ROW: "x" } },
  ])("$reason is refused without naming a repository", ({ env }) => {
    const result = run(env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).not.toContain(MASK);
    for (const name of ["pub-repo", "Hidden-Server", "hidden-twin"]) {
      expect(result.stdout).not.toContain(name);
      expect(result.stderr).not.toContain(name);
    }
    expect(result.env).toBe("");
    expect(result.outputs).toBe("");
  });

  test("a tag matching no discovered repository (a rename or a rotated PAT) is refused", () => {
    const result = run({ ROW: "1" }, [discovered[0]]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("matched 0 discovered repositories");
    expect(result.env).toBe("");
  });
});

describe("maskForms", () => {
  test("carries the slug, both URL spellings, the bare name, and their lower-case forms once each", () => {
    expect(maskForms("Vivswan/Hidden-Server")).toEqual([
      "Vivswan/Hidden-Server",
      "vivswan/hidden-server",
      "https://github.com/Vivswan/Hidden-Server",
      "https://github.com/vivswan/hidden-server",
      "https://github.com/Vivswan/Hidden-Server.git",
      "https://github.com/vivswan/hidden-server.git",
      "git@github.com:Vivswan/Hidden-Server.git",
      "git@github.com:vivswan/hidden-server.git",
      "Hidden-Server",
      "hidden-server",
    ]);
  });

  test("a short bare name is not masked on its own (it would garble every innocent occurrence)", () => {
    const forms = maskForms("Vivswan/api");
    expect(forms).toContain("Vivswan/api");
    expect(forms).not.toContain("api");
  });
});

describe("resolveRow", () => {
  const tagOf = (slug: string) => verifyTag(PAT, RUN_ID, slug);

  test("a tag two discovered repositories share is refused rather than guessed", () => {
    const twin = { repo: "h**-t**n", private: true, verify: tagOf(HIDDEN_TWIN) };
    const doubled = [...discovered, { repo: HIDDEN_TWIN, private: true }];
    expect(() => resolveRow([twin], 0, doubled, tagOf)).toThrow(
      "matched 2 discovered repositories",
    );
  });

  test("a public discovered repository never matches a private row's tag", () => {
    const row = { repo: "p**-r**o", private: true, verify: tagOf(PUBLIC) };
    expect(() => resolveRow([row], 0, discovered, tagOf)).toThrow("matched 0");
  });
});
