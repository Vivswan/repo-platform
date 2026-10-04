// The verdict per construct rides on an external parser's node vocabulary (mvdan/sh's NodeType strings, PowerShell's AST
// class names), the collector on the yaml package's scalar positions (a block scalar's content starts the line after its
// header) and GitHub's runner defaults, and the regression scenario is a long bash block that tests a `$(...)` inside
// `[ ]`, where `set -e` does not reach a failed command, which one `bun script.ts` line replaces.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALLOWLIST_FILE,
  check,
  REASON_RULE,
} from "../../../actions/check-shell-complexity/check-shell-complexity.ts";
import { type Collected, collectFile } from "../../../actions/check-shell-complexity/collect.ts";
import {
  type Dialect,
  judgeBash,
  judgeCmd,
  judgePowerShell,
  type Refusal,
} from "../../../actions/check-shell-complexity/judge.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { checkout } from "../../shared/fixture_checkout.ts";
import { fixtureGitEnv } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const SCRIPT = resolve(
  import.meta.dir,
  "../../../actions/check-shell-complexity/check-shell-complexity.ts",
);

function judge(dialect: Dialect, code: string, powershell: Map<string, Refusal[]>): Refusal[] {
  if (dialect === "bash") return judgeBash(code);
  if (dialect === "cmd") return judgeCmd(code);
  return powershell.get(code) ?? [];
}

const at = (line: number, construct: string): Refusal => ({ line, construct });

type RuleRow = [name: string, dialect: Dialect, code: string, expected: Refusal[]];

