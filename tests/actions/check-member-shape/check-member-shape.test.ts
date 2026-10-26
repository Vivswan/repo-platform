// The four rules ride on oxc-parser's node vocabulary and comment spans (external: a bump that renamed a body node or
// dropped a comment's span would judge nothing, green), the readability principle that a comment-free record is never
// asked for structure (the controls), and the attribution conventions no source declares: a trailing comment belongs
// to its line's item, a comment on an item's own lines is that item's unless a nested record, function body, or
// literal owns it, each declarator of a const statement is a constant, and a blank-separated comment above a const
// block's first item is the group's tell.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ALLOWLIST_FILE,
  check,
  describe as describeFinding,
  judgeFile,
  REASON_RULE,
} from "../../../actions/check-member-shape/check-member-shape.ts";
import { loadAction, stepNamed } from "../../shared/action_step.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { checkout } from "../../shared/fixture_checkout.ts";
import { fixtureGitEnv } from "../../shared/fixture_git.ts";
import { readGithubOutput } from "../../shared/github_output.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const SCRIPT = resolve(
  import.meta.dir,
  "../../../actions/check-member-shape/check-member-shape.ts",
);
const MANAGED = "// This file is managed by Vivswan/repo-platform.\n";

const judged = (text: string, path = "src/a.ts"): string[] | null =>
  judgeFile(path, text)?.map((finding) => `${finding.line}: ${finding.rule}`) ?? null;

type RuleRow = [name: string, source: string, expected: string[], path?: string];

