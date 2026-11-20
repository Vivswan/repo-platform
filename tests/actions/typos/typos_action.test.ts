// typos layers --config over the _typos.toml it discovers at the checkout root (external): the action's description
// promises the extension, and a typos release that replaced instead of layering would drop every repository's words at
// once. The end-to-end rows run the action's own step, so the typos is the one its lock names, and read the findings
// through the action's problem matcher, the way the runner annotates them.
//   locally        -> skipped without uv
//   UV_REQUIRED=1  -> mandatory; checks.yml's script-tests job sets it after its setup-uv

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAction, REPO_ROOT, runBashStep, stepNamed } from "../../shared/action_step";
import { tempDirs } from "../../shared/temp_dir";
import { UV_TIMEOUT_MS, uvEnv, uvOnPath } from "../../shared/uv_project";

const temp = tempDirs();
const ACTION = join(REPO_ROOT, "actions/typos");
const CHECK = stepNamed(loadAction("actions/typos/action.yml"), "Check spelling");

interface Annotation {
  file: string;
  line: number;
  column: number;
  message: string;
}

const MATCHER = (
  JSON.parse(readFileSync(join(ACTION, "typos-matcher.json"), "utf8")) as {
    problemMatcher: [
      {
        pattern: [{ regexp: string; file: number; line: number; column: number; message: number }];
      },
    ];
  }
).problemMatcher[0].pattern[0];

/** The annotations the runner makes of `log` with the action's matcher, one per matching line. */
function annotations(log: string): Annotation[] {
  return log.split("\n").flatMap((line) => {
    const found = new RegExp(MATCHER.regexp).exec(line);
    if (found === null) return [];

    return [
      {
        file: found[MATCHER.file],
        line: Number(found[MATCHER.line]),
        column: Number(found[MATCHER.column]),
        message: found[MATCHER.message],
      },
    ];
  });
}

describe("actions/typos", () => {
  // The lines are typos 1.51.1's `--format brief`, hand-written: a finding in a file's name carries no place, so it
  // fails the step and annotates nothing.
  test("the matcher reads a misspelling's and a disallowed word's place and message, and nothing of a line that names no place", () => {
    const log = [
      "./docs/a b.md:12:7: error: `teh` should be `the`",
      "./src/x.ts:3:1: error: `mis` should be `miss`, `mist`",
      "./src/x.ts:4:9: error: `hello` is disallowed",
      "error: `seperate` should be `separate`",
      "error: the config could not be read",
      "",
    ].join("\n");
    expect(annotations(log)).toEqual([
      { file: "./docs/a b.md", line: 12, column: 7, message: "`teh` should be `the`" },
      { file: "./src/x.ts", line: 3, column: 1, message: "`mis` should be `miss`, `mist`" },
      { file: "./src/x.ts", line: 4, column: 9, message: "`hello` is disallowed" },
    ]);
  });

  // typos exits 2 on findings, 0 when clean; a fixture tree is the axis. The findings are asserted whole, as
  // `path:line word`, so a rule that widened or narrowed shows the line it changed; every misspelling is unique to
  // its line so no other line can stand in for it.
  test.skipIf(!uvOnPath()).each<{
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
  ])(
    "end to end: $reason",
    ({ files, found }) => {
      const repo = temp.dir("typos-e2e-");
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(repo, rel, ".."), { recursive: true });
        writeFileSync(join(repo, rel), text);
      }
      const run = runBashStep(CHECK, {
        env: { ...uvEnv(), GITHUB_ACTION_PATH: ACTION },
        cwd: repo,
        root: temp.dir("typos-e2e-step-"),
        timeoutMs: UV_TIMEOUT_MS,
      });
      // The column and the suggestion are the dictionary's, not the rule's.
      const reported = annotations(run.stdout)
        .map(({ file, line, message }) => `${file}:${line} ${/^`([^`]+)`/.exec(message)?.[1]}`)
        .sort();
      expect([run.exitCode, reported]).toEqual([2, found]);
    },
    UV_TIMEOUT_MS,
  );
});