describe("the rule, per construct and dialect", () => {
  const ROWS: RuleRow[] = [
    ["bash: one if passes", "bash", "if [ -f x ]; then\n  cat x\nfi\n", []],
    [
      "bash: if, elif, and else are one level",
      "bash",
      'if [ -z "$X" ]; then\n  echo no\nelif [ -n "$Y" ]; then\n  echo y\nelse\n  echo else\nfi\n',
      [],
    ],
    ["bash: one for passes", "bash", 'for f in a b; do\n  echo "$f"\ndone\n', []],
    ["bash: one case passes", "bash", 'case "$p" in\n  /*) ;;\n  *) p="" ;;\nesac\n', []],
    ["bash: one || chain passes", "bash", "a || b || c\n", []],
    ["bash: one tested substitution passes", "bash", '[ "$(git rev-parse HEAD)" = "$SHA" ]\n', []],
    [
      "bash: a substitution inside a tested one feeds the inner command, not the test",
      "bash",
      '[ "$(echo "$(cat x)" >&2; echo ok)" = ok ]\n',
      [],
    ],
    [
      "bash: an if inside a for",
      "bash",
      'for f in *; do\n  if [ -f "$f" ]; then cat "$f"; fi\ndone\n',
      [at(2, "if inside for")],
    ],
    [
      "bash: a case inside an if",
      "bash",
      'if true; then\n  case "$x" in a) ;; esac\nfi\n',
      [at(2, "case inside if")],
    ],
    [
      "bash: a || inside an if body",
      "bash",
      "if true; then\n  make || echo failed\nfi\n",
      [at(2, "|| inside if")],
    ],
    [
      "bash: a tested substitution inside a while, through a path-qualified test",
      "bash",
      'while read -r l; do\n  /usr/bin/test -n "$(echo "$l")"\ndone < in\n',
      [at(2, "$(...) tested inside while")],
    ],
    [
      "bash: a tested substitution in an if condition is inside the if",
      "bash",
      'if [ "$(cat x)" = y ]; then\n  echo y\nfi\n',
      [at(1, "$(...) tested inside if")],
    ],
    [
      "bash: command -v only looks test up, so the substitution is not tested",
      "bash",
      'for f in a; do\n  command -v test "$(ls)"\ndone\n',
      [],
    ],
    [
      "bash: a substitution in the test command's assignment prefix is assigned, not tested",
      "bash",
      'if X="$(printf x)" test -n ok; then :; fi\n',
      [],
    ],
    ["bash: a posix function", "bash", "greet() {\n  echo hi\n}\ngreet\n", [at(1, "function")]],
    ["bash: a keyword function", "bash", "function greet {\n  echo hi\n}\n", [at(1, "function")]],
    [
      "bash: a function inside an if is still a function",
      "bash",
      "if true; then\n  greet() { echo hi; }\nfi\n",
      [at(2, "function")],
    ],
    [
      "bash: a body that does not parse is a finding at the parser's line",
      "bash",
      "bun install\nif [ x; then\n",
      [at(2, 'does not parse as bash: if statement must end with "fi"')],
    ],
    [
      "bash: a straight line of commands",
      "bash",
      [
        "set -euo pipefail",
        "bun install --frozen-lockfile",
        "bun run build && bun run test",
        'git ls-files -z | xargs -0 wc -l > "$RUNNER_TEMP/sizes"',
        'version="$(cat .bun-version)"',
        'echo "version=$version" >> "$GITHUB_OUTPUT"',
        'echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"',
        'SEED="${SEED:-$RANDOM$RANDOM}"',
        "! test -d gone",
        "(cd pkg && bun run build)",
        "",
      ].join("\n"),
      [],
    ],
    ["powershell: one if passes", "powershell", "if ($env:X) {\n  Write-Output no\n}\n", []],
    ["powershell: one switch passes", "powershell", 'switch ($x) {\n  1 { "one" }\n}\n', []],
    [
      "powershell: an if inside a foreach",
      "powershell",
      "foreach ($f in Get-ChildItem) {\n  if ($f.Length) { $f.Name }\n}\n",
      [at(2, "if inside foreach")],
    ],
    [
      "powershell: a || inside a try",
      "powershell",
      "try {\n  bun run build || Write-Output failed\n} catch {\n  'no'\n}\n",
      [at(2, "|| inside try")],
    ],
    ["powershell: a function", "powershell", 'function Greet {\n  "hi"\n}\n', [at(1, "function")]],
    [
      "powershell: a function inside an if is still a function",
      "powershell",
      'if ($x) {\n  function Greet { "hi" }\n}\n',
      [at(2, "function")],
    ],
    [
      "powershell: a body that does not parse is a finding per parse error, at its line",
      "powershell",
      "if ($x {\n",
      [
        at(1, "does not parse as PowerShell: Unexpected token '{' in expression or statement."),
        at(
          1,
          "does not parse as PowerShell: Missing closing ')' after expression in 'if' statement.",
        ),
        at(
          1,
          "does not parse as PowerShell: Missing closing '}' in statement block or type definition.",
        ),
      ],
    ],
    [
      "powershell: a straight line of commands",
      "powershell",
      [
        "$ErrorActionPreference = 'Stop'",
        "bun install --frozen-lockfile",
        "Get-ChildItem -Recurse | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.FullName }",
        "$version = Get-Content .bun-version",
        '"version=$version" >> $env:GITHUB_OUTPUT',
        "",
      ].join("\n"),
      [],
    ],
    ["cmd: one if passes", "cmd", "@echo off\nrem the build\nif exist out rmdir /s /q out\n", []],
    [
      "cmd: two constructs are refused at the second, counted by keyword",
      "cmd",
      "if exist out rmdir /s /q out\nfor %%f in (*.log) do del %%f\n",
      [at(2, "2 constructs (if, for)")],
    ],
    ["cmd: goto", "cmd", "goto :eof\n", [at(1, "goto")]],
    [
      "cmd: two ifs on one line are two constructs",
      "cmd",
      "if exist x if exist y echo ok\n",
      [at(1, "2 constructs (if, if)")],
    ],
    [
      "cmd: a label and a call to it",
      "cmd",
      "call :build\n:build\nbun run build\n",
      [at(1, "call :label"), at(2, "label")],
    ],
  ];
  // One pwsh for every PowerShell row, as the action batches them: a cold pwsh takes seconds on a runner, longer than
  // one test's budget, and the rows' bodies are their ids.
  const powershell = judgePowerShell(
    ROWS.filter(([, dialect]) => dialect === "powershell").map(([, dialect, code]) => ({
      id: code,
      dialect,
      code,
    })),
  );
  test.each(ROWS)("%s", (_name, dialect, code, expected) => {
    expect(judge(dialect, code, powershell)).toEqual(expected);
  });
});

