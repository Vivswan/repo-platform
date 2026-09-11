import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  ALLOWLIST_FILE,
  COMMENT_CAPS,
  COMMENT_MARKER,
  type CommentScope,
  check,
  classify,
  describe as describeFinding,
  type Finding,
  GRAMMAR_WASMS,
  type Grammar,
  type Grammars,
  HARD,
  isGenerated,
  isManaged,
  isUnbreakable,
  judgeFile,
  type Kind,
  loadGrammars,
  type Outcome,
  outcomeOf,
  parseAllowlist,
  parseArgs,
  REASON_RULE,
  report,
  type Tier,
  type Verdict,
  WARN,
} from "../../../actions/check-file-size/check-file-size.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const grammars = await loadGrammars();
const ACTION_DIR = resolve(import.meta.dir, "../../../actions/check-file-size");
const SCRIPT = join(ACTION_DIR, "check-file-size.ts");
const REPO_ROOT = resolve(import.meta.dir, "../../..");

function git(root: string, ...args: string[]): void {
  const proc = boundedSpawnSync(["git", "-C", root, ...args]);
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`);
}

/** A git checkout holding `tracked` (added to the index) and `untracked`
 *  (on disk only). */
function checkout(tracked: Record<string, string>, untracked: Record<string, string> = {}): string {
  const root = temp.dir("check-file-size-");
  git(root, "init", "-q");
  for (const [rel, text] of Object.entries({ ...tracked, ...untracked })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  git(root, "add", "-A", ...Object.keys(tracked));
  return root;
}

const lines = (count: number): string => `${Array.from({ length: count }, () => "x").join("\n")}\n`;
const MANAGED = "# This file is managed by Vivswan/repo-platform.\n";

describe("classify", () => {
  test.each<[string, Kind | null]>([
    ["src/app.ts", "source"],
    ["src/App.tsx", "source"],
    ["src/app.mts", "source"],
    ["lib/util.cjs", "source"],
    ["pkg/types.pyi", "source"],
    ["lib/mod.rs", "source"],
    ["Main.java", "source"],
    ["include/x.h", "source"],
    ["src/app.test.ts", "test"],
    ["src/widget.spec.ts", "test"],
    ["pkg/foo_test.go", "test"],
    ["spec/foo_spec.rb", null],
    ["test_module.py", "test"],
    ["tests/helper.ts", "test"],
    ["test/helpers/fixtures.ts", "test"],
    ["src/__tests__/util.js", "test"],
    ["src/policy/store_tests.rs", "test"],
    ["src/policy/tests.rs", "test"],
    ["src/proptests.rs", "test"],
    ["src/tests_util.rs", "source"],
    ["src/large.cc", "source"],
    ["include/x.hpp", "source"],
    ["src/a.cxx", "source"],
    ["include/b.hh", "source"],
    ["src/testing/util.ts", "source"],
    [".github/workflows/ci.yml", "workflow"],
    [".github/workflows/ci.yaml", "workflow"],
    ["actions/check/action.yml", "workflow"],
    ["action.yml", "workflow"],
    [".github/workflows/nested/x.yml", null],
    ["config/settings.yml", null],
    ["scripts/run.sh", "shell"],
    ["bin/setup.bash", "shell"],
    [".zshrc.zsh", "shell"],
    ["README.md", "markdown"],
    ["docs/guide.md", "markdown"],
    ["package.json", null],
    ["bun.lock", null],
    ["logo.png", null],
    ["Makefile", null],
    ["node_modules/pkg/index.js", null],
    ["vendor/lib.go", null],
    ["tests/goldens/minimal/README.md", null],
    ["src/__snapshots__/app.test.ts", null],
  ])("%s -> %s", (path, kind) => {
    expect(classify(path)).toBe(kind);
  });
});

/** Abridged header excerpts of this repository's hand-written files that
 *  name a generator without declaring anything about themselves. */
const GENERATOR_MENTIONS: [string, string][] = [
  [
    "a helper naming the generator that calls it (action_steps.ts)",
    "// Composite action manifests read the way Actions reads them: their steps\n// and the action directories whose bun-setup step reads an action-local\n// .bun-version pin (scripts/generate/toolchain_pins.ts writes them).\n",
  ],
  [
    "a loader naming the outputs derived from it (files_config.ts)",
    "// Shared loader for files.yml (the writer's file table).\n//\n// scripts/generate/build_gitignore.ts derives the block files from\n// its modules; the sync writer reads them at runtime.\n",
  ],
  [
    "a checker naming the generator it audits (theme_tokens.ts)",
    "// Theme CSS behind `bun run theme` (scripts/generate/theme_tokens.ts +\n// actions/pages-site/.vitepress/theme/tokens.ts) agrees with the committed file\n",
  ],
  [
    "a table whose rows are a generated region (docs/new-repo.md)",
    "// The files table is generated from files.yml\n// (scripts/generate/files_table.ts);\n",
  ],
];

describe("isGenerated / isManaged", () => {
  test.each<[string, string, boolean, boolean]>([
    ...GENERATOR_MENTIONS.map(([name, text]): [string, string, boolean, boolean] => [
      name,
      text,
      false,
      false,
    ]),
    [
      "the gitignore generator's header comment",
      "# Generated from github/gitignore - do not edit between the BEGIN/END\nx\n",
      true,
      false,
    ],
    [
      "a go header, the directive after the tool",
      "// Code generated by protoc-gen-go. DO NOT EDIT.\nx\n",
      true,
      false,
    ],
    ["a jsdoc opener", "/** Generated by x. */\nx\n", true, false],
    [
      "rust-bindgen's header",
      "/* automatically generated by rust-bindgen 0.69.4 */\nx\n",
      true,
      false,
    ],
    ["flex's header", "/* A lexical scanner generated by flex */\nx\n", true, false],
    [
      "grammar-kit's header",
      "// This is a generated file. Not intended for manual editing.\nx\n",
      true,
      false,
    ],
    ["z3's header", "// automatically generated file.\nx\n", true, false],
    [
      "clang's header, the noun phrase continued",
      "/* This generated file is for internal use. Do not include it from headers. */\nx\n",
      true,
      false,
    ],
    [
      "the noun phrase in prose still counts: real headers continue it too (clang's)",
      "// repo's own copies, so each generated file has exactly one author: the\nx\n",
      true,
      false,
    ],
    [
      "generated by",
      "# Generated by Powerlevel10k configuration wizard on 2026-02-23.\nx\n",
      true,
      false,
    ],
    ["auto-generated", "// auto-generated, see the build\nx\n", true, false],
    ["autogenerated", "// AUTOGENERATED FILE\nx\n", true, false],
    ["this file is generated", "/* This file is generated. */\nx\n", true, false],
    ["do not edit", "# DO NOT EDIT - built from the manifests\nx\n", true, false],
    ["generated file", "<!-- generated file -->\nx\n", true, false],
    ["a marker on the tenth line", `${lines(9)}// generated by x\n`, true, false],
    ["the managed header is managed, not generated", `${MANAGED}x\n`, false, true],
    [
      "a managed header with a dotted owner",
      "# This file is managed by a.b-c/repo-platform.\n",
      false,
      true,
    ],
    ["a string literal is not a header", 'const label = "do not edit";\n', false, false],
    [
      "prose using the word generate",
      "// Copies GENERATED from the manifests are NOT compared\nx\n",
      false,
      false,
    ],
    ["a marker past the header window", `${lines(10)}// generated by x\n`, false, false],
    ["a python docstring header", '"""Generated by foo."""\nx\n', true, false],
    ["a single-quoted docstring header", "'''Generated by foo.'''\nx\n", true, false],
    ["a bare string literal is not a comment", '"do not edit";\nx\n', false, false],
    [
      "a managed sentence in a string literal is not a header",
      'const note = "This file is managed by acme/repo-platform";\n',
      false,
      false,
    ],
    ["no header", "const x = 1;\n", false, false],
  ])("%s", (_name, text, generated, managed) => {
    expect([isGenerated(text), isManaged(text)]).toEqual([generated, managed]);
  });

  test("control: the retired path alternative skipped every generator mention", () => {
    const retired = /scripts\/generate\b/;
    const skipped = GENERATOR_MENTIONS.map(([, text]) =>
      text.split("\n", 10).some((line) => retired.test(line)),
    );
    expect(skipped).toEqual(GENERATOR_MENTIONS.map(() => true));
  });
});