describe("the rules, per record kind and construct", () => {
  const ROWS: RuleRow[] = [
    // The controls that arm the rules: nothing carries a comment, so nothing is asked for.
    [
      "control: a comment-free packed interface of five members passes",
      "interface A {\n  a: string;\n  b: string;\n  c: string;\n  d: string;\n  e(): void;\n}\n",
      [],
    ],
    ["control: a packed enum passes", "enum E {\n  X,\n  Y,\n  Z,\n}\n", []],
    [
      "control: a packed const block passes",
      "const A = 1;\nconst B = 2;\nexport const C = 3;\n",
      [],
    ],
    [
      "control: a one-line comment directly above every member, one blank line between, passes",
      "interface A {\n  // a\n  a: string;\n\n  /** b */\n  b(): void;\n\n  // k\n  [k: string]: unknown;\n}\n",
      [],
    ],
    // all-or-none and blank-line-between-members, once per record kind.
    [
      "interface: three members, one commented: a finding per bare member, and the packed pairs",
      "interface A {\n  // a\n  a: string;\n  b: string;\n  c: string;\n}\n",
      [
        "4: all-or-none",
        "4: blank-line-between-members",
        "5: all-or-none",
        "5: blank-line-between-members",
      ],
    ],
    [
      "class: the comment above a decorator is the member's; the bare property is the finding",
      "class C {\n  /** m */\n  @dec()\n  m = 1;\n\n  x = 1;\n}\n",
      ["6: all-or-none"],
    ],
    // Methods: one-line-comment and all-or-none govern fields and constants (the skill's "On a variable, field, or
    // constant"); a method's doc comment follows the doc-comment rule and may run longer. blank-line-between-members
    // still counts every member once any carries a comment.
    [
      "class: a method documented over two lines asks the bare, spaced fields for nothing",
      "class C {\n  a = 1;\n\n  b = 2;\n\n  /** m\n   *  more */\n  m(): void {}\n}\n",
      [],
    ],
    [
      "class: the same documented method among packed fields: the blank-line rule still arms, the comment rules stay silent",
      "class C {\n  a = 1;\n  /** m\n   *  more */\n  m(): void {}\n  b = 2;\n}\n",
      ["3: blank-line-between-members", "6: blank-line-between-members"],
    ],
    [
      "interface: a documented method signature among spaced bare properties passes",
      "interface A {\n  a: string;\n\n  b: string;\n\n  /** Does m, at length,\n   *  on two lines. */\n  m(): void;\n}\n",
      [],
    ],
    [
      "class: an accessor is a field (its comment asks the bare property for one), a constructor a method (asked for nothing)",
      "class C {\n  /** The value. */\n  get v(): number {\n    return 1;\n  }\n\n  x = 1;\n\n  constructor() {}\n}\n",
      ["7: all-or-none"],
    ],
    [
      "interface: an accessor signature is a field too (oxc spells it as a method signature with a `get` kind): its two-line doc and the bare property are findings",
      "interface A {\n  /** Value\n   * details. */\n  get v(): number;\n\n  x: number;\n}\n",
      ["2: one-line-comment", "6: all-or-none"],
    ],
    [
      "class: spread members with no comment anywhere pass, whatever the spacing",
      "class C {\n  x = 1;\n\n\n  y = 2;\n}\n",
      [],
    ],
    [
      "type literal in an alias: half commented",
      "type T = {\n  // a\n  a: 1;\n\n  b: 2;\n};\n",
      ["5: all-or-none"],
    ],
    [
      "type literal in a parameter and a return type: each judged on its own",
      "function f(p: {\n  // a\n  a: 1;\n  b: 2;\n}): {\n  r: 1;\n  // s\n  s: 2;\n} {\n  return { r: 1, s: 2 };\n}\n",
      [
        "4: all-or-none",
        "4: blank-line-between-members",
        "6: all-or-none",
        "7: blank-line-between-members",
      ],
    ],
    [
      "enum: half commented",
      "enum E {\n  /** x */\n  X,\n  Y,\n}\n",
      ["4: all-or-none", "4: blank-line-between-members"],
    ],
    [
      "nested: an interface inside a namespace and a type literal inside a method are records of their own",
      "namespace N {\n  export interface Q {\n    // a\n    a: 1;\n    b: 2;\n  }\n}\nclass C {\n  m(p: {\n    /** a */\n    a: 1;\n    b: 2;\n  }): void {}\n}\n",
      [
        "5: all-or-none",
        "5: blank-line-between-members",
        "12: all-or-none",
        "12: blank-line-between-members",
      ],
    ],
    [
      "two blank lines between commented members is a finding too",
      "interface A {\n  // a\n  a: string;\n\n\n  // b\n  b: string;\n}\n",
      ["6: blank-line-between-members"],
    ],
    // one-line-comment, each defect once; the finding sits on the comment's first line.
    [
      "two stacked // lines",
      "interface A {\n  // a\n  // more\n  a: string;\n\n  // b\n  b: string;\n}\n",
      ["2: one-line-comment"],
    ],
    [
      "a multi-line block comment",
      "interface A {\n  /** a\n   *  more */\n  a: string;\n\n  // b\n  b: string;\n}\n",
      ["2: one-line-comment"],
    ],
    [
      "a blank line between the comment and the member",
      "interface A {\n  // a\n\n  a: string;\n\n  // b\n  b: string;\n}\n",
      ["2: one-line-comment"],
    ],
    [
      "a trailing comment belongs to its line's member, not the next: not above, so a finding, and the next is bare and packed",
      "interface A {\n  a: string; // a\n  b: string;\n}\n",
      ["2: one-line-comment", "3: all-or-none", "3: blank-line-between-members"],
    ],
    [
      "a multi-line block trailing a member is a finding on its line",
      "interface A {\n  a: string; /* a\n  more */\n}\n",
      ["2: one-line-comment"],
    ],
    [
      "a comment between a decorator and the member's name is the member's, misplaced",
      "class A {\n  @dec()\n  // a\n  a = 1;\n\n  b = 2;\n}\n",
      ["3: one-line-comment", "6: all-or-none"],
    ],
    [
      "a comment on the same line before a const block's first constant is its comment, not above it",
      "/** A. */ const A = 1;\n",
      ["1: one-line-comment"],
    ],
    ["a stacked comment on a constant", "// A.\n// More.\nconst A = 1;\n", ["1: one-line-comment"]],
    // all-or-none over a const block, and constant-spacing.
    [
      "a const block of three with one commented: the two bare ones, and the commented one glued to both",
      "const A = 1;\n/** B. */\nconst B = 2;\nconst C = 3;\n",
      ["1: all-or-none", "3: constant-spacing", "4: all-or-none"],
    ],
    [
      "a commented const glued to the import above and the function below",
      "import { x } from './x.ts';\n/** A. */\nexport const A = x;\nfunction f(): void {}\n",
      ["3: constant-spacing"],
    ],
    [
      "a commented const spaced on both sides passes; its comment sits above the export keyword",
      "import { x } from './x.ts';\n\n/** A. */\nexport const A = x;\n\nfunction f(): void {}\n",
      [],
    ],
    ["the file start and the file end count as the blank lines", "/** A. */\nconst A = 1;", []],
    [
      "a trailing newline after the last constant is the file end too",
      "/** A. */\nconst A = 1;\n",
      [],
    ],
    [
      "a comment with a blank line to the block's first const is the group's tell, not the const's comment",
      "// The caps, in lines.\n\nconst A = 1;\nconst B = 2;\n",
      [],
    ],
    [
      "a const block broken by a function is two blocks, each all-or-none on its own",
      "/** A. */\nconst A = 1;\n\nfunction f(): void {}\n\nconst B = 2;\nconst C = 3;\n",
      [],
    ],
    [
      "a comment between two decorators is the member's, misplaced",
      "class A {\n  @one()\n  // a\n  @two()\n  a = 1;\n\n  b = 2;\n}\n",
      ["3: one-line-comment", "7: all-or-none"],
    ],
    [
      "a misplaced comment below a decorator does not move the member's blank-line boundary",
      "class A {\n  // a\n  a = 1;\n\n  @dec()\n  // b\n  b = 2;\n}\n",
      ["6: one-line-comment"],
    ],
    [
      "a comment between export and const is the constant's, misplaced",
      "export /* A. */ const A = 1;\n",
      ["1: one-line-comment"],
    ],
    [
      "a comment between const and the name is the constant's, misplaced",
      "const /* A. */ A = 1;\n",
      ["1: one-line-comment"],
    ],
    [
      "a comment inside a member's span (after its type, before its `;`) is the member's: on its line, so a finding, and the next is bare and packed",
      "interface A {\n  a: string /* A. */;\n  b: string;\n}\n",
      ["2: one-line-comment", "3: all-or-none", "3: blank-line-between-members"],
    ],
    [
      "control: a comment inside a nested record is that record's, never the enclosing field's, and a comment inside a method body is code, not a doc comment",
      "interface A {\n  a: {\n    // x\n    x: 1;\n    y: 2;\n  };\n  b: string;\n}\nclass C {\n  m(): void {\n    // step\n  }\n  x = 1;\n}\n",
      ["5: all-or-none", "5: blank-line-between-members"],
    ],
    [
      "a comment between `static` and a static block's brace is the member's (a method's doc, so no shape asked), and the packed member below is the finding",
      "class C {\n  static /* Initializes the class. */ {}\n  x = 1;\n}\n",
      ["3: blank-line-between-members"],
    ],
    [
      "control: a comment inside an arrow's parenthesized expression body is code, never the constant's",
      "const A = (n: number) => (\n  // Calculate the result.\n  n + 1\n);\nconst B = 2;\n",
      [],
    ],
    [
      "an enum member runs to its comma: a comment before the comma on a later line is the member's, so a finding, and the next is bare and packed",
      "enum E {\n  A\n  /* A. */,\n  B,\n}\n",
      ["3: one-line-comment", "4: all-or-none", "4: blank-line-between-members"],
    ],
    [
      "each declarator of a const statement is a constant: the statement's comment is the first's, glued to the bare second",
      "/** A. */\nconst A = 1,\n  B = 2;\n",
      ["2: constant-spacing", "3: all-or-none"],
    ],
    [
      "a comment on a record's opening-brace line is the first member's: on its line, so a finding, and the next is bare and packed",
      "interface A { /** a */ a: string;\n  b: string;\n}\n",
      ["1: one-line-comment", "2: all-or-none", "2: blank-line-between-members"],
    ],
    [
      "control: a comment trailing the statement before a const block is that statement's, so the block stays comment-free",
      "f(); // done\nconst A = 1;\nconst B = 2;\n",
      [],
    ],
    // oxc reads the language off the file name: forced to plain TypeScript, a declaration file's `const A: number;`
    // is a parse error and the file would be warned past instead of judged.
    [
      "a .tsx file is read as tsx",
      "const el = <div />;\ninterface P {\n  // a\n  a: 1;\n  b: 2;\n}\n",
      ["5: all-or-none", "5: blank-line-between-members"],
      "src/a.tsx",
    ],
    [
      "a .d.ts file is read as a declaration file",
      "// A\nconst A: number;\nconst B: number;\n",
      ["2: constant-spacing", "3: all-or-none"],
      "src/a.d.ts",
    ],
  ];

  test.each(ROWS)("%s", (_name, source, expected, path = "src/a.ts") => {
    expect(judged(source, path)).toEqual(expected);
  });

  test("a file oxc cannot parse is null: a warning, never a finding", () => {
    expect(judged("const = ;\n")).toBeNull();
  });
});

