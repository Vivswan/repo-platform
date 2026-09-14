// typos layers --config over the _typos.toml it discovers at the checkout root (external): the action's description
// promises the extension, and a typos release that replaced instead of layering would drop every repository's words at
// once. The end-to-end rows need a typos binary on PATH.
//   locally            -> skipped without one
//   TYPOS_REQUIRED=1   -> mandatory; ci.yml's script-tests job installs the pinned release and sets it

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT, stepNamed } from "../../shared/action_step";
import { boundedSpawnSync } from "../../shared/bounded_spawn";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
// The config the action names, so a `with.config` the action drops or moves is a config these rows stop finding.
const configInput = String(
  (
    stepNamed(loadAction("actions/typos/action.yml"), "Check spelling").with as Record<
      string,
      string
    >
  ).config,
);
const FLEET_CONFIG = configInput.replace(
  "${{ github.action_path }}",
  join(REPO_ROOT, "actions/typos"),
);
const typosBinary = Bun.which("typos");
const typosRequired = process.env.TYPOS_REQUIRED === "1";
const endToEnd = typosBinary === null && !typosRequired ? test.skip : test;

describe("actions/typos", () => {
  test.skipIf(!typosRequired)(
    "TYPOS_REQUIRED: the binary on PATH is the release the action pins",
    () => {
      // The end-to-end rows run whatever typos is on PATH; without this they prove another release's behaviour.
      expect(typosBinary).not.toBeNull();
      const pinned = /uses: crate-ci\/typos@[0-9a-f]{40} # v(\d+\.\d+\.\d+)$/m.exec(
        readFileSync(join(REPO_ROOT, "actions/typos/action.yml"), "utf8"),
      );
      const version = boundedSpawnSync([typosBinary ?? "typos", "--version"]);
      expect(version.stdout.trim()).toBe(`typos-cli ${pinned?.[1]}`);
    },
  );

  // typos exits 2 on findings, 0 when clean; a fixture tree is the axis. The findings are asserted whole, as
  // `path:line word`, so a rule that widened or narrowed shows the line it changed; every misspelling is unique to
  // its line so no other line can stand in for it.
  endToEnd.each<{
    reason: string;
    files: Record<string, string>;
    found: string[];
  }>([
    {
      reason: "an ordinary typo and the hyphenated mis- prefix both fail under the fleet config",
      files: { "a.md": "teh quick fox mis-parses.\n" },
      found: ["./a.md:1 mis", "./a.md:1 teh"],
    },
    {
      // The two fleet ignore patterns run in typos' own regex dialect (its `R` flag has no JS counterpart): a sha and
      // a `# typos: ignore` or `// typos: ignore` line are exempt, prose mentioning typos is not.
      reason:
        "the repository's _typos.toml extends the fleet allowlist (words and fixture paths); a sha and a marked line are ignored, unparseable is not",
      files: {
        "_typos.toml":
          '[default.extend-words]\nteh = "teh"\n\n[files]\nextend-exclude = ["test/fixtures/"]\n',
        "src/a.md":
          "teh quick fox at 598b829d7f507749e4e05469a31ddcfc9a7404c7, unparseable and recieve\n",
        "src/b.ts": "const seperate = 1; // typos: ignore\nconst permision = 2; # typos: ignore\n",
        "src/c.md": "adress: typos are ignored elsewhere\n",
        "src/d.ts": "const definately = 3; // typos are a word here, not the marker\n",
        "test/fixtures/negative.txt": "occured DELET entires\n",
      },
      found: [
        "./src/a.md:1 recieve",
        "./src/a.md:1 unparseable",
        "./src/c.md:1 adress",
        "./src/d.ts:1 definately",
      ],
    },
    {
      // Never a source glob: a root lib/ is source in a Node repository, and one that generates it excludes it itself.
      reason:
        "a root dist/ is committed build output and skipped; a root lib/ and a nested one are source and scanned",
      files: {
        "dist/index.js": "recieve\n",
        "lib/index.js": "permision\n",
        "src/lib/a.ts": "// teh\n",
      },
      found: ["./lib/index.js:1 permision", "./src/lib/a.ts:1 teh"],
    },
  ])("end to end: $reason", ({ files, found }) => {
    const repo = temp.dir("typos-e2e-");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), text);
    }
    const run = boundedSpawnSync(
      [typosBinary ?? "typos", "--config", FLEET_CONFIG, "--format", "brief", "."],
      { cwd: repo },
    );
    // `--format brief` prints `path:line:col: error: \`word\` should be ...`; the column and the suggestion are the
    // dictionary's, not the rule's.
    const reported = run.stdout
      .trimEnd()
      .split("\n")
      .map((line) => /^(\S+:\d+):\d+: error: `([^`]+)`/.exec(line))
      .map((match) => (match === null ? "unparsed line" : `${match[1]} ${match[2]}`))
      .sort();
    expect([run.exitCode, reported]).toEqual([2, found]);
  });
});