describe("judgeFile line counts", () => {
  const kinds: Kind[] = ["source", "test", "workflow", "shell", "markdown"];
  // A 50-line matched generated region rides along in every fixture and
  // never counts; the same fixtures without it would judge identically.
  const region = `# BEGIN GENERATED: x\n${lines(48)}# END GENERATED: x\n`;
  test.each(kinds)("%s: at each cap passes, one over lands in that tier", (kind) => {
    const hard = HARD.lines[kind];
    const warn = WARN.lines[kind];
    const path = `file.${kind}`;
    expect(judgeFile(path, kind, `${region}${lines(warn)}`, grammars)).toEqual([]);
    expect(judgeFile(path, kind, `${lines(warn + 1)}${region}`, grammars)).toEqual([
      {
        path,
        kind,
        tier: "warn",
        measure: "lines",
        value: warn + 1,
        cap: warn,
      },
    ]);
    expect(judgeFile(path, kind, `${region}${lines(hard)}`, grammars)).toEqual([
      { path, kind, tier: "warn", measure: "lines", value: hard, cap: warn },
    ]);
    expect(judgeFile(path, kind, `${lines(hard + 1)}${region}`, grammars)).toEqual([
      {
        path,
        kind,
        tier: "hard",
        measure: "lines",
        value: hard + 1,
        cap: hard,
      },
    ]);
  });

  test("an unmatched BEGIN GENERATED fences nothing (control); both markers on one line fence that line", () => {
    const cap = HARD.lines.source;
    const finding = (value: number): Finding => ({
      path: "a.ts",
      kind: "source",
      tier: "hard",
      measure: "lines",
      value,
      cap,
    });
    expect(judgeFile("a.ts", "source", `// BEGIN GENERATED: x\n${lines(cap)}`, grammars)).toEqual([
      finding(cap + 1),
    ]);
    // The warn boundary, where one uncounted marker line decides.
    expect(
      judgeFile(
        "a.ts",
        "source",
        `// BEGIN GENERATED: x END GENERATED: x\n${lines(WARN.lines.source)}`,
        grammars,
      ),
    ).toEqual([]);
    expect(
      judgeFile(
        "a.ts",
        "source",
        `// BEGIN GENERATED: x END GENERATED: x\n${lines(cap + 1)}`,
        grammars,
      ),
    ).toEqual([finding(cap + 1)]);
  });

  test("a missing trailing newline still counts the last line; a trailing newline adds none", () => {
    const cap = HARD.lines.source;
    const finding = (tier: Tier, value: number, over: number): Finding => ({
      path: "a.ts",
      kind: "source",
      tier,
      measure: "lines",
      value,
      cap: over,
    });
    const body = Array.from({ length: cap + 1 }, () => "x").join("\n");
    expect(judgeFile("a.ts", "source", body, grammars)).toEqual([finding("hard", cap + 1, cap)]);
    expect(judgeFile("a.ts", "source", lines(cap), grammars)).toEqual([
      finding("warn", cap, WARN.lines.source),
    ]);
  });
});