describe("the collector", () => {
  // One file per source kind, the body text and its first line as the finding will cite them.
  const WORKFLOW = [
    "name: CI",
    "on: push",
    "env:",
    "  SCRIPT: &script bun run lint",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: bun install",
    "      - name: Build",
    "        run: |",
    "          bun run build",
    "          bun run test",
    "      - shell: pwsh",
    "        run: Write-Output hi",
    "      - shell: cmd",
    "        run: bun run build",
    "      - shell: python",
    "        run: print('hi')",
    "      - run: |",
    '          echo "${{',
    "            github.sha",
    '          }}" | cat',
    "          bun run build",
    "      - run: *script",
    `      - run: printf '%s' '\${{ format('{{"sha":"{0}"}}', github.sha) }}'`,
    "  windows:",
    "    runs-on: windows-latest",
    "    steps:",
    "      - run: Get-Date",
    "      - shell: &ps pwsh",
    "        run: Write-Output anchored",
    "      - shell: *ps",
    "        run: Write-Output aliased",
    "      - shell: bash -e {0}",
    "        run: >-",
    "          bun run",
    "          build",
    "",
  ].join("\n");
  const ACTION = [
    "name: Pin",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - shell: bash",
    "      run: |",
    "        bun install",
    "    - uses: actions/checkout@v7",
    "",
  ].join("\n");
  const MOON = ["tasks:", "  build:", "    script: |", "      bun run build", ""].join("\n");
  const CONTAINERFILE = [
    "FROM alpine",
    "RUN apk add --no-cache curl \\",
    "    && curl -fsSL https://example.com/x -o /x",
    'RUN ["echo", "exec form"]',
    "RUN --mount=type=cache,target=/root/.cache bun install",
    "RUN <<EOF",
    "bun run build",
    "bun run test",
    "EOF",
    "RUN cat <<EOF",
    "if true; then echo data; fi",
    "EOF",
    'SHELL ["pwsh", "-Command"]',
    "RUN Write-Output hi",
    'SHELL ["C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe", "-Command"]',
    "RUN Write-Output exe",
    "FROM alpine AS tools",
    'SHELL ["python3", "-c"]',
    "RUN print(1)",
    "FROM Tools",
    "RUN print(2)",
    "FROM alpine:3 AS alpine",
    "RUN [ -f /x ]",
    "RUN <<EOF cat",
    "data",
    "EOF",
    "RUN <<EOF-SCRIPT",
    "if true; then echo x; fi",
    "EOF-SCRIPT",
    "RUN <<EOF",
    "#!/usr/bin/env python3",
    "print(1)",
    "EOF",
    "RUN <<EOF",
    "#!/bin/bash",
    "echo hi",
    "EOF",
    "RUN <<-EOF",
    "\t#!/usr/bin/env python3",
    "\tprint(2)",
    "EOF",
    "RUN <<EOF",
    "\t#!/usr/bin/env python3",
    "\techo a tab-led comment, not a shebang",
    "EOF",
    'SHELL ["/bin/dash", "-c"]',
    "RUN <<EOF",
    "#!/bin/bash",
    "echo under dash",
    "EOF",
    "",
  ].join("\n");
  const body = (
    path: string,
    line: number,
    kind: Collected["bodies"][number]["kind"],
    dialect: Dialect,
    code: string,
  ) => ({ path, line, kind, dialect, code });
  test.each<[string, string, Collected]>([
    [
      ".github/workflows/ci.yml",
      WORKFLOW,
      {
        bodies: [
          body(".github/workflows/ci.yml", 9, "workflow", "bash", "bun install"),
          body(".github/workflows/ci.yml", 12, "workflow", "bash", "bun run build\nbun run test\n"),
          body(".github/workflows/ci.yml", 15, "workflow", "powershell", "Write-Output hi"),
          body(".github/workflows/ci.yml", 17, "workflow", "cmd", "bun run build"),
          body(
            ".github/workflows/ci.yml",
            21,
            "workflow",
            "bash",
            'echo "expression \\\n \\\n" | cat\nbun run build\n',
          ),
          body(".github/workflows/ci.yml", 4, "workflow", "bash", "bun run lint"),
          body(".github/workflows/ci.yml", 26, "workflow", "bash", "printf '%s' 'expression'"),
          body(".github/workflows/ci.yml", 30, "workflow", "powershell", "Get-Date"),
          body(".github/workflows/ci.yml", 32, "workflow", "powershell", "Write-Output anchored"),
          body(".github/workflows/ci.yml", 34, "workflow", "powershell", "Write-Output aliased"),
          body(".github/workflows/ci.yml", 37, "workflow", "bash", "bun run build"),
        ],
        problems: [],
      },
    ],
    [
      "tools/pin/action.yml",
      ACTION,
      {
        bodies: [body("tools/pin/action.yml", 7, "action", "bash", "bun install\n")],
        problems: [],
      },
    ],
    [
      "moon.yml",
      MOON,
      { bodies: [body("moon.yml", 4, "moon", "bash", "bun run build\n")], problems: [] },
    ],
    [
      "Containerfile",
      CONTAINERFILE,
      {
        bodies: [
          body(
            "Containerfile",
            2,
            "containerfile",
            "bash",
            "apk add --no-cache curl     && curl -fsSL https://example.com/x -o /x",
          ),
          body("Containerfile", 5, "containerfile", "bash", "bun install"),
          body("Containerfile", 7, "containerfile", "bash", "bun run build\nbun run test"),
          body(
            "Containerfile",
            10,
            "containerfile",
            "bash",
            "cat <<EOF\nif true; then echo data; fi\nEOF",
          ),
          body("Containerfile", 14, "containerfile", "powershell", "Write-Output hi"),
          body("Containerfile", 16, "containerfile", "powershell", "Write-Output exe"),
          body("Containerfile", 23, "containerfile", "bash", "[ -f /x ]"),
          body("Containerfile", 24, "containerfile", "bash", "<<EOF cat\ndata\nEOF"),
          body("Containerfile", 28, "containerfile", "bash", "if true; then echo x; fi"),
          body("Containerfile", 35, "containerfile", "bash", "#!/bin/bash\necho hi"),
          body(
            "Containerfile",
            43,
            "containerfile",
            "bash",
            "\t#!/usr/bin/env python3\n\techo a tab-led comment, not a shebang",
          ),
          body("Containerfile", 48, "containerfile", "bash", "#!/bin/bash\necho under dash"),
        ],
        problems: [],
      },
    ],
    [
      ".husky/pre-commit",
      "#!/bin/sh\nfor x in a; do echo $x; done\n",
      {
        bodies: [
          body(
            ".husky/pre-commit",
            1,
            "script",
            "bash",
            "#!/bin/sh\nfor x in a; do echo $x; done\n",
          ),
        ],
        problems: [],
      },
    ],
    [
      "bin/release",
      "#!/usr/bin/env pwsh\nGet-Date\n",
      {
        bodies: [body("bin/release", 1, "script", "powershell", "#!/usr/bin/env pwsh\nGet-Date\n")],
        problems: [],
      },
    ],
    ["bin/tool", "#!/usr/bin/env python3\nprint(1)\n", { bodies: [], problems: [] }],
    [
      ".profile",
      "#!/bin/sh\nexport PATH=/opt/bin:$PATH\n",
      {
        bodies: [body(".profile", 1, "script", "bash", "#!/bin/sh\nexport PATH=/opt/bin:$PATH\n")],
        problems: [],
      },
    ],
    [
      ".github/workflows/broken.yml",
      "jobs:\n  a:\n    steps:\n      - run: x\n   bad: [\n",
      {
        bodies: [],
        problems: [
          {
            path: ".github/workflows/broken.yml",
            line: 5,
            message: expect.stringMatching(/^not readable as yaml: /) as unknown as string,
          },
        ],
      },
    ],
  ])("%s", (path, text, expected) => {
    expect(collectFile(path, text)).toEqual(expected);
  });
});