const HALF = "interface A {\n  // a\n  a: string;\n  b: string;\n}\n";
const halfFindings = (path: string) => [
  `${path}:4: all-or-none`,
  `${path}:4: blank-line-between-members`,
];

describe("check", () => {
  const summary = (root: string) => {
    const verdict = check(root);
    return {
      findings: verdict.findings.map(describeFinding),
      unparsed: verdict.unparsed,
      allowlistErrors: verdict.allowlistErrors,
      managedSkipped: verdict.managedSkipped,
      generatedSkipped: verdict.generatedSkipped,
    };
  };

  test("judges tracked TypeScript only; untracked, ignored, node_modules, .js, managed and generated files never count, and an unparsable file is warned", () => {
    const root = checkout(
      temp,
      "check-member-shape-",
      {
        ".gitignore": "ignored/\n",
        "src/half.ts": HALF,
        "src/half.mts": HALF,
        "src/fine.ts": "interface A {\n  a: string;\n  b: string;\n}\n",
        "src/half.js": HALF,
        "src/managed.ts": `${MANAGED}${HALF}`,
        "src/gen.ts": `// This file is generated by gen.ts\n${HALF}`,
        "src/broken.ts": "const = ;\n",
        "node_modules/pkg/half.ts": HALF,
        "vendor/half.ts": HALF,
      },
      { "src/untracked.ts": HALF, "ignored/half.ts": HALF },
    );
    expect(summary(root)).toEqual({
      findings: [...halfFindings("src/half.mts"), ...halfFindings("src/half.ts")],
      unparsed: ["src/broken.ts"],
      allowlistErrors: [],
      managedSkipped: 1,
      generatedSkipped: 1,
    });
  });

  // The fleet's bypass: an allowlist matching by prefix, silencing the control, or exempting without a reason would pass
  // silently. The stale rule is what keeps the file honest once the file is back in shape.
  test.each<[string, Record<string, string>, ReturnType<typeof summary>]>([
    [
      "a path with a reason is silenced; header comments, blanks and spacing are skipped; the unlisted control still fails",
      {
        "src/half.ts": HALF,
        "src/other.ts": HALF,
        [ALLOWLIST_FILE]: "# header comment\n\n  src/half.ts   #   upstream-shaped  \n",
      },
      {
        findings: halfFindings("src/other.ts"),
        unparsed: [],
        allowlistErrors: [],
        managedSkipped: 0,
        generatedSkipped: 0,
      },
    ],
    [
      "an entry without a reason, or with an empty one, fails and exempts nothing",
      {
        "src/half.ts": HALF,
        "src/other.ts": HALF,
        [ALLOWLIST_FILE]: "src/half.ts\nsrc/other.ts #\n",
      },
      {
        findings: [...halfFindings("src/half.ts"), ...halfFindings("src/other.ts")],
        unparsed: [],
        allowlistErrors: [
          `${ALLOWLIST_FILE}:1: 'src/half.ts' has no '# reason'; ${REASON_RULE}`,
          `${ALLOWLIST_FILE}:2: 'src/other.ts' has no '# reason'; ${REASON_RULE}`,
        ],
        managedSkipped: 0,
        generatedSkipped: 0,
      },
    ],
    [
      "a stale entry (file back in shape, or not tracked) fails",
      {
        "src/fine.ts": "const A = 1;\n",
        [ALLOWLIST_FILE]: "src/fine.ts # was half commented\nsrc/gone.ts # deleted since\n",
      },
      {
        findings: [],
        unparsed: [],
        allowlistErrors: [
          `${ALLOWLIST_FILE}:1: 'src/fine.ts' is stale (every record and constant in shape, or not a tracked file); remove the entry`,
          `${ALLOWLIST_FILE}:2: 'src/gone.ts' is stale (every record and constant in shape, or not a tracked file); remove the entry`,
        ],
        managedSkipped: 0,
        generatedSkipped: 0,
      },
    ],
    [
      "an unparsable file listed in the allowlist is stale: it has no finding to silence",
      { "src/broken.ts": "const = ;\n", [ALLOWLIST_FILE]: "src/broken.ts # cannot be parsed\n" },
      {
        findings: [],
        unparsed: ["src/broken.ts"],
        allowlistErrors: [
          `${ALLOWLIST_FILE}:1: 'src/broken.ts' is stale (every record and constant in shape, or not a tracked file); remove the entry`,
        ],
        managedSkipped: 0,
        generatedSkipped: 0,
      },
    ],
  ])("allowlist: %s", (_name, tree, expected) => {
    expect(summary(checkout(temp, "check-member-shape-", tree))).toEqual(expected);
  });
});