describe("judgeFile line width", () => {
  const wide = (width: number, tokens = 4): string => {
    const each = Math.floor(width / tokens);
    return Array.from({ length: tokens }, (_, i) =>
      "a".repeat(each - (i < tokens - 1 ? 1 : 0)),
    ).join(" ");
  };
  /** Expected rows as [tier, line, width, cap]; expanded to whole width
   *  findings before comparing. */
  const widthFinding = (
    path: string,
    kind: Kind,
    [tier, line, value, cap]: (Tier | number)[],
  ): Finding => ({
    path,
    kind,
    tier: tier as Tier,
    measure: "width",
    line: line as number,
    value: value as number,
    cap: cap as number,
  });
  const judgeWidth = (path: string, text: string, expected: (Tier | number)[][]): void => {
    const kind = classify(path);
    if (kind === null) throw new Error(`${path} has no kind`);
    expect(judgeFile(path, kind, text, grammars)).toEqual(
      expected.map((row) => widthFinding(path, kind, row)),
    );
  };

  // Every case names its file, since the literal exemption follows the grammar.
  test.each<[string, string, string, (Tier | number)[][]]>([
    ["a breakable line over the hard cap", "f.ts", `${wide(300)}\n`, [["hard", 1, 300, 256]]],
    [
      "a breakable line over the warn cap only",
      "f.ts",
      `${wide(232)}\n`,
      [["warn", 1, 232, WARN.width]],
    ],
    ["a line at the warn cap", "f.ts", `${"a".repeat(WARN.width - 2)} b\n`, []],
    ["a CRLF line at the warn cap", "f.ts", `${"a".repeat(WARN.width - 2)} b\r\n`, []],
    ["a single unbreakable token over the hard cap", "f.ts", `${"u".repeat(300)}\n`, []],
    ["an indented single token over the hard cap", "f.ts", `    ${"u".repeat(300)}\n`, []],
    [
      "a literal assigned on one line is two tokens and fails (control for the single-token rule)",
      "f.ts",
      `const x = "${"a".repeat(280)}";\n`,
      [["hard", 1, 293, 256]],
    ],
    [
      "an unmatched BEGIN GENERATED fences no width either",
      "f.ts",
      `// BEGIN GENERATED: x\n${wide(300)}\n`,
      [["hard", 2, 300, 256]],
    ],
    [
      "a key with a wide value is two tokens and fails",
      ".github/workflows/f.yml",
      `  run: ${"u".repeat(300)}
`,
      [["hard", 1, 307, 256]],
    ],
    [
      "a line over the warn cap with one wide token among others still warns",
      "f.sh",
      `echo ${"u".repeat(190)} ${"v".repeat(30)}
`,
      [["warn", 1, 226, WARN.width]],
    ],
    [
      "a wide line inside a generated region, then the same line outside it",
      "f.ts",
      `// BEGIN GENERATED: x\n${wide(300)}\n// END GENERATED: x\n${wide(300)}\n`,
      [["hard", 4, 300, 256]],
    ],
    ["markdown prose has no width cap", "f.md", `${wide(1000)}\n`, []],
    [
      "width counts code points, not bytes",
      "f.ts",
      `${wide(232).replace(/a/g, "é")}\n`,
      [["warn", 1, 232, WARN.width]],
    ],
    [
      "a warn-wide line that is one assigned string literal",
      "f.ts",
      `const x = "${"a ".repeat(115)}";\n`,
      [],
    ],
    [
      "a warn-wide line that is one returned literal",
      "f.ts",
      `  return '${"a ".repeat(115)}';\n`,
      [],
    ],
    [
      "a warn-wide keyed literal with a trailing comma",
      "f.ts",
      `  key: \`${"a ".repeat(115)}\`,\n`,
      [],
    ],
    ["a warn-wide bash assignment", "f.sh", `msg="${"a ".repeat(115)}"\n`, []],
    ["a warn-wide concatenation piece", "f.ts", `  "${"a ".repeat(115)}" +\n`, []],
    ["a warn-wide regex literal", "f.test.ts", `const re = /${"a ".repeat(115)}/i;\n`, []],
    [
      "a hard-wide assigned literal is still a hard finding",
      "f.ts",
      `const x = "${"a ".repeat(150)}";\n`,
      [["hard", 1, 313, 256]],
    ],
    [
      "a warn-wide literal beside other code (control)",
      "f.ts",
      `  foo("${"a ".repeat(115)}", bar);\n`,
      [["warn", 1, 245, WARN.width]],
    ],
    ["a warn-wide python raw literal", "f.py", `pattern = r"${"a ".repeat(115)}"\n`, []],
    [
      "a warn-wide quoted yaml value; the same value unquoted is a plain scalar and warns (control)",
      ".github/workflows/f.yml",
      `name: "${"a ".repeat(115)}"\nname: ${"a ".repeat(115)}\n`,
      [["warn", 2, 236, WARN.width]],
    ],
    [
      "a warn-wide line inside a multi-line template literal is the literal's; the code line after it is not",
      "f.ts",
      `const t = \`\n${"a ".repeat(115)}\n\`;\nconst u = f(\n  ${"a ".repeat(115)}\n);\n`,
      [["warn", 5, 232, WARN.width]],
    ],
    [
      "a warn-wide line inside a python docstring is the string's",
      "f.py",
      `def f():\n    """\n    ${"a ".repeat(115)}\n    """\n`,
      [],
    ],
    [
      "a warn-wide literal with a trailing comment is judged (the comment can wrap)",
      "f.ts",
      `const x = "${"a ".repeat(100)}"; // c\n`,
      [["warn", 1, 218, WARN.width]],
    ],
    [
      "both markers on one line fence that line alone",
      "f.ts",
      `// BEGIN GENERATED: x ${wide(300)} END GENERATED: x\n${wide(300)}\n`,
      [["hard", 2, 300, 256]],
    ],
  ])("%s", (_name, path, text, expected) => {
    judgeWidth(path, text, expected);
  });

  // Each line is warn-wide (WARN.width < width <= HARD.width) and
  // breakable; a literal line yields no finding, anything else the whole
  // warn width finding.
  const F = "a ".repeat(110).trim();
  test.each<[string, string, string, boolean]>([
    ["a typed exported declaration", "f.ts", `export const x: Readonly<T[]> = "${F}";`, true],
    ["a template with a trailing comma", "f.ts", `let x = \`${F}\`,`, true],
    ["a returned regex with flags", "f.ts", `  return /${F}/gi`, true],
    ["a keyed literal with trailers", "f.ts", `key: '${F}')]`, true],
    ["a += assignment", "f.ts", `obj.key += "${F}"`, true],
    ["a python raw bytes prefix", "f.py", `rb"${F}"`, true],
    ["an escaped quote inside", "f.ts", `"esc\\"aped ${F}"`, true],
    ["an escaped slash inside a regex", "f.ts", `/a\\/b ${F}/`, true],
    ["a string holding comment syntax is a string", "f.ts", `const s = "// ${F}";`, true],
    ["a regex holding a comment opener is a regex", "f.ts", `const r = /\\/* ${F}/;`, true],
    ["a sole string argument", "f.ts", `throw new Error("${F}");`, true],
    ["a template literal type", "f.ts", `type X = \`${F}\`;`, true],
    [
      "a string-typed declaration: the type keyword is not a literal",
      "f.ts",
      `const x: string = "${F}";`,
      true,
    ],
    [
      "a long property name typed string holds no literal",
      "f.ts",
      `type T = { ${"a".repeat(145)}: string };`,
      false,
    ],
    [
      "a test title: only punctuation and keywords follow it",
      "f.ts",
      `test("${F}", async () => {`,
      true,
    ],
    [
      "a quoted key before a long value is a key, not a second literal",
      "f.ts",
      `const o = { "k": \`${F}\` };`,
      true,
    ],
    ["a quoted yaml key before a long value", ".github/workflows/f.yml", `"k": "${F}"`, true],
    ["a quoted python key before a long value", "f.py", `d = {"k": "${F}"}`, true],
    ["a quoted key alone is judged like any string beside code", "f.ts", `  "${F}": x,`, false],
    [
      "a ternary's two literals are two literals, not a key and a value",
      "f.ts",
      `const x = f ? "a" : "${F}";`,
      false,
    ],
    [
      "a comment before the literal keeps the row judged (the comment can wrap)",
      "f.ts",
      `/* ${"c ".repeat(20)}*/ const x = "${"a ".repeat(85)}";`,
      false,
    ],
    ["two literals joined on one line", "f.ts", `'${F}' + 'b'`, false],
    ["an unclosed literal", "f.ts", `const x = "unclosed ${F}`, false],
    ["a three-letter prefix is an identifier glued to a string", "f.py", `rbx"${F}"`, false],
    ["a tagged template (the tag is a call target)", "f.ts", `r\`${F}\``, false],
    ["a comment", "f.ts", `// ${F}`, false],
    ["a literal followed by code", "f.ts", `const x = "${F}" x`, false],
    ["a shell word before a string is a command", "f.sh", `echo "${F}"`, false],
    ["a shell regex match is a regex literal", "f.sh", `[[ $x =~ ^${"a".repeat(170)}$ ]]`, true],
  ])("%s", (_name, path, line, literal) => {
    const width = [...line].length;
    expect(width).toBeGreaterThan(WARN.width);
    expect(width).toBeLessThanOrEqual(HARD.width);
    judgeWidth(path, `${line}\n`, literal ? [] : [["warn", 1, width, WARN.width]]);
  });
});

