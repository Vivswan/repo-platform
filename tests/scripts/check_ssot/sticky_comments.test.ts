// The sticky-PR-comment scan (scripts/check/ssot/sticky_comments.ts).

import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  STICKY_COMMENT_ACTION,
  type StickyScope,
  sourceWorkflowStem,
  stickyCommentMismatches,
  stickyScopeOf,
  stickyTreeMismatches,
} from "../../../scripts/check/ssot/sticky_comments.ts";

describe("sticky-pr-comments", () => {
  const SHA = "5770ad5eb8f42dd2c4f34da00c94c5381e49af88";
  const PIN = `${STICKY_COMMENT_ACTION}@${SHA} # v3.0.5`;
  const WORKFLOW = "files/bun/.github/workflows/dependabot-bun-lockfile.yml";
  const VARIANT = "files/base/.github/workflows/auto-assign.codeql.yml";
  const BLOCK = "files/bun/.github/workflows/auto-format.yml.block.toolchain";
  const REPO_WORKFLOW = ".github/workflows/protect-build-branches.yml";
  const ACTION = "actions/check-file-size/action.yml";
  const SCRIPT = "actions/validate-managed-files/src/report.ts";
  const HOST = "dependabot-bun-lockfile";
  const HEADER = `repo-platform/${HOST}`;
  const strict = (...hosts: string[]): StickyScope => ({ hosts, postMayFail: false });
  const lenient = (host: string): StickyScope => ({ hosts: [host], postMayFail: true });
  const step = (header: string | null, uses = PIN, extra: string[] = []) =>
    [
      "      - name: Comment that checks will not re-run",
      "        if: steps.push.outputs.no_retrigger == 'true'",
      `        uses: ${uses}`,
      ...extra,
      "        with:",
      ...(header === null ? [] : [`          header: ${header}`]),
      "          message: |",
      "            Pushed a commit with the default workflow token.",
      "      - run: echo next",
    ].join("\n");
  const usesExpected = `${STICKY_COMMENT_ACTION}@<full 40-hex commit sha> # v<major>.<minor>.<patch>`;
  const handRolled = `a ${STICKY_COMMENT_ACTION} step (one comment per PR, upserted)`;
  const swallowed =
    "no continue-on-error on the step (a workflow owns its token; a failed post fails the step)";
  const flaggedCommands = (rel: string, flagged: [line: number, got: string][]): Mismatch[] =>
    flagged.map(([line, got]) => ({ file: `${rel}:${line}`, expected: handRolled, got }));

  test.each([
    { rel: WORKFLOW, stem: HOST },
    { rel: VARIANT, stem: "auto-assign" },
    { rel: BLOCK, stem: "auto-format" },
    { rel: "files/bun/.github/dependabot.yml.block.bun", stem: null },
    { rel: "files/bun/.gitignore.block.Node", stem: null },
    { rel: REPO_WORKFLOW, stem: null },
  ])("sourceWorkflowStem($rel) -> $stem", ({ rel, stem }) => {
    expect(sourceWorkflowStem(rel)).toBe(stem);
  });

  // Only a composite action's post may fail: it runs under the caller's
  // token, which a fork PR grants no pull-requests write.
  test.each([
    { rel: WORKFLOW, scope: strict(HOST) },
    { rel: VARIANT, scope: strict("auto-assign") },
    { rel: BLOCK, scope: strict("auto-format") },
    { rel: "files/bun/.gitignore.block.Node", scope: strict() },
    { rel: REPO_WORKFLOW, scope: strict("protect-build-branches") },
    { rel: ACTION, scope: lenient("check-file-size") },
    { rel: SCRIPT, scope: lenient("validate-managed-files") },
    { rel: "files/bun/.github/dependabot.yml.block.bun", scope: strict() },
    { rel: "scripts/check_ssot.ts", scope: strict() },
  ])("stickyScopeOf($rel)", ({ rel, scope }) => {
    expect(stickyScopeOf(rel)).toEqual(scope);
  });

  test.each([
    { shape: "the canonical step", text: step(HEADER) },
    { shape: "a quoted uses", text: step(HEADER, `"${STICKY_COMMENT_ACTION}@${SHA}" # v3.0.5`) },
    {
      shape: "the action and a gh pr comment named in YAML comments",
      text: `      # ${STICKY_COMMENT_ACTION}@v3 posts; gh pr comment does not\n${step(HEADER)}`,
    },
    {
      shape: "keys in any order, a bullet in the message",
      text: [
        "      - name: Comment that checks will not re-run",
        "        with:",
        `          header: ${HEADER}`,
        "          message: |",
        "            - a bullet",
        `        uses: ${PIN}`,
        "      - run: echo next",
      ].join("\n"),
    },
    {
      shape: "a whole workflow, the step under jobs.*.steps",
      text: `name: w\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n${step(HEADER)}`,
    },
    {
      shape: "a bare close beside the sticky step",
      text: `${step(HEADER)}\n      - run: gh pr close "$PR" -R "$GITHUB_REPOSITORY" --delete-branch`,
    },
    // A literal block is one shell line PER line: this is a close and a
    // syntax error, not a comment.
    {
      shape: "a literal run block with the comment option on its own line",
      text: `${step(HEADER)}\n      - run: |\n          gh pr close "$pr" --delete-branch\n          --comment "stale"`,
    },
    {
      shape: "gh issue comment (the issue-tracking actions comment on issues by design)",
      text: `${step(HEADER)}\n      - run: gh issue comment 3 --body hi`,
    },
  ])("$shape passes with one counted step", ({ text }) => {
    expect(stickyCommentMismatches(WORKFLOW, text, strict(HOST))).toEqual({
      mismatches: [],
      stickySteps: 1,
    });
  });

  test("a composite action's step may carry continue-on-error; a workflow's may not", () => {
    const text = step("repo-platform/check-file-size", PIN, ["        continue-on-error: true"]);
    expect(stickyCommentMismatches(ACTION, text, lenient("check-file-size"))).toEqual({
      mismatches: [],
      stickySteps: 1,
    });
    expect(stickyCommentMismatches(ACTION, text, strict("check-file-size"))).toEqual({
      mismatches: [{ file: `${ACTION}:3`, expected: swallowed, got: "continue-on-error set" }],
      stickySteps: 1,
    });
  });

  // Steps are read as the runner reads them: `run` as YAML folds it, each
  // command line's words as the shell splits them, `gh pr close`'s comment
  // option in every spelling, and any string of the step (a github-script
  // body too), flagged at the line the command starts on.
  test.each<{ form: string; text: string; flagged: [line: number, got: string][] }>([
    {
      form: "a plain gh pr comment",
      text: "      - run: gh pr comment 12 --body hi\n",
      flagged: [[1, "gh pr comment 12 --body hi"]],
    },
    {
      form: "repeated whitespace",
      text: "      - run: gh  pr  comment 12 --body hi\n",
      flagged: [[1, "gh  pr  comment 12 --body hi"]],
    },
    {
      form: "a folded run block (one shell line)",
      text: [
        "      - name: Close it",
        "        run: >-",
        '          gh pr close "$pr" --delete-branch',
        '          --comment "stale"',
        "      - run: echo next",
      ].join("\n"),
      flagged: [[3, 'gh pr close "$pr" --delete-branch --comment "stale"']],
    },
    {
      form: "the short option",
      text: '      - run: gh pr close 12 -c "stale"\n',
      flagged: [[1, 'gh pr close 12 -c "stale"']],
    },
    {
      form: "the short option in a cluster",
      text: '      - run: gh pr close 12 -dc "stale"\n',
      flagged: [[1, 'gh pr close 12 -dc "stale"']],
    },
    {
      form: "the long option with =",
      text: "      - run: gh pr close 12 --comment=stale --delete-branch\n",
      flagged: [[1, "gh pr close 12 --comment=stale --delete-branch"]],
    },
    {
      form: "a REST route across a shell continuation in a literal block",
      text: [
        "      - run: |",
        "          gh api repos/o/r/issues/3/comments \\",
        "            -f body=hi",
        "          echo done",
      ].join("\n"),
      flagged: [[2, "gh api repos/o/r/issues/3/comments \\ -f body=hi"]],
    },
    {
      form: "a folded block with a paragraph break (the second value line is the fourth source line)",
      text: [
        "      - run: >-",
        "          echo ready",
        "",
        "          gh pr comment 12 --body hi",
      ].join("\n"),
      flagged: [[4, "gh pr comment 12 --body hi"]],
    },
    {
      form: "a folded block: a more-indented line keeps its newline, two blank lines are skipped",
      text: [
        "      - run: >-",
        "          echo ready",
        "            gh pr comment 12 --body hi",
        "",
        "",
        "          gh pr comment 13 --body hi",
        "        shell: bash",
      ].join("\n"),
      flagged: [
        [3, "gh pr comment 12 --body hi"],
        [6, "gh pr comment 13 --body hi"],
      ],
    },
    {
      form: "a folded block: a continued command consumes its lines, the next one matches past them",
      text: [
        "      - run: >-",
        "          true && \\",
        "            gh pr comment 12 --body hi",
        "",
        "          gh pr comment 12",
        "          --body hi",
        "        shell: bash",
      ].join("\n"),
      flagged: [
        [2, "true && \\ gh pr comment 12 --body hi"],
        [5, "gh pr comment 12 --body hi"],
      ],
    },
    {
      form: "a folded block: a continuation across a blank line is consumed whole",
      text: [
        "      - run: >-",
        "          true && \\",
        "",
        "          gh pr comment 12 --body hi",
        "",
        "          gh pr comment 12",
        "          --body hi",
      ].join("\n"),
      flagged: [
        [2, "true && \\ gh pr comment 12 --body hi"],
        [6, "gh pr comment 12 --body hi"],
      ],
    },
    {
      form: "a posting command inside a substitution",
      text: [
        "      - run: |",
        "          url=$(gh pr comment 12 --body hi)",
        "          response=$(gh api repos/x/y/issues/12/comments -f body=hi)",
        "          n=$(gh pr view 12 --json number --jq .number)",
      ].join("\n"),
      flagged: [
        [2, "url=$(gh pr comment 12 --body hi)"],
        [3, "response=$(gh api repos/x/y/issues/12/comments -f body=hi)"],
      ],
    },
    {
      form: "a REST route carrying an Actions expression and a shell substitution",
      text: [
        "      - run: |",
        "          gh api repos/x/y/issues/${{ github.event.pull_request.number }}/comments -f body=hi",
        '          gh api "repos/$R/issues/$(cat n)/comments" -f body=hi',
      ].join("\n"),
      flagged: [
        [2, "gh api repos/x/y/issues/${{ github.event.pull_request.number }}/comments -f body=hi"],
        [3, 'gh api "repos/$R/issues/$(cat n)/comments" -f body=hi'],
      ],
    },
    {
      form: "a REST route in a github-script body",
      text: [
        "      - uses: actions/github-script@v7",
        "        with:",
        "          script: |",
        '            await github.request("POST /repos/o/r/issues/3/comments", { body });',
      ].join("\n"),
      flagged: [[4, 'await github.request("POST /repos/o/r/issues/3/comments", { body });']],
    },
    {
      form: "two posting steps, each at its own line",
      text: [
        "      - run: gh pr comment 1 --body a",
        "      - run: echo fine",
        "      - name: b",
        "        run: gh pr comment 2 --body b",
      ].join("\n"),
      flagged: [
        [1, "gh pr comment 1 --body a"],
        [4, "gh pr comment 2 --body b"],
      ],
    },
  ])("$form -> a mismatch per posting command", ({ text, flagged }) => {
    expect(stickyCommentMismatches(REPO_WORKFLOW, text, strict("protect-build-branches"))).toEqual({
      stickySteps: 0,
      mismatches: flaggedCommands(REPO_WORKFLOW, flagged),
    });
  });

  // A source with no step list (an action's script) is read as command
  // lines: `\` continuations and open argv lists join, `//` comment lines
  // are skipped, and a gh helper's argv reads with or without its `gh`.
  test.each<{ form: string; rel: string; text: string[]; flagged: [line: number, got: string][] }>([
    {
      form: "the retired report.ts upsert and its helper cousins",
      rel: SCRIPT,
      text: [
        "// lists repos/${repository}/issues/${prNumber}/comments first",
        "const listing = capture([",
        "  `repos/${repository}/issues/${prNumber}/comments?per_page=100`,",
        "]);",
        "const edit = `repos/${repository}/issues/comments/${existing}`;",
        "const create = `repos/${repository}/issues/${prNumber}/comments`;",
        'capture(["gh", "pr", "comment", "12", "--body", "hi"], { timeoutMs: 20000 });',
        "capture(['gh', 'pr', 'close', '12']);",
        'await run(["pr", "comment", String(pr.number), "--body", "override"]);',
        'await run(["issue", "comment", "3", "--body", "x"]);',
      ],
      flagged: [
        [
          2,
          "const listing = capture([ `repos/${repository}/issues/${prNumber}/comments?per_page=100`, ]);",
        ],
        [5, "const edit = `repos/${repository}/issues/comments/${existing}`;"],
        [6, "const create = `repos/${repository}/issues/${prNumber}/comments`;"],
        [7, 'capture(["gh", "pr", "comment", "12", "--body", "hi"], { timeoutMs: 20000 });'],
        [9, 'await run(["pr", "comment", String(pr.number), "--body", "override"]);'],
      ],
    },
    {
      form: "a formatter-wrapped argv array with a comment inside",
      rel: "actions/check-file-size/check-file-size.ts",
      text: [
        "const post = capture(",
        "  [",
        '    "gh",',
        "    // the subcommand",
        '    "pr",',
        '    "comment",',
        '    "12",',
        "  ],",
        "  { timeoutMs: 20000 },",
        ");",
      ],
      flagged: [
        [1, 'const post = capture( [ "gh", "pr", "comment", "12", ], { timeoutMs: 20000 }, );'],
      ],
    },
    {
      form: "a shell script: a continued close with comment, then a bare close",
      rel: "actions/check-file-size/close.sh",
      text: [
        'gh pr close "$pr" --delete-branch \\',
        '  --comment "stale"',
        'gh pr close "$PR" -R "$GITHUB_REPOSITORY"',
      ],
      flagged: [[1, 'gh pr close "$pr" --delete-branch \\ --comment "stale"']],
    },
  ])("$form -> a mismatch per posting command", ({ rel, text, flagged }) => {
    expect(stickyCommentMismatches(rel, text.join("\n"), lenient("check-file-size"))).toEqual({
      stickySteps: 0,
      mismatches: flaggedCommands(rel, flagged),
    });
  });

  test("the sticky action named where no step list parses is a mismatch, not a silent pass", () => {
    const text = `steps:\n  - uses: ${PIN}\n  bad: [\n`;
    expect(stickyCommentMismatches(REPO_WORKFLOW, text, strict("protect-build-branches"))).toEqual({
      stickySteps: 0,
      mismatches: [
        {
          file: `${REPO_WORKFLOW}:2`,
          expected:
            "the sticky action used by a step in a parseable YAML step list (workflow, composite action, or block file)",
          got: "the sticky action named in a source with no parseable steps",
        },
      ],
    });
  });

  test.each<{
    reason: string;
    rel: string;
    scope: StickyScope;
    text: string;
    mismatches: Mismatch[];
  }>([
    {
      reason: "a moving major tag",
      rel: WORKFLOW,
      scope: strict(HOST),
      text: step(HEADER, `${STICKY_COMMENT_ACTION}@v3`),
      mismatches: [
        {
          file: `${WORKFLOW}:3`,
          expected: usesExpected,
          got: `uses: ${STICKY_COMMENT_ACTION}@v3`,
        },
      ],
    },
    {
      reason: "a full sha without its version comment",
      rel: WORKFLOW,
      scope: strict(HOST),
      text: step(HEADER, `${STICKY_COMMENT_ACTION}@${SHA}`),
      mismatches: [
        {
          file: `${WORKFLOW}:3`,
          expected: usesExpected,
          got: `uses: ${STICKY_COMMENT_ACTION}@${SHA}`,
        },
      ],
    },
    {
      reason: "a header naming another workflow",
      rel: WORKFLOW,
      scope: strict(HOST),
      text: step("repo-platform/auto-format"),
      mismatches: [
        {
          file: `${WORKFLOW}:3`,
          expected: `with.header: ${HEADER}`,
          got: "with.header: repo-platform/auto-format",
        },
      ],
    },
    {
      reason: "a header under another prefix in a repo-platform workflow",
      rel: REPO_WORKFLOW,
      scope: strict("protect-build-branches"),
      text: step("my-repo/protect-build-branches"),
      mismatches: [
        {
          file: `${REPO_WORKFLOW}:3`,
          expected: "with.header: repo-platform/protect-build-branches",
          got: "with.header: my-repo/protect-build-branches",
        },
      ],
    },
    {
      reason: "no header, and the NEXT step's header does not count",
      rel: WORKFLOW,
      scope: strict(HOST),
      text: `${step(null)}\n        with:\n          header: ${HEADER}\n`,
      mismatches: [
        {
          file: `${WORKFLOW}:3`,
          expected: `with.header: ${HEADER}`,
          got: "no header: on the step",
        },
      ],
    },
    {
      reason: "continue-on-error on a workflow's step",
      rel: WORKFLOW,
      scope: strict(HOST),
      text: step(HEADER, PIN, ["        continue-on-error: true"]),
      mismatches: [{ file: `${WORKFLOW}:3`, expected: swallowed, got: "continue-on-error set" }],
    },
    // Keys are a mapping: written above `uses:` they are the step's just
    // the same, and a `- ` bullet in the message body is not a step.
    {
      reason: "continue-on-error and with: written above uses, a bullet in the message",
      rel: WORKFLOW,
      scope: strict(HOST),
      text: [
        "      - name: Comment that checks will not re-run",
        "        continue-on-error: true",
        "        with:",
        "          header: repo-platform/auto-format",
        "          message: |",
        "            - a bullet",
        `        uses: ${PIN}`,
        "      - run: echo next",
      ].join("\n"),
      mismatches: [
        {
          file: `${WORKFLOW}:7`,
          expected: `with.header: ${HEADER}`,
          got: "with.header: repo-platform/auto-format",
        },
        { file: `${WORKFLOW}:7`, expected: swallowed, got: "continue-on-error set" },
      ],
    },
    {
      reason: "the inline `- uses:` item form, continue-on-error as an expression",
      rel: WORKFLOW,
      scope: strict(HOST),
      text: [
        `      - uses: ${PIN}`,
        "        continue-on-error: ${{ github.event_name == 'pull_request' }}",
        "        with:",
        `          header: ${HEADER}`,
        "      - run: echo next",
      ].join("\n"),
      mismatches: [{ file: `${WORKFLOW}:1`, expected: swallowed, got: "continue-on-error set" }],
    },
    {
      reason:
        "a scope handed two hosts (no source has one today; the shape is judged, not the path)",
      rel: BLOCK,
      scope: strict("auto-format", "copilot-setup-steps"),
      text: step("repo-platform/auto-format"),
      mismatches: [
        {
          file: `${BLOCK}:3`,
          expected: "a source with exactly one host workflow or action (the header names it)",
          got: "2 hosts (auto-format, copilot-setup-steps)",
        },
      ],
    },
    {
      reason: "a block file no workflow lands",
      rel: "files/bun/.gitignore.block.Node",
      scope: strict(),
      text: step("repo-platform/auto-format"),
      mismatches: [
        {
          file: "files/bun/.gitignore.block.Node:3",
          expected: "a source with exactly one host workflow or action (the header names it)",
          got: "0 hosts ()",
        },
      ],
    },
  ])("$reason -> the whole mismatch list, one counted step", ({ rel, scope, text, mismatches }) => {
    expect(stickyCommentMismatches(rel, text, scope)).toEqual({ mismatches, stickySteps: 1 });
  });

  test("stickyTreeMismatches: every source scanned under its own scope, both anchors enforced", () => {
    const actionStep = step("repo-platform/check-file-size", PIN, [
      "        continue-on-error: true",
    ]);
    expect(
      stickyTreeMismatches([
        [WORKFLOW, step(HEADER)],
        [BLOCK, step("repo-platform/auto-format")],
        [REPO_WORKFLOW, step("repo-platform/protect-build-branches")],
        [ACTION, actionStep],
        ["actions/check-file-size/check-file-size.ts", "// gh pr comment is not used here\n"],
      ]),
    ).toEqual([]);
    expect(
      stickyTreeMismatches([
        [BLOCK, step(HEADER)],
        [REPO_WORKFLOW, "steps:\n  - run: gh pr comment 1 --body hi\n"],
        ["actions/check-file-size/action.yml", step("repo-platform/check-file-size", PIN)],
        ["actions/validate-managed-files/action.yml", actionStep],
      ]),
    ).toEqual([
      {
        file: `${BLOCK}:3`,
        expected: "with.header: repo-platform/auto-format",
        got: `with.header: ${HEADER}`,
      },
      {
        file: `${REPO_WORKFLOW}:2`,
        expected: handRolled,
        got: "gh pr comment 1 --body hi",
      },
      {
        file: "actions/validate-managed-files/action.yml:3",
        expected: "with.header: repo-platform/validate-managed-files",
        got: "with.header: repo-platform/check-file-size",
      },
    ]);
    expect(
      stickyTreeMismatches([
        [WORKFLOW, "steps:\n  - run: echo hi\n"],
        ["files/bun/.gitignore.block.Node", step(HEADER)],
        ["files/bun/.github/dependabot.yml.block.bun", step(HEADER)],
      ]).map((m) => [m.file, m.got]),
    ).toEqual([
      ["files/bun/.gitignore.block.Node:3", "0 hosts ()"],
      ["files/bun/.github/dependabot.yml.block.bun:3", "0 hosts ()"],
    ]);
    expect(() => stickyTreeMismatches([[WORKFLOW, "steps:\n  - run: echo hi\n"]])).toThrow(
      /no marocchino\/sticky-pull-request-comment step .* anchor lost/,
    );
    expect(() => stickyTreeMismatches([[REPO_WORKFLOW, step(HEADER)]])).toThrow(
      /no writer workflow sources found - anchor lost/,
    );
  });
});
