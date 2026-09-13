// typos layers --config over the _typos.toml it discovers at the checkout root, so a repository's own file extends the fleet allowlist.
// The end-to-end runs need a typos binary on PATH.
//   locally            -> skipped without one
//   TYPOS_REQUIRED=1   -> mandatory; ci.yml's script-tests job installs the pinned release and sets it

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const action = loadAction("actions/typos/action.yml");
const FLEET_CONFIG = join(REPO_ROOT, "actions/typos/_typos.toml");
const typosBinary = Bun.which("typos");
const typosRequired = process.env.TYPOS_REQUIRED === "1";
const endToEnd = typosBinary === null && !typosRequired ? test.skip : test;

describe("actions/typos", () => {
  test("a composite of exactly the pinned typos step with the fleet config, no inputs to loosen it", () => {
    expect(action.runs.using).toBe("composite");
    expect(action.inputs).toBeUndefined();
    expect(action.runs.steps).toHaveLength(1);
    const [step] = action.runs.steps;
    expect(step.uses).toMatch(/^crate-ci\/typos@[0-9a-f]{40}$/);
    expect(step.with).toEqual({ config: "${{ github.action_path }}/_typos.toml" });
    // The version comment beside the sha, for dependabot and the reader.
    const pinLine = readFileSync(join(REPO_ROOT, "actions/typos/action.yml"), "utf8")
      .split("\n")
      .find((line) => line.includes("uses: crate-ci/typos@"));
    expect(pinLine).toMatch(/ # v\d+\.\d+\.\d+$/);
  });

  test("the fleet allowlist: generated-file excludes and two ignore patterns, no accepted words", () => {
    const config = Bun.TOML.parse(readFileSync(FLEET_CONFIG, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(config).sort()).toEqual(["default", "files"]);
    expect(Object.keys(config.files)).toEqual(["extend-exclude"]);
    const excludes = config.files["extend-exclude"] as string[];
    expect(excludes).toContain("*.lock");
    // Never a source glob: a root lib/ is source in a Node repository, and one that generates it excludes it itself.
    expect(excludes).toEqual([
      "*.lock",
      "*.lockb",
      "package-lock.json",
      "*.min.js",
      "*.min.css",
      "*.svg",
      "/dist/",
      "node_modules/",
    ]);
    expect(Object.keys(config.default)).toEqual(["extend-ignore-re"]);
    // typos' leading inline flags become JS flags; R, its CRLF flag, has no JS counterpart and is dropped.
    const patterns = config.default["extend-ignore-re"] as string[];
    expect(patterns).toHaveLength(2);
    const [hex, marker] = patterns.map((pattern) => {
      const flags = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
      return new RegExp(
        flags ? pattern.slice(flags[0].length) : pattern,
        flags ? flags[1].replace("R", "") : "",
      );
    });
    expect(hex.test("598b829d7f507749e4e05469a31ddcfc9a7404c7")).toBe(true);
    expect(hex.test("teh quick fox")).toBe(false);
    expect(marker.test("const teh = 1; # typos: ignore")).toBe(true);
    expect(marker.test("const teh = 1; // typos: ignore")).toBe(true);
    expect(marker.test("const teh = 1;")).toBe(false);
    expect(marker.test("const teh = 1; // typos are ignored elsewhere")).toBe(false);
  });

  test("this repository's own _typos.toml only adds words and excludes this suite's fixtures", () => {
    const own = Bun.TOML.parse(readFileSync(join(REPO_ROOT, "_typos.toml"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(own).sort()).toEqual(["default", "files"]);
    expect(Object.keys(own.default)).toEqual(["extend-words"]);
    expect(own.files["extend-exclude"]).toEqual(["tests/actions/typos/typos_action.test.ts"]);
  });

  test.skipIf(!typosRequired)(
    "TYPOS_REQUIRED: the binary on PATH is the release the action pins",
    () => {
      expect(typosBinary).not.toBeNull();
      const pinned = /uses: crate-ci\/typos@[0-9a-f]{40} # v(\d+\.\d+\.\d+)$/m.exec(
        readFileSync(join(REPO_ROOT, "actions/typos/action.yml"), "utf8"),
      );
      const version = boundedSpawnSync([typosBinary ?? "typos", "--version"]);
      expect(version.stdout.trim()).toBe(`typos-cli ${pinned?.[1]}`);
    },
  );

  // End to end with the installed binary (brew install typos-cli): typos
  // exits 2 on findings, 0 when clean.
  const typos = (repo: string) =>
    boundedSpawnSync([typosBinary ?? "typos", "--config", FLEET_CONFIG, "--format", "brief", "."], {
      cwd: repo,
    });

  endToEnd(
    "end to end: an ordinary typo and the hyphenated mis- prefix both fail under the fleet config",
    () => {
      const repo = temp.dir("typos-e2e-");
      writeFileSync(join(repo, "a.md"), "teh quick fox mis-parses.\n");
      const run = typos(repo);
      expect([run.exitCode, run.stdout.includes("`teh`"), run.stdout.includes("`mis`")]).toEqual([
        2,
        true,
        true,
      ]);
    },
  );

  endToEnd(
    "end to end: the repository's _typos.toml extends the fleet allowlist (words and fixture paths); a sha is ignored, unparseable is not",
    () => {
      const repo = temp.dir("typos-e2e-own-");
      mkdirSync(join(repo, "src"));
      mkdirSync(join(repo, "test/fixtures"), { recursive: true });
      writeFileSync(
        join(repo, "_typos.toml"),
        '[default.extend-words]\nteh = "teh"\n\n[files]\nextend-exclude = ["test/fixtures/"]\n',
      );
      writeFileSync(
        join(repo, "src/a.md"),
        "teh quick fox at 598b829d7f507749e4e05469a31ddcfc9a7404c7, unparseable and recieve\n",
      );
      writeFileSync(join(repo, "test/fixtures/negative.txt"), "permision DELET entires\n");
      const run = typos(repo);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toContain("`recieve`");
      expect(run.stdout).not.toContain("`teh`");
      expect(run.stdout).toContain("`unparseable`");
      expect(run.stdout).not.toContain("`permision`");
    },
  );

  endToEnd(
    "end to end: a root dist/ is committed build output and skipped; a root lib/ and a nested one are source and scanned",
    () => {
      const repo = temp.dir("typos-e2e-built-");
      for (const dir of ["dist", "lib", "src/lib"]) mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, "dist/index.js"), "recieve\n");
      writeFileSync(join(repo, "lib/index.js"), "permision\n");
      writeFileSync(join(repo, "src/lib/a.ts"), "// teh\n");
      const run = typos(repo);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toContain("`teh`");
      expect(run.stdout).toContain("`permision`");
      expect(run.stdout).not.toContain("`recieve`");
    },
  );
});