describe("judgeFile comment blocks", () => {
  const { block: BLOCK, header: HEADER } = COMMENT_CAPS;
  const slashes = (count: number): string =>
    `${Array.from({ length: count }, (_, i) => `// c${i}`).join("\n")}\n`;
  const hashes = (count: number): string =>
    `${Array.from({ length: count }, (_, i) => `# c${i}`).join("\n")}\n`;
  /** A `/* ... *\/` comment of `count` lines including both delimiter lines. */
  const starred = (count: number, open = "/*"): string =>
    `${open}\n${Array.from({ length: count - 2 }, (_, i) => ` * c${i}`).join("\n")}\n */\n`;
  /** Expected rows: an over-cap block, or a bare marker line; every comment
   *  finding is a warning, so the tier is implied and the cap follows the
   *  scope. */
  type Row = [line: number, length: number, scope: CommentScope] | [marker: number];
  const commentFinding = (path: string, kind: Kind, row: Row): Finding =>
    row.length === 1
      ? { path, kind, tier: "warn", measure: "marker", line: row[0] }
      : {
          path,
          kind,
          tier: "warn",
          measure: "comment",
          line: row[0],
          value: row[1],
          cap: COMMENT_CAPS[row[2]],
          scope: row[2],
        };

  test("the caps: one warn-only tier per scope", () => {
    expect(COMMENT_CAPS).toEqual({ block: 10, header: 25 });
  });

  // Every case names its file, since the comment syntax follows the extension.
  test.each<[string, string, string, Row[]]>([
    ["a block at the cap passes", "f.ts", `x\n\n${slashes(BLOCK)}x\n`, []],
    [
      "a block one over the cap warns",
      "f.ts",
      `x\n\n${slashes(BLOCK + 1)}x\n`,
      [[3, BLOCK + 1, "block"]],
    ],
    [
      "a block far over the cap still only warns",
      "f.ts",
      `x\n\n${slashes(50)}x\n`,
      [[3, 50, "block"]],
    ],
    ["a header at the cap passes", "f.ts", `${slashes(HEADER)}x\n`, []],
    [
      "a header one over the cap warns",
      "f.ts",
      `${slashes(HEADER + 1)}x\n`,
      [[1, HEADER + 1, "header"]],
    ],
    [
      "a header after a shebang is still the header, and the shebang does not count",
      "f.ts",
      `#!/usr/bin/env bun\n${slashes(HEADER + 1)}x\n`,
      [[2, HEADER + 1, "header"]],
    ],
    [
      "a header after a shebang and a blank line",
      "f.sh",
      `#!/bin/sh\n\n${hashes(HEADER + 1)}echo x\n`,
      [[3, HEADER + 1, "header"]],
    ],
    [
      "a shebang alone is no comment block (control)",
      "f.sh",
      `#!/bin/sh\n${hashes(HEADER)}echo x\n`,
      [],
    ],
    [
      "a shebang with a space before the path is still a shebang",
      "f.py",
      `#! /usr/bin/env python3\n${hashes(HEADER + 1)}x = 1\n`,
      [[2, HEADER + 1, "header"]],
    ],
    [
      "a Rust inner attribute on line 1 is code, not a shebang",
      "f.rs",
      `#![allow(dead_code)]\n${slashes(BLOCK + 1)}pub fn f() {}\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a header past the block cap but under the header cap passes; the same block after code is judged as a block",
      "f.ts",
      `${slashes(BLOCK + 1)}x\n\n${slashes(BLOCK + 1)}x\n`,
      [[BLOCK + 4, BLOCK + 1, "block"]],
    ],
    [
      "a second block before any code is a block, not a header",
      "f.ts",
      `${slashes(2)}\n${slashes(BLOCK + 1)}x\n`,
      [[4, BLOCK + 1, "block"]],
    ],
    [
      "a /* */ block spanning lines counts every line, delimiters included",
      "f.ts",
      `x\n${starred(BLOCK + 1)}x\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a JSDoc block is a block",
      "f.mts",
      `x\n${starred(BLOCK + 1, "/**")}x\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a blank line inside a /* */ comment does not split it",
      "f.js",
      `x\n/*\n${"a\n\nb\n".repeat(3)}*/\nx\n`,
      [[2, 11, "block"]],
    ],
    [
      "a // run flowing into a /* */ block is one block",
      "f.ts",
      `x\n${slashes(BLOCK)}${starred(3)}x\n`,
      [[2, BLOCK + 3, "block"]],
    ],
    [
      "a closing delimiter followed by code is a code line: the block ends before it",
      "f.ts",
      `x\n/*\n${"a\n".repeat(BLOCK)}*/ y();\n${slashes(BLOCK)}x\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a closing delimiter followed by a comment continues the block",
      "f.ts",
      `x\n/*\n${"a\n".repeat(6)}*/ // b\n${slashes(9)}x\n`,
      [[2, 17, "block"]],
    ],
    [
      "a one-line /* */ followed by a // comment is a comment line",
      "f.ts",
      `x\n${"/* a */ // b\n".repeat(BLOCK + 1)}x\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    ["a one-line /* */ before code is code", "f.ts", `${"/* a */ x();\n".repeat(20)}`, []],
    [
      "a generated region before the header does not demote it: the header cap applies",
      "f.ts",
      `// BEGIN GENERATED: x\ng\n// END GENERATED: x\n${slashes(HEADER)}x\n`,
      [],
    ],
    [
      "the same header one over the header cap warns as a header, the region not counted",
      "f.ts",
      `// BEGIN GENERATED: x\ng\n// END GENERATED: x\n${slashes(HEADER + 1)}x\n`,
      [[4, HEADER + 1, "header"]],
    ],
    [
      "a code line between the region and the block still demotes it (control)",
      "f.ts",
      `// BEGIN GENERATED: x\ng\n// END GENERATED: x\nx\n${slashes(BLOCK + 1)}x\n`,
      [[5, BLOCK + 1, "block"]],
    ],
    [
      "a generated region ends the header run: the comments after it are a block",
      "f.ts",
      `${slashes(2)}// BEGIN GENERATED: x\n// END GENERATED: x\n${slashes(BLOCK + 1)}x\n`,
      [[5, BLOCK + 1, "block"]],
    ],
    [
      "a generated region inside an open /* */ contributes nothing and ends the run",
      "f.ts",
      `x();\n/*\n// BEGIN GENERATED: x\n${"g\n".repeat(20)}// END GENERATED: x\n*/\n`,
      [],
    ],
    [
      "a # run in a shell file",
      "f.sh",
      `echo x\n${hashes(BLOCK + 1)}echo y\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a # run in a workflow, indented under a key",
      ".github/workflows/ci.yml",
      `on: push\njobs:\n${hashes(BLOCK + 1).replace(/^/gm, "  ")}  a: b\n`,
      [[3, BLOCK + 1, "block"]],
    ],
    [
      "a # header in a python file",
      "f.py",
      `${hashes(HEADER + 1)}x = 1\n`,
      [[1, HEADER + 1, "header"]],
    ],
    [
      "directive lines count as comment lines",
      "f.sh",
      `echo x\n# shellcheck disable=SC2034\n${hashes(BLOCK)}echo y\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    ["an inline trailing comment is not a block", "f.ts", `${"x(); // c\n".repeat(50)}`, []],
    ["a blank line splits two blocks", "f.ts", `x\n${slashes(BLOCK)}\n${slashes(BLOCK)}x\n`, []],
    [
      "the same lines without the blank are one block (control)",
      "f.ts",
      `x\n${slashes(BLOCK)}${slashes(BLOCK)}x\n`,
      [[2, 2 * BLOCK, "block"]],
    ],
    ["markdown is prose: its # headings are not comments", "README.md", hashes(50), []],
    ["a # run in a // language is code", "f.ts", `x\n${hashes(50)}x\n`, []],
    ["a // run in a # language is code", "f.sh", `x\n${slashes(50)}x\n`, []],
    [
      "a comment block inside a generated region is not counted; the marker ends a run",
      "f.ts",
      `x\n${slashes(BLOCK)}// BEGIN GENERATED: x\n${slashes(50)}// END GENERATED: x\nx\n`,
      [],
    ],
    [
      "a CRLF file counts the same",
      "f.ts",
      `x\r\n\r\n${slashes(BLOCK + 1).replace(/\n/g, "\r\n")}x\r\n`,
      [[3, BLOCK + 1, "block"]],
    ],
    [
      "an unterminated /* is a syntax error, so the grammar makes it code, not a comment",
      "f.ts",
      `x\n/*\n${"a\n".repeat(BLOCK)}`,
      [],
    ],
    // Comment syntax inside literals is a literal: the grammar, not a prefix, decides.
    [
      "a string holding // is a string, so the run is code",
      "f.ts",
      `x\n${'const s = "// c";\n'.repeat(BLOCK + 1)}x\n`,
      [],
    ],
    [
      "a regex holding /* is a regex",
      "f.ts",
      `x\n${"const r = /\\/* c/;\n".repeat(BLOCK + 1)}x\n`,
      [],
    ],
    [
      "the lines inside a template literal are the literal's, whatever they start with",
      "f.ts",
      `x\nconst t = \`\n${"# c\n// c\n".repeat(BLOCK)}\`;\nx\n`,
      [],
    ],
    [
      "a python docstring is a string: it counts toward no comment cap, and it is code that demotes the header",
      "f.py",
      `"""\n${"doc\n".repeat(HEADER)}"""\n${hashes(BLOCK + 1)}x = 1\n`,
      [[HEADER + 3, BLOCK + 1, "block"]],
    ],
    [
      "a yaml comment run after a document marker is a block: the marker is code",
      ".github/workflows/f.yml",
      `---\n${hashes(BLOCK + 1)}on: push\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a yaml comment run inside a block scalar is the scalar's text",
      ".github/workflows/f.yml",
      `run: |\n${hashes(BLOCK + 1).replace(/^/gm, "  ")}x: y\n`,
      [],
    ],
    [
      "the # lines of a shell here-doc are its body, and the same lines after it are a block (control)",
      "f.sh",
      `cat <<'EOF'\n${hashes(BLOCK + 1)}EOF\n${hashes(BLOCK + 1)}echo y\n`,
      [[BLOCK + 4, BLOCK + 1, "block"]],
    ],
    [
      "a C preprocessor line is code",
      "f.c",
      `#include <x.h>\n${slashes(BLOCK + 1)}int x;\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a JavaScript html comment run is a block",
      "f.js",
      `x;\n${"<!-- c\n".repeat(BLOCK + 1)}x;\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a Rust doc comment run is a block like any other",
      "f.rs",
      `fn f() {}\n${"/// d\n".repeat(BLOCK + 1)}fn g() {}\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    // The exemption marker: a comment line inside the block, reason required.
    [
      "an exempted block over the cap produces nothing",
      "f.ts",
      `x\n// ${COMMENT_MARKER} the license text upstream ships\n${slashes(50)}x\n`,
      [],
    ],
    [
      "the marker on the block's last line exempts it too",
      "f.ts",
      `x\n${slashes(50)}// ${COMMENT_MARKER} upstream text\nx\n`,
      [],
    ],
    [
      "an exempted header over its cap produces nothing",
      "f.ts",
      `// ${COMMENT_MARKER} upstream text\n${slashes(HEADER + 5)}x\n`,
      [],
    ],
    [
      "the # form exempts a shell block",
      "f.sh",
      `echo x\n# ${COMMENT_MARKER} upstream text\n${hashes(50)}echo y\n`,
      [],
    ],
    [
      "the /* */ form exempts, and the closing delimiter is not the reason",
      "f.ts",
      `x\n/* ${COMMENT_MARKER} upstream text */\n${slashes(50)}x\n`,
      [],
    ],
    [
      "a marker inside a /* */ body exempts that block",
      "f.ts",
      `x\n/*\n * ${COMMENT_MARKER} upstream text\n${" * a\n".repeat(50)} */\nx\n`,
      [],
    ],
    [
      "a bare marker warns and exempts nothing: the over-cap block warns as well",
      "f.ts",
      `x\n// ${COMMENT_MARKER}\n${slashes(BLOCK)}x\n`,
      [[2], [2, BLOCK + 1, "block"]],
    ],
    [
      "a bare marker inside a /* */ body takes no reason from the lines after it",
      "f.ts",
      `x();\n/*\n * ${COMMENT_MARKER}\n${" * text\n".repeat(9)} */\n`,
      [[3], [2, 12, "block"]],
    ],
    [
      "a bare marker in a nested block comment (Rust nests them) ends at the inner closer",
      "f.rs",
      `fn f() {}\n/*\n/* ${COMMENT_MARKER} */\n${" * c\n".repeat(10)}*/\n`,
      [[3], [2, 13, "block"]],
    ],
    [
      "a bare /* */ marker warns: the closing delimiter is no reason",
      "f.ts",
      `x\n/* ${COMMENT_MARKER} */\n${slashes(2)}x\n`,
      [[2]],
    ],
    [
      "a bare marker in an under-cap block is the only finding",
      "f.sh",
      `echo x\n# ${COMMENT_MARKER}\n# a\necho y\n`,
      [[2]],
    ],
    [
      "the marker exempts only its own block: the next one over the cap still warns",
      "f.ts",
      `x\n// ${COMMENT_MARKER} upstream text\n${slashes(50)}\n${slashes(BLOCK + 1)}x\n`,
      [[54, BLOCK + 1, "block"]],
    ],
    [
      "a marker on a code line's trailing comment is not in any block (control)",
      "f.ts",
      `x(); // ${COMMENT_MARKER} upstream text\n${slashes(BLOCK + 1)}x\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a marker after a closing delimiter and code is on a code line: not in the block",
      "f.ts",
      `x();\n/*\n${" * a\n".repeat(BLOCK)}*/ y(); // ${COMMENT_MARKER}\n`,
      [[2, BLOCK + 1, "block"]],
    ],
    [
      "a marker before the closing delimiter on the closer line is in the block",
      "f.ts",
      `x();\n/*\n${" * a\n".repeat(50)} * ${COMMENT_MARKER} upstream text */\n`,
      [],
    ],
    [
      "every marker counts: a bare one warns while a reasoned one exempts the same block",
      "f.ts",
      `x\n// ${COMMENT_MARKER} upstream text\n// ${COMMENT_MARKER}\n${slashes(50)}x\n`,
      [[3]],
    ],
    [
      "a one-line /* */ marker followed by an empty // comment is bare: the closing delimiter ends the reason",
      "f.ts",
      `x\n/* ${COMMENT_MARKER} */ //\n${slashes(BLOCK)}x\n`,
      [[2], [2, BLOCK + 1, "block"]],
    ],
    [
      "two markers on one line are both read: the reasoned one exempts, the bare one warns",
      "f.ts",
      `x\n/* ${COMMENT_MARKER} upstream text */ // ${COMMENT_MARKER}\n${slashes(50)}x\n`,
      [[2]],
    ],
    [
      "a # reason may start with a closing delimiter (no block syntax to end it)",
      "f.sh",
      `echo x\n# ${COMMENT_MARKER} */ is the upstream glob\n${hashes(50)}echo y\n`,
      [],
    ],
    [
      "a // reason may start with */ too: the closer belongs to the /* */ form of the same node type",
      "f.ts",
      `x\n// ${COMMENT_MARKER} */ is the upstream glob\n${slashes(50)}x\n`,
      [],
    ],
    [
      "a /* */ reason may start with -->: html_comment's text is no closer here",
      "f.ts",
      `x\n/* ${COMMENT_MARKER} --> is part of the upstream syntax */\n${slashes(50)}x\n`,
      [],
    ],
    [
      "a /* */ marker's reason ends at its own */, not a later one on the line",
      "f.ts",
      `x\n/* ${COMMENT_MARKER} */ /* upstream text */\n${slashes(BLOCK)}x\n`,
      [[2], [2, BLOCK + 1, "block"]],
    ],
    [
      "an html_comment runs to the line end: --> inside it is part of the reason",
      "f.js",
      `x;\n<!-- ${COMMENT_MARKER} --> is part of the upstream syntax\n${slashes(50)}x\n`,
      [],
    ],
    [
      "a marker inside a generated region is not read",
      "f.ts",
      `x\n// BEGIN GENERATED: x\n// ${COMMENT_MARKER} upstream text\n// END GENERATED: x\n${slashes(BLOCK + 1)}x\n`,
      [[5, BLOCK + 1, "block"]],
    ],
  ])("%s", (_name, path, text, expected) => {
    const kind = classify(path);
    if (kind === null) throw new Error(`${path} has no kind`);
    expect(judgeFile(path, kind, text, grammars)).toEqual(
      expected.map((row) => commentFinding(path, kind, row)),
    );
  });
});

describe("grammars", () => {
  const { block: BLOCK } = COMMENT_CAPS;
  /** One comment line and one code line per judged extension. */
  const SAMPLES: [path: string, comment: string, code: string][] = [
    ["f.ts", "// c", "const x = 1;"],
    ["f.mts", "// c", "const x = 1;"],
    ["f.cts", "// c", "const x = 1;"],
    ["f.tsx", "// c", "const x = <a>b</a>;"],
    ["f.js", "// c", "const x = 1;"],
    ["f.jsx", "// c", "const x = <a>b</a>;"],
    ["f.mjs", "// c", "const x = 1;"],
    ["f.cjs", "// c", "const x = 1;"],
    ["f.py", "# c", "x = 1"],
    ["f.pyi", "# c", "x: int"],
    ["f.rs", "// c", "fn f() {}"],
    ["f.go", "// c", "package main"],
    ["f.kt", "// c", "val x = 1"],
    ["f.java", "// c", "class A {}"],
    ["f.c", "// c", "int x;"],
    ["f.h", "// c", "int x;"],
    ["f.cpp", "// c", "class A {};"],
    ["f.cc", "// c", "class A {};"],
    ["f.cxx", "// c", "class A {};"],
    ["f.hh", "// c", "class A {};"],
    ["f.hpp", "// c", "class A {};"],
    ["f.sh", "# c", "case $x in a) echo b ;; esac"],
    ["f.bash", "# c", 'if [[ "$a" == "b" ]]; then echo ok; fi'],
    ["f.zsh", "# c", 'for f in a b; do echo "$f"; done'],
    [".github/workflows/f.yml", "# c", "on: push"],
    [".github/workflows/f.yaml", "# c", "on: push"],
  ];

  test("every judged extension but Swift has a working grammar; Swift's reason names the leak", () => {
    expect([...grammars].filter(([, grammar]) => "reason" in grammar)).toEqual([
      ["swift", { reason: expect.stringContaining("keeps scanner state across files") }],
    ]);
    expect([...grammars.keys()].sort()).toEqual(
      [...SAMPLES.map(([path]) => path.slice(path.lastIndexOf(".") + 1)), "swift"].sort(),
    );
    // No comment judgement and no literal exemption, whatever the file holds.
    const chatty = `${"// c\n".repeat(BLOCK + 1)}let x = "${"a ".repeat(115)}"\n`;
    expect(judgeFile("f.swift", "source", chatty, grammars).map(describeFinding)).toEqual([
      `f.swift:${BLOCK + 2}: 240 chars (cap ${WARN.width})`,
    ]);
  });

  // A grammar wasm importing a libc symbol the runtime does not export loads fine.
  // It then crashes the parse on the first input reaching the symbol (tree-sitter-wasms' bash build imports isalpha).
  // The two assertion sinks are reached only by a grammar bug, a crash either way.
  test("every grammar wasm imports only symbols the runtime provides; the tree-sitter-wasms bash build is the control", async () => {
    const runtime = await WebAssembly.compile(
      readFileSync(join(ACTION_DIR, "node_modules", "web-tree-sitter", "tree-sitter.wasm")),
    );
    const provided = new Set(WebAssembly.Module.exports(runtime).map((entry) => entry.name));
    const glue = new Set(["abort", "__assert_fail"]);
    const missingImports = async (wasms: readonly string[]): Promise<string[]> => {
      const missing: string[] = [];
      for (const wasm of wasms) {
        const grammar = await WebAssembly.compile(readFileSync(wasm));
        for (const entry of WebAssembly.Module.imports(grammar)) {
          if (entry.kind === "function" && !provided.has(entry.name) && !glue.has(entry.name)) {
            missing.push(`${wasm.slice(wasm.lastIndexOf("/") + 1)}: ${entry.name}`);
          }
        }
      }
      return missing;
    };
    expect(GRAMMAR_WASMS.length).toBe(12);
    expect(await missingImports(GRAMMAR_WASMS)).toEqual([]);
    const crashing = join(
      ACTION_DIR,
      "node_modules",
      "tree-sitter-wasms",
      "out",
      "tree-sitter-bash.wasm",
    );
    expect(GRAMMAR_WASMS).not.toContain(crashing);
    expect(await missingImports([crashing])).toContain("tree-sitter-bash.wasm: isalpha");
  });

  test.each(SAMPLES)(
    "%s: a comment run after code is a block; the same lines as code are not",
    (path, comment, code) => {
      const kind = classify(path);
      if (kind === null) throw new Error(`${path} has no kind`);
      const run = `${comment}\n`.repeat(BLOCK + 1);
      expect(judgeFile(path, kind, `${code}\n${run}${code}\n`, grammars)).toEqual([
        {
          path,
          kind,
          tier: "warn",
          measure: "comment",
          line: 2,
          value: BLOCK + 1,
          cap: BLOCK,
          scope: "block",
        },
      ]);
      expect(judgeFile(path, kind, `${code}\n`.repeat(BLOCK + 2), grammars)).toEqual([]);
    },
  );

  /** Every comment form of every grammar: how it opens, and how it closes when the reason does not run to the line end. */
  const STYLES: [path: string, open: string, close: string][] = [
    ["f.ts", "//", ""],
    ["f.ts", "/*", "*/"],
    ["f.ts", "<!--", ""],
    ["f.tsx", "//", ""],
    ["f.tsx", "/*", "*/"],
    ["f.tsx", "<!--", ""],
    ["f.js", "//", ""],
    ["f.js", "/*", "*/"],
    ["f.js", "<!--", ""],
    ["f.js", "-->", ""],
    ["f.py", "#", ""],
    ["f.rs", "//", ""],
    ["f.rs", "/*", "*/"],
    ["f.go", "//", ""],
    ["f.go", "/*", "*/"],
    ["f.c", "//", ""],
    ["f.c", "/*", "*/"],
    ["f.cpp", "//", ""],
    ["f.cpp", "/*", "*/"],
    ["f.java", "//", ""],
    ["f.java", "/*", "*/"],
    ["f.kt", "//", ""],
    ["f.kt", "/*", "*/"],
    ["f.sh", "#", ""],
    [".github/workflows/f.yml", "#", ""],
  ];
  const extension = (path: string): string => path.slice(path.lastIndexOf(".") + 1);
  const loaded = (path: string): Grammar => {
    const grammar = grammars.get(extension(path));
    if (grammar === undefined || "reason" in grammar) throw new Error(`${path} has no grammar`);
    return grammar;
  };
  /** The node type the grammar gives a comment written in this style. */
  const commentType = (grammar: Grammar, text: string): string => {
    const tree = grammar.parser.parse(text);
    if (tree === null) throw new Error("tree-sitter returned no tree");
    const pending = [tree.rootNode];
    for (let node = pending.shift(); node !== undefined; node = pending.shift()) {
      if (grammar.comments.has(node.type)) return node.type;
      pending.push(...node.children.filter((child) => child !== null));
    }
    throw new Error(`no comment in ${JSON.stringify(text)}`);
  };

  test.each(STYLES)(
    "%s %s: a reason holding the other forms' closers survives to its own closer",
    (path, open, close) => {
      const kind = classify(path);
      if (kind === null) throw new Error(`${path} has no kind`);
      const foreign = ["*/", "-->"].filter((closer) => closer !== close).join(" ");
      const marker = `${open} ${COMMENT_MARKER} ${foreign} is upstream syntax ${close}`.trimEnd();
      const run = `${open} c ${close}`.trimEnd();
      const header = `${marker}\n${`${run}\n`.repeat(COMMENT_CAPS.header)}`;
      expect(judgeFile(path, kind, header, grammars)).toEqual([]);
      // The control: the same block with a bare marker warns twice.
      expect(
        judgeFile(
          path,
          kind,
          header.replace(marker, `${open} ${COMMENT_MARKER} ${close}`.trimEnd()),
          grammars,
        ),
      ).toEqual([
        { path, kind, tier: "warn", measure: "marker", line: 1 },
        {
          path,
          kind,
          tier: "warn",
          measure: "comment",
          line: 1,
          value: COMMENT_CAPS.header + 1,
          cap: COMMENT_CAPS.header,
          scope: "header",
        },
      ]);
    },
  );

  test("every comment node type of every grammar has a style above, so its delimiters are proven", () => {
    // A grammar is named by the first extension reaching it: a style's, else its own.
    const byGrammar = new Map<Grammar, { name: string; types: Set<string> }>();
    for (const [path, open, close] of STYLES) {
      const grammar = loaded(path);
      const entry = byGrammar.get(grammar) ?? { name: extension(path), types: new Set<string>() };
      byGrammar.set(grammar, entry);
      entry.types.add(commentType(grammar, `${open} c ${close}\n`));
    }
    for (const [ext, grammar] of grammars) {
      if (!("reason" in grammar) && !byGrammar.has(grammar)) {
        byGrammar.set(grammar, { name: ext, types: new Set() });
      }
    }
    const styled = Object.fromEntries(
      [...byGrammar.values()].map(({ name, types }) => [name, [...types].sort()]),
    );
    const declared = Object.fromEntries(
      [...byGrammar].map(([grammar, { name }]) => [name, [...grammar.comments.keys()].sort()]),
    );
    expect(styled).toEqual(declared);
    expect(Object.keys(styled)).toEqual([
      "ts",
      "tsx",
      "js",
      "py",
      "rs",
      "go",
      "c",
      "cpp",
      "java",
      "kt",
      "sh",
      "yml",
    ]);
  });

  test("an extension without a grammar gets no comment judgement and no literal exemption, and is reported once", () => {
    const none: Grammars = new Map([["ts", { reason: "no grammar maps this extension" }]]);
    const wide = `const x = "${"a ".repeat(115)}";\n`;
    const chatty = `${"// c\n".repeat(BLOCK + 1)}x\n\n${"// c\n".repeat(BLOCK + 1)}${wide}`;
    // Control: with the grammar, the block warns and the literal is left alone.
    expect(judgeFile("f.ts", "source", chatty, grammars).map(describeFinding)).toEqual([
      `f.ts:${BLOCK + 4}: ${BLOCK + 1} comment lines (cap ${BLOCK})`,
    ]);
    expect(judgeFile("f.ts", "source", chatty, none).map(describeFinding)).toEqual([
      `f.ts:${2 * BLOCK + 5}: 243 chars (cap ${WARN.width})`,
    ]);
    const root = checkout({
      "a.ts": chatty,
      "b.ts": lines(3),
      "c.sh": "echo x\n",
    });
    const verdict = check(root, none);
    expect(verdict.unjudged).toEqual([
      { extension: "ts", files: 2, reason: "no grammar maps this extension" },
    ]);
    expect(report(outcomeOf(verdict))).toContain(
      "\n2 `.ts` file(s) not judged for comment blocks or literal lines (no working grammar: no grammar maps this extension).\n",
    );
  });
});

describe("isUnbreakable", () => {
  test.each<[string, boolean]>([
    ["https://example.com/a/very/long/path", true],
    ["    indented-token", true],
    ["two tokens", false],
    ["  run: value", false],
    ["", false],
    ["   ", false],
  ])("%j", (line, unbreakable) => {
    expect(isUnbreakable(line)).toBe(unbreakable);
  });
});

describe("parseAllowlist", () => {
  test("entries need a reason on the same line; comments and blanks are skipped", () => {
    const text = [
      "# header comment",
      "",
      "scripts/big.ts # vendored from upstream",
      "  tests/big.test.ts   #   spaced reason  ",
      "scripts/bare.ts",
      "scripts/empty.ts #",
    ].join("\n");
    expect(parseAllowlist(text)).toEqual({
      entries: [
        { path: "scripts/big.ts", reason: "vendored from upstream", line: 3 },
        { path: "tests/big.test.ts", reason: "spaced reason", line: 4 },
      ],
      failures: [
        `${ALLOWLIST_FILE}:5: 'scripts/bare.ts' has no '# reason'; ${REASON_RULE}`,
        `${ALLOWLIST_FILE}:6: 'scripts/empty.ts' has no '# reason'; ${REASON_RULE}`,
      ],
    });
  });
});

describe("check", () => {
  const BIG = lines(HARD.lines.source + 1);
  const WARM = lines(WARN.lines.source + 1);
  const WIDE = `${"a ".repeat(140).trim()}\n`;
  const bigLine = `src/big.ts: ${HARD.lines.source + 1} lines (cap ${HARD.lines.source} for source)`;
  const summary = (root: string) => {
    const verdict = check(root, grammars);
    return {
      failures: verdict.failures.map(describeFinding),
      warnings: verdict.warnings.map(describeFinding),
      allowlistErrors: verdict.allowlistErrors,
      managedSkipped: verdict.managedSkipped,
    };
  };

  test("judges tracked files only; ignored, untracked, generated, managed and exempt files never count", () => {
    const root = checkout(
      {
        ".gitignore": "ignored/\n",
        "src/big.ts": BIG,
        "src/warm.ts": WARM,
        "src/wide.sh": WIDE,
        "src/chatty.ts": `${"// h\n".repeat(COMMENT_CAPS.header + 1)}x\n\n${"// b\n".repeat(COMMENT_CAPS.block + 1)}x\n`,
        "src/exempt.ts": `// ${COMMENT_MARKER} upstream text\n${"// h\n".repeat(60)}x\n\n// ${COMMENT_MARKER}\nx\n`,
        "src/gen.ts": `// This file is generated by gen.ts\n${BIG}`,
        ".github/workflows/ci.yml": `${MANAGED}${WIDE}`,
        ".github/dependabot.yml": `${MANAGED}${BIG}`,
        "vendor/big.js": BIG,
        "data/big.json": BIG,
        "docs/wide.md": WIDE,
        "src/fine.ts": lines(10),
      },
      { "src/untracked.ts": BIG, "ignored/big.ts": BIG },
    );
    expect(summary(root)).toEqual({
      failures: [bigLine, `src/wide.sh:1: 279 chars (cap ${HARD.width})`],
      warnings: [
        `src/chatty.ts:1: ${COMMENT_CAPS.header + 1} comment lines (cap ${COMMENT_CAPS.header} for a header)`,
        `src/chatty.ts:${COMMENT_CAPS.header + 4}: ${COMMENT_CAPS.block + 1} comment lines (cap ${COMMENT_CAPS.block})`,
        `src/exempt.ts:64: ${COMMENT_MARKER} needs a reason`,
        `src/warm.ts: ${WARN.lines.source + 1} lines (cap ${WARN.lines.source} for source)`,
      ],
      allowlistErrors: [],
      // Only the classified managed file counts; dependabot.yml is not a kind.
      managedSkipped: 1,
    });
  });

  test("a goldens directory is exempt wholesale, and the managed root file is skipped", () => {
    const root = checkout({
      "tests/goldens/all/.github/workflows/auto.yml": `${MANAGED}${WIDE}`,
      "tests/goldens/all/src/gen.ts": `// generated by x\n${BIG}`,
      ".github/workflows/auto.yml": `${MANAGED}${WIDE}`,
    });
    expect(summary(root)).toEqual({
      failures: [],
      warnings: [],
      allowlistErrors: [],
      managedSkipped: 1,
    });
  });

  test("an allowlisted path with a reason silences both tiers; the unlisted control still fails", () => {
    const root = checkout({
      "src/big.ts": `${BIG}${WIDE}`,
      "src/other.ts": BIG,
      [ALLOWLIST_FILE]: "src/big.ts # vendored from upstream\n",
    });
    expect(summary(root)).toEqual({
      failures: [
        `src/other.ts: ${HARD.lines.source + 1} lines (cap ${HARD.lines.source} for source)`,
      ],
      warnings: [],
      allowlistErrors: [],
      managedSkipped: 0,
    });
  });

  test("an allowlisted warn-tier file is silenced too, and is not stale", () => {
    const root = checkout({
      "src/warm.ts": WARM,
      [ALLOWLIST_FILE]: "src/warm.ts # known\n",
    });
    expect(summary(root)).toEqual({
      failures: [],
      warnings: [],
      allowlistErrors: [],
      managedSkipped: 0,
    });
  });

  test("an entry without a reason fails and exempts nothing", () => {
    const root = checkout({
      "src/big.ts": BIG,
      [ALLOWLIST_FILE]: "src/big.ts\n",
    });
    expect(summary(root)).toEqual({
      failures: [bigLine],
      warnings: [],
      allowlistErrors: [`${ALLOWLIST_FILE}:1: 'src/big.ts' has no '# reason'; ${REASON_RULE}`],
      managedSkipped: 0,
    });
  });

  test("a stale entry (file back under every cap, or not tracked) fails", () => {
    const root = checkout({
      "src/fine.ts": lines(10),
      [ALLOWLIST_FILE]: "src/fine.ts # was big\nsrc/gone.ts # deleted since\n",
    });
    expect(summary(root)).toEqual({
      failures: [],
      warnings: [],
      allowlistErrors: [
        `${ALLOWLIST_FILE}:1: 'src/fine.ts' is stale (under every cap, or not a tracked file); remove the entry`,
        `${ALLOWLIST_FILE}:2: 'src/gone.ts' is stale (under every cap, or not a tracked file); remove the entry`,
      ],
      managedSkipped: 0,
    });
  });

  test("this repository passes with its allowlist", () => {
    const verdict = check(REPO_ROOT, grammars);
    expect([...verdict.failures.map(describeFinding), ...verdict.allowlistErrors]).toEqual([]);
  });
});

describe("the CLI", () => {
  const hardBody = (hardLines: number) =>
    [
      "## File size check",
      "",
      "1 over a hard cap (fails), 1 warning(s).",
      "",
      "| File | Size | Tier | Cap |",
      "| --- | --- | --- | --- |",
      `| \`src/big.ts\` | ${hardLines} lines | hard | ${HARD.lines.source} |`,
      `| \`src/warm.sh:1\` | 239 chars | warn | ${WARN.width} |`,
      "",
      `Split the file, wrap the line, shorten or exempt the comment, or list the path in \`${ALLOWLIST_FILE}\` with a \`# reason\`.`,
      "",
    ].join("\n");
  const warmBody = [
    "## File size check",
    "",
    "0 over a hard cap (fails), 2 warning(s).",
    "",
    "| File | Size | Tier | Cap |",
    "| --- | --- | --- | --- |",
    `| \`src/chatty.ts:1\` | 30 comment lines (header) | warn | ${COMMENT_CAPS.header} |`,
    `| \`src/warm.sh:1\` | 239 chars | warn | ${WARN.width} |`,
    "",
    `Split the file, wrap the line, shorten or exempt the comment, or list the path in \`${ALLOWLIST_FILE}\` with a \`# reason\`.`,
    "",
  ].join("\n");
  const cleanBody = [
    "## File size check",
    "",
    "Every file is under its caps.",
    "",
    "1 managed file(s) skipped; repo-platform owns them.",
    "",
  ].join("\n");

  /** Runs the script as action.yml does, over a planted stale comment body
   *  (so a run that leaves one behind shows). */
  const run = (root: string) => {
    const scratch = temp.dir("check-file-size-cli-");
    const reportPath = join(scratch, "report.md");
    const summaryPath = join(scratch, "summary.md");
    const outputPath = join(scratch, "output.txt");
    writeFileSync(reportPath, "stale\n");
    writeFileSync(summaryPath, "");
    writeFileSync(outputPath, "");
    const proc = boundedSpawnSync(["bun", SCRIPT, root], {
      env: {
        ...process.env,
        REPORT_PATH: reportPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
      },
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.trimEnd().split("\n"),
      stderr: proc.stderr.trimEnd().split("\n"),
      comment: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null,
      summary: readFileSync(summaryPath, "utf-8"),
      output: readFileSync(outputPath, "utf-8"),
    };
  };

  test("findings: exit 1, ::error:: lines, the table as comment body, summary, and report=findings", () => {
    const hardLines = HARD.lines.source + 1;
    const wide = `${"a ".repeat(120).trim()}\n`;
    const root = checkout({
      "src/big.ts": lines(hardLines),
      "src/warm.sh": wide,
    });
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: [`::warning::src/warm.sh:1: 239 chars (cap ${WARN.width})`],
      stderr: [
        `::error::src/big.ts: ${hardLines} lines (cap ${HARD.lines.source} for source)`,
        `1 finding(s). Split the file, wrap the line, shorten or exempt the comment, or list the path in ${ALLOWLIST_FILE} with a '# reason'.`,
      ],
      comment: hardBody(hardLines),
      summary: hardBody(hardLines),
      output: "report=findings\n",
    });
  });

  test("warnings only, an over-cap comment among them: exit 0 with the same three sinks", () => {
    const root = checkout({
      "src/warm.sh": `${"a ".repeat(120).trim()}\n`,
      "src/chatty.ts": `${"// h\n".repeat(30)}x\n`,
    });
    expect(run(root)).toEqual({
      exitCode: 0,
      stdout: [
        `::warning::src/chatty.ts:1: 30 comment lines (cap ${COMMENT_CAPS.header} for a header)`,
        `::warning::src/warm.sh:1: 239 chars (cap ${WARN.width})`,
        "File size check passed (2 warning(s), 0 managed file(s) skipped).",
      ],
      stderr: [""],
      comment: warmBody,
      summary: warmBody,
      output: "report=findings\n",
    });
  });

  test("clean: exit 0, a summary, no comment body (the action deletes the comment), report=clean", () => {
    const root = checkout({
      "src/fine.ts": lines(3),
      "src/managed.ts": `${MANAGED}${lines(3)}`,
    });
    expect(run(root)).toEqual({
      exitCode: 0,
      stdout: ["File size check passed (0 warning(s), 1 managed file(s) skipped)."],
      stderr: [""],
      comment: null,
      summary: cleanBody,
      output: "report=clean\n",
    });
  });

  test("error: a root that is no checkout exits 1 with the failure in the summary, no comment body, report=error", () => {
    const root = temp.dir("check-file-size-notgit-");
    const message = `git ls-files failed in ${root}: fatal: not a git repository (or any of the parent directories): .git`;
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: [""],
      stderr: [`::error::check-file-size did not run to completion: ${message}`],
      comment: null,
      summary: `## File size check\n\nThe check did not run to completion: ${message}\n`,
      output: "report=error\n",
    });
  });

  test("parseArgs takes one optional root and refuses anything more", () => {
    expect(parseArgs([])).toEqual({ root: process.cwd() });
    expect(parseArgs(["/r"])).toEqual({ root: "/r" });
    expect(() => parseArgs(["/r", "--rendered", "a"])).toThrow(
      "unexpected argument(s): --rendered a",
    );
  });
});