describe("the check over a checkout", () => {
  // The regression scenario's shape: `set -e` does not reach the `$(...)` inside `[ ]`, so a failed `git rev-parse`
  // reads as an empty string and the `if` takes a branch, green. The tested substitution sits inside the `if`, one
  // level too deep; the `if` and the `||` on their own pass. One line of glue replaces the block.
  const INCIDENT = [
    "name: Release",
    "on: push",
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "      - name: Judge the release",
    "        env:",
    "          GH_TOKEN: ${{ github.token }}",
    "        run: |",
    "          set -euo pipefail",
    '          tag="$(gh release list --limit 1 --json tagName --jq ".[0].tagName")"',
    '          head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/main" --jq .object.sha)"',
    '          if [ -z "$tag" ]; then',
    '            echo "::notice::no release yet"',
    "            exit 0",
    "          fi",
    '          gh release view "$tag" || echo "::warning::$tag is unreadable"',
    '          if [ "$(git rev-parse "$tag")" = "$head" ]; then',
    '            echo "released=true" >> "$GITHUB_OUTPUT"',
    "          else",
    '            echo "released=false" >> "$GITHUB_OUTPUT"',
    "          fi",
    "",
  ].join("\n");
  const GLUE = INCIDENT.replace(
    / {8}run: \|[\s\S]*$/,
    "        run: bun .github/scripts/judge_release.ts\n",
  );
  const PIN_ACTION = [
    "name: Pin",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - shell: bash",
    "      run: |",
    '        while [ ! -f "$dir/.bun-version" ]; do',
    '          if [ -z "$dir" ]; then exit 1; fi',
    '          dir="${dir%/*}"',
    "        done",
    "",
  ].join("\n");

  function run(root: string) {
    const output = join(root, "github-output.txt");
    const report = join(root, "report.md");
    writeFileSync(output, "");
    const proc = boundedSpawnSync(["bun", SCRIPT, root], {
      env: { ...fixtureGitEnv(), GITHUB_OUTPUT: output, REPORT_PATH: report },
      timeoutMs: 60_000,
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout,
      stderr: proc.stderr,
      output: readFileSync(output, "utf8"),
      report: ((): string | null => {
        try {
          return readFileSync(report, "utf8");
        } catch {
          return null;
        }
      })(),
    };
  }

  const REMEDY = `move this block to a TypeScript script run by bun, or list the file in ${ALLOWLIST_FILE} with a # reason`;

  test("the incident block is refused at its lines, an exempted action is not, and the report carries the table", () => {
    const root = checkout(temp, "check-shell-complexity-", {
      ".github/workflows/release.yml": INCIDENT,
      "actions/pin/action.yml": PIN_ACTION,
      [ALLOWLIST_FILE]: "actions/pin/action.yml # the pre-bun pin walk\n",
    });
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: [
        `::error file=.github/workflows/release.yml,line=20::.github/workflows/release.yml:20: $(...) tested inside if; ${REMEDY}`,
        `1 finding(s). Shell may nest no construct inside another; ${REMEDY}.`,
        "",
      ].join("\n"),
      output: "report=findings\n",
      report: [
        "## Shell complexity check",
        "",
        "1 refused construct(s) (fails).",
        "",
        "| Where | Construct | Source |",
        "| --- | --- | --- |",
        "| `.github/workflows/release.yml:20` | `$(...) tested inside if` | workflow run step, bash/sh/zsh |",
        "",
        `Move each block to a TypeScript script run by bun, or list the file in \`${ALLOWLIST_FILE}\` with a \`# reason\` (a block that must stay shell).`,
        "",
        "Bodies judged: 1 workflow run step, 1 composite action run step.",
        "",
      ].join("\n"),
    });
  });

  test("the same work as one bun line is clean and records report=clean, and a managed file is skipped and counted", () => {
    const root = checkout(temp, "check-shell-complexity-", {
      ".github/workflows/release.yml": GLUE,
      ".github/workflows/managed.yml": `# This file is managed by octocat/repo-platform.\n${INCIDENT}`,
    });
    expect(run(root)).toEqual({
      exitCode: 0,
      stdout:
        "Shell complexity check passed. Bodies judged: 1 workflow run step. 1 managed file(s) skipped; repo-platform owns them.\n",
      stderr: "",
      output: "report=clean\n",
      report: null,
    });
  });

  test("an allow-list entry without a reason and a stale one fail the check", () => {
    const root = checkout(temp, "check-shell-complexity-", {
      ".github/workflows/release.yml": GLUE,
      "scripts/run.sh": "bun run build\n",
      [ALLOWLIST_FILE]: "scripts/run.sh\n.github/workflows/release.yml # was shell once\n",
    });
    const result = run(root);
    expect([result.exitCode, result.stderr]).toEqual([
      1,
      [
        `::error::${ALLOWLIST_FILE}:1: 'scripts/run.sh' has no '# reason'; ${REASON_RULE}`,
        `::error::${ALLOWLIST_FILE}:2: '.github/workflows/release.yml' is stale (no refused construct, or not a tracked file); remove the entry`,
        `2 finding(s). Shell may nest no construct inside another; ${REMEDY}.`,
        "",
      ].join("\n"),
    ]);
  });

  // A written fleet tree's ci.yml shares its name with this checkout's, so an annotation at the written path would
  // land on the wrong file: the finding names the template that produced it, and the written line only where the
  // template's lines are not the written file's.
  test("a finding in a written tree is reported against its template, the line mapped or named as the tree's", () => {
    const NESTED = [
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: |",
      "          for f in *; do",
      '            if [ -f "$f" ]; then cat "$f"; fi',
      "          done",
      "",
    ].join("\n");
    const root = checkout(temp, "check-shell-complexity-", {
      ".github/workflows/ci.yml": `# This file is managed by octocat/repo-platform.\n${NESTED}`,
      ".github/workflows/checks.yml": NESTED,
      ".github/workflows/local.yml": NESTED,
    });
    const verdict = check(root, {
      judgeManaged: true,
      written: {
        tree: "all",
        templates: {
          ".github/workflows/ci.yml": {
            path: "files/base/.github/workflows/ci.yml",
            lineMapped: true,
          },
          ".github/workflows/checks.yml": {
            path: "files/base/.github/workflows/checks.yml",
            lineMapped: false,
          },
        },
      },
    });
    const at = (path: string, line: number, written?: { tree: string }) => ({
      path,
      line,
      construct: "if inside for",
      source: "workflow" as const,
      dialect: "bash" as const,
      ...(written === undefined ? {} : { written }),
    });
    expect(verdict.findings).toEqual([
      at("files/base/.github/workflows/checks.yml", 8, { tree: "all" }),
      at("files/base/.github/workflows/ci.yml", 9),
      at(".github/workflows/local.yml", 8, { tree: "all" }),
    ]);
  });
});