describe("the CLI", () => {
  // action.yml gates the sticky comment on the `report` output: one literal posts, the other deletes, and both steps are
  // continue-on-error, so a value the script renames is never posted or never deleted, green. The two literals are read
  // from the manifest so neither side can move alone.
  const gateValue = (stepName: string): string => {
    const gate = String(
      stepNamed(loadAction("actions/check-member-shape/action.yml"), stepName).if,
    );
    const value = /steps\.check\.outputs\.report == '([a-z]+)'/.exec(gate)?.[1];
    if (value === undefined) throw new Error(`no report gate in ${gate}`);
    return value;
  };
  const POSTED = gateValue("Post the findings as a sticky PR comment");
  const DELETED = gateValue("Remove a stale sticky comment");
  const REMEDY = `Add the blank lines, make the comment one line directly above the item, comment every field or none, or list the path in ${ALLOWLIST_FILE} with a '# reason'.`;
  const findingsBody = [
    "## Member shape check",
    "",
    "2 finding(s).",
    "",
    "| File | Line | Rule |",
    "| --- | --- | --- |",
    "| `src/half.ts` | 4 | all-or-none |",
    "| `src/half.ts` | 4 | blank-line-between-members |",
    "",
    "1 file(s) oxc could not parse, not judged:",
    "",
    "- `src/broken.ts`",
    "",
    `Add the blank lines, make the comment one line directly above the item, comment every field or none, or list the path in \`${ALLOWLIST_FILE}\` with a \`# reason\`.`,
    "",
    "1 managed file(s) skipped; repo-platform owns them.",
    "",
    "1 generated file(s) skipped.",
    "",
  ].join("\n");
  const cleanBody = [
    "## Member shape check",
    "",
    "Every record and constant is in shape.",
    "",
    "1 managed file(s) skipped; repo-platform owns them.",
    "",
  ].join("\n");

  /** Runs the script as action.yml does, over a planted stale comment body (so a run that leaves one behind shows). */
  const run = (root: string) => {
    const scratch = temp.dir("check-member-shape-cli-");
    const reportPath = join(scratch, "report.md");
    const summaryPath = join(scratch, "summary.md");
    const outputPath = join(scratch, "output.txt");
    writeFileSync(reportPath, "stale\n");
    writeFileSync(summaryPath, "");
    writeFileSync(outputPath, "");
    const proc = boundedSpawnSync(["bun", SCRIPT, root], {
      env: {
        ...fixtureGitEnv(),
        REPORT_PATH: reportPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_OUTPUT: outputPath,
      },
      timeoutMs: 60_000,
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.trimEnd().split("\n"),
      stderr: proc.stderr.trimEnd().split("\n"),
      comment: existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null,
      summary: readFileSync(summaryPath, "utf-8"),
      output: readGithubOutput(outputPath),
    };
  };

  test.each<[string, () => string, ReturnType<typeof run>]>([
    [
      "findings: exit 0 (advisory), anchored ::warning:: lines for the findings and the unparsable file, the table, the counts, as comment and summary",
      () =>
        checkout(temp, "check-member-shape-", {
          "src/half.ts": HALF,
          "src/broken.ts": "const = ;\n",
          "src/managed.ts": `${MANAGED}${HALF}`,
          "src/gen.ts": `// This file is generated by gen.ts\n${HALF}`,
        }),
      {
        exitCode: 0,
        stdout: [
          "::warning file=src/broken.ts::src/broken.ts: oxc could not parse the file; it is not judged",
          "::warning file=src/half.ts,line=4::src/half.ts:4: all-or-none",
          "::warning file=src/half.ts,line=4::src/half.ts:4: blank-line-between-members",
          `2 finding(s), 1 file(s) not parsed; advisory. ${REMEDY}`,
        ],
        stderr: [""],
        comment: findingsBody,
        summary: findingsBody,
        output: { report: POSTED },
      },
    ],
    [
      "clean: exit 0, a summary, no comment body (the action deletes the comment)",
      () =>
        checkout(temp, "check-member-shape-", {
          "src/fine.ts": "interface A {\n  a: string;\n  b: string;\n}\n",
          "src/managed.ts": `${MANAGED}${HALF}`,
        }),
      {
        exitCode: 0,
        stdout: ["Member shape check passed (1 managed and 0 generated file(s) skipped)."],
        stderr: [""],
        comment: null,
        summary: cleanBody,
        output: { report: DELETED },
      },
    ],
  ])("%s", (_name, makeRoot, expected) => {
    expect(run(makeRoot())).toEqual(expected);
  });
});