describe("report", () => {
  const verdict: Verdict = {
    failures: [
      {
        path: "a.ts",
        kind: "source",
        tier: "hard",
        measure: "lines",
        value: 2100,
        cap: 2000,
      },
    ],
    warnings: [
      {
        path: "b.sh",
        kind: "shell",
        tier: "warn",
        line: 7,
        measure: "width",
        value: 180,
        cap: 150,
      },
      {
        path: "c.ts",
        kind: "source",
        tier: "warn",
        line: 12,
        measure: "comment",
        value: 11,
        cap: 10,
        scope: "block",
      },
      {
        path: "d.ts",
        kind: "source",
        tier: "warn",
        line: 1,
        measure: "comment",
        value: 26,
        cap: 25,
        scope: "header",
      },
      { path: "e.sh", kind: "shell", tier: "warn", measure: "marker", line: 3 },
    ],
    allowlistErrors: [`${ALLOWLIST_FILE}:1: 'c.ts' is stale`],
    managedSkipped: 3,
    unjudged: [{ extension: "kt", files: 2, reason: "kotlin did not load" }],
  };

  test.each<[string, Outcome, string[]]>([
    [
      "findings render hard first as one table, allowlist errors and the managed count after",
      { state: "findings", verdict },
      [
        "## File size check",
        "",
        "1 over a hard cap (fails), 4 warning(s).",
        "",
        "| File | Size | Tier | Cap |",
        "| --- | --- | --- | --- |",
        "| `a.ts` | 2100 lines | hard | 2000 |",
        "| `b.sh:7` | 180 chars | warn | 150 |",
        "| `c.ts:12` | 11 comment lines | warn | 10 |",
        "| `d.ts:1` | 26 comment lines (header) | warn | 25 |",
        "| `e.sh:3` | comment-cap: ignore without a reason | warn | - |",
        "",
        `### ${ALLOWLIST_FILE}`,
        "",
        `- ${ALLOWLIST_FILE}:1: 'c.ts' is stale`,
        "",
        `Split the file, wrap the line, shorten or exempt the comment, or list the path in \`${ALLOWLIST_FILE}\` with a \`# reason\`.`,
        "",
        "3 managed file(s) skipped; repo-platform owns them.",
        "",
        "2 `.kt` file(s) not judged for comment blocks or literal lines (no working grammar: kotlin did not load).",
        "",
      ],
    ],
    [
      "clean says so and keeps the managed count",
      {
        state: "clean",
        verdict: {
          ...verdict,
          failures: [],
          warnings: [],
          allowlistErrors: [],
          unjudged: [],
        },
      },
      [
        "## File size check",
        "",
        "Every file is under its caps.",
        "",
        "3 managed file(s) skipped; repo-platform owns them.",
        "",
      ],
    ],
    [
      "an error names what stopped the check",
      { state: "error", message: "boom" },
      ["## File size check", "", "The check did not run to completion: boom", ""],
    ],
  ])("%s", (_name, outcome, expected) => {
    expect(report(outcome)).toBe(expected.join("\n"));
  });
});
