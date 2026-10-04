// The verdict per construct rides on an external parser's node vocabulary (mvdan/sh's NodeType strings, PowerShell's AST
// class names), the collector on the yaml package's scalar positions (a block scalar's content starts the line after its
// header) and GitHub's runner defaults, and the regression scenario is a long bash block that tests a `$(...)` inside
// `[ ]`, where `set -e` does not reach a failed command, which one `bun script.ts` line replaces.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ALLOWLIST_FILE,
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
import { fixtureGit, fixtureGitEnv } from "../../shared/fixture_git.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const SCRIPT = resolve(
  import.meta.dir,
  "../../../actions/check-shell-complexity/check-shell-complexity.ts",
);

function judge(dialect: Dialect, code: string): Refusal[] {
  if (dialect === "bash") return judgeBash(code);
  if (dialect === "cmd") return judgeCmd(code);
  return judgePowerShell([{ id: "0", dialect, code }]).get("0") ?? [];
}

const at = (line: number, construct: string): Refusal => ({ line, construct });

describe("the rule, per construct and dialect", () => {
  test.each<[string, Dialect, string, Refusal[]]>([
    ["bash: if", "bash", 'if [ -z "$X" ]; then\n  echo no\nfi\n', [at(1, "if")]],
    [
      "bash: if, elif, and else are one construct",
      "bash",
      'if [ -z "$X" ]; then\n  echo no\nelif [ -n "$Y" ]; then\n  echo y\nelse\n  echo else\nfi\n',
      [at(1, "if")],
    ],
    ["bash: case", "bash", 'case "$p" in\n  /*) ;;\n  *) p="" ;;\nesac\n', [at(1, "case")]],
    ["bash: for", "bash", 'for f in a b; do\n  echo "$f"\ndone\n', [at(1, "for")]],
    ["bash: while", "bash", 'while read -r l; do\n  echo "$l"\ndone < in\n', [at(1, "while")]],
    ["bash: until", "bash", "until ping -c1 host; do\n  sleep 1\ndone\n", [at(1, "until")]],
    ["bash: a posix function", "bash", "greet() {\n  echo hi\n}\ngreet\n", [at(1, "function")]],
    ["bash: a keyword function", "bash", "function greet {\n  echo hi\n}\n", [at(1, "function")]],
    ["bash: ||", "bash", 'bun run build || echo "failed"\n', [at(1, "||")]],
    ["bash: a || chain is one finding", "bash", "a || b || c\n", [at(1, "||")]],
    [
      "bash: $(...) in [",
      "bash",
      '[ "$(git rev-parse HEAD)" = "$SHA" ]\n',
      [at(1, "$(...) tested")],
    ],
    ["bash: $(...) in [[", "bash", "[[ $(cat x) == y ]]\n", [at(1, "$(...) tested")]],
    ["bash: $(...) in test", "bash", 'test -n "$(ls dist)"\n', [at(1, "$(...) tested")]],
    [
      "bash: $(...) in test behind the command wrapper and its option",
      "bash",
      'command -p test -n "$(ls dist)"\n',
      [at(1, "$(...) tested")],
    ],
    ["bash: command -v only looks test up", "bash", 'command -v test "$(ls dist)"\n', []],
    [
      "bash: the line is the construct's, not the body's first",
      "bash",
      "bun install\nbun run build\nif [ -d dist ]; then\n  bun run test\nfi\n",
      [at(3, "if")],
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
    ["powershell: if", "powershell", "if ($env:X) {\n  Write-Output no\n}\n", [at(1, "if")]],
    ["powershell: switch", "powershell", 'switch ($x) {\n  1 { "one" }\n}\n', [at(1, "switch")]],
    ["powershell: for", "powershell", "for ($i = 0; $i -lt 3; $i++) {\n  $i\n}\n", [at(1, "for")]],
    [
      "powershell: foreach",
      "powershell",
      "foreach ($f in Get-ChildItem) {\n  $f.Name\n}\n",
      [at(1, "foreach")],
    ],
    ["powershell: while", "powershell", "while ($true) {\n  break\n}\n", [at(1, "while")]],
    [
      "powershell: do-while",
      "powershell",
      "do {\n  $x++\n} while ($x -lt 3)\n",
      [at(1, "do-while")],
    ],
    [
      "powershell: do-until",
      "powershell",
      "do {\n  $x++\n} until ($x -gt 3)\n",
      [at(1, "do-until")],
    ],
    ["powershell: function", "powershell", 'function Greet {\n  "hi"\n}\n', [at(1, "function")]],
    [
      "powershell: try",
      "powershell",
      'try {\n  Get-Item x\n} catch {\n  "no"\n}\n',
      [at(1, "try")],
    ],
    ["powershell: trap", "powershell", 'trap {\n  "oops"\n}\nGet-Item x\n', [at(1, "trap")]],
    ["powershell: throw", "powershell", 'Get-Item x\nthrow "no"\n', [at(2, "throw")]],
    ["powershell: ||", "powershell", "bun run build || Write-Output failed\n", [at(1, "||")]],
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
    [
      "cmd: a second command line and every keyword, each at its line, comment lines dropped",
      "cmd",
      "@echo off\nrem the build\n:: and the test\nif exist out rmdir /s /q out || goto :eof & for %%f in (*.log) do del %%f\ncall :build\n",
      [
        at(4, "a second command line"),
        at(4, "if"),
        at(4, "for"),
        at(4, "goto"),
        at(4, "||"),
        at(5, "call :label"),
      ],
    ],
    ["cmd: one command line", "cmd", "rem build\nbun run build --target windows\n", []],
    ["cmd: a continued line is one command", "cmd", "bun run build ^\n ^\n --target windows\n", []],
  ])("%s", (_name, dialect, code, expected) => {
    expect(judge(dialect, code)).toEqual(expected);
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
  const TEMPLATE = [
    "# This file is managed by {{github_username}}/repo-platform.",
    "jobs:",
    "  checks:",
    "    steps:",
    "      - uses: {{github_username}}/repo-platform/actions/plan@stable",
    "{{blocks}}",
    "      - run: bun run check",
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
      "files/base/.github/workflows/checks.yml",
      TEMPLATE,
      {
        bodies: [
          body("files/base/.github/workflows/checks.yml", 7, "workflow", "bash", "bun run check"),
        ],
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
          body("Containerfile", 21, "containerfile", "bash", "[ -f /x ]"),
          body("Containerfile", 22, "containerfile", "bash", "<<EOF cat\ndata\nEOF"),
        ],
        problems: [],
      },
    ],
    [
      "scripts/run.sh",
      "#!/bin/sh\nbun run build\n",
      {
        bodies: [body("scripts/run.sh", 1, "script", "bash", "#!/bin/sh\nbun run build\n")],
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
  // reads as an empty string and the `if` takes a branch, green. One line of glue replaces the block.
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
    '        if [ -z "$FROM" ]; then',
    "          exit 1",
    "        fi",
    "",
  ].join("\n");

  function checkout(files: Record<string, string>): string {
    const root = temp.dir("check-shell-complexity-");
    fixtureGit(root, ["init", "-q"]);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    fixtureGit(root, ["add", "-A"]);
    return root;
  }

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
    const root = checkout({
      ".github/workflows/release.yml": INCIDENT,
      "actions/pin/action.yml": PIN_ACTION,
      [ALLOWLIST_FILE]: "actions/pin/action.yml # the pre-bun pin walk\n",
    });
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: [
        `::error file=.github/workflows/release.yml,line=15::.github/workflows/release.yml:15: if; ${REMEDY}`,
        `::error file=.github/workflows/release.yml,line=19::.github/workflows/release.yml:19: ||; ${REMEDY}`,
        `::error file=.github/workflows/release.yml,line=20::.github/workflows/release.yml:20: $(...) tested; ${REMEDY}`,
        `::error file=.github/workflows/release.yml,line=20::.github/workflows/release.yml:20: if; ${REMEDY}`,
        `4 finding(s). Shell is a straight line of commands; ${REMEDY}.`,
        "",
      ].join("\n"),
      output: "report=findings\n",
      report: [
        "## Shell complexity check",
        "",
        "4 refused construct(s) (fails).",
        "",
        "| Where | Construct | Source |",
        "| --- | --- | --- |",
        "| `.github/workflows/release.yml:15` | `if` | workflow run step, bash/sh/zsh |",
        "| `.github/workflows/release.yml:19` | `\\|\\|` | workflow run step, bash/sh/zsh |",
        "| `.github/workflows/release.yml:20` | `$(...) tested` | workflow run step, bash/sh/zsh |",
        "| `.github/workflows/release.yml:20` | `if` | workflow run step, bash/sh/zsh |",
        "",
        `Move each block to a TypeScript script run by bun, or list the file in \`${ALLOWLIST_FILE}\` with a \`# reason\` (a block that must stay shell).`,
        "",
        "Bodies judged: 1 workflow run step, 1 composite action run step.",
        "",
      ].join("\n"),
    });
  });

  test("the same work as one bun line is clean and records report=clean, and a managed file is skipped and counted", () => {
    const root = checkout({
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
    const root = checkout({
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
        `2 finding(s). Shell is a straight line of commands; ${REMEDY}.`,
        "",
      ].join("\n"),
    ]);
  });
});
