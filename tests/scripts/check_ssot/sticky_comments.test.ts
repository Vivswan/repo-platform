// The sticky-PR-comment scan (scripts/check/ssot/sticky_comments.ts).

import { describe, expect, test } from "bun:test";
import type { Mismatch } from "../../../scripts/check/ssot/comparison.ts";
import {
  fragmentHosts,
  STICKY_COMMENT_ACTION,
  type StickyScope,
  stickyCommentMismatches,
  stickyScopeOf,
  stickyTreeMismatches,
  stickyYamlOf,
  templateWorkflowStem,
} from "../../../scripts/check/ssot/sticky_comments.ts";

describe("sticky-pr-comments", () => {
  const SHA = "5770ad5eb8f42dd2c4f34da00c94c5381e49af88";
  const PIN = `${STICKY_COMMENT_ACTION}@${SHA} # v3.0.5`;
  const WORKFLOW = "templates/bun/.github/workflows/dependabot-bun-lockfile.yml.jinja";
  const GATED =
    "templates/base/.github/workflows/{% if has_toolchain %}auto-format.yml{% endif %}.jinja";
  const FRAGMENT = "templates/bun/fragments/auto-format.jinja";
  const REPO_WORKFLOW = ".github/workflows/protect-build-branches.yml";
  const ACTION = "actions/check-file-size/action.yml";
  const SCRIPT = "actions/validate-template-report/src/report.ts";
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
    { rel: GATED, stem: "auto-format" },
    { rel: FRAGMENT, stem: null },
    { rel: "templates/bun/.github/dependabot.yml.jinja", stem: null },
    { rel: REPO_WORKFLOW, stem: null },
  ])("templateWorkflowStem($rel) -> $stem", ({ rel, stem }) => {
    expect(templateWorkflowStem(rel)).toBe(stem);
  });

  test("fragmentHosts maps anchor lines to their workflows; toolchain-setup inherits its targets'", () => {
    const hosts = fragmentHosts([
      [GATED, "steps:\n{# compose:auto-format #}\n{# compose:shared -#}\n"],
      [
        "templates/base/.github/workflows/checks.yml.jinja",
        "{# compose:checks-examples #}\n{# compose:shared #}\n  {# compose:indented #}\n",
      ],
    ]);
    expect([...hosts.entries()].sort()).toEqual([
      ["auto-format", ["auto-format"]],
      ["checks-examples", ["checks"]],
      ["shared", ["auto-format", "checks"]],
      ["toolchain-setup", ["auto-format"]],
    ]);
    expect(() => fragmentHosts([[FRAGMENT, ""]])).toThrow(/not a template workflow source/);
  });

  // Only a composite action's post may fail: it runs under the caller's
  // token, which a fork PR grants no pull-requests write.
  test.each([
    { rel: WORKFLOW, scope: strict(HOST) },
    { rel: GATED, scope: strict("auto-format") },
    { rel: FRAGMENT, scope: strict("auto-format", "checks") },
    { rel: "templates/bun/fragments/gitignore.jinja", scope: strict() },
    { rel: REPO_WORKFLOW, scope: strict("protect-build-branches") },
    { rel: ACTION, scope: lenient("check-file-size") },
    { rel: SCRIPT, scope: lenient("validate-template-report") },
    { rel: "templates/bun/.github/dependabot.yml.jinja", scope: strict() },
    { rel: "scripts/check_ssot.ts", scope: strict() },
  ])("stickyScopeOf($rel)", ({ rel, scope }) => {
    const anchors = new Map([["auto-format", ["auto-format", "checks"]]]);
    expect(stickyScopeOf(rel, anchors)).toEqual(scope);
  });

  // The jinja source as the YAML it renders, both branches of an else kept
  // and comment lines blanked in place so reported lines stay the source's;
  // a source the shared subset cannot normalize comes back untouched.
  test("stickyYamlOf renders jinja for the scanner", () => {
    const vars = { username: "Vivswan", slug: "s", copyrightHolder: "c" };
    const source = [
      "{# a two-line comment",
      "   ends here #}",
      "name: {{ github_username }}",
      "{% if 'docs-site' in modules %}",
      "mounts: a",
      "{% else %}",
      "mounts: b",
      "{% endif %}",
      "x: {% raw %}${{ github.token }}{% endraw %} {{ pages_setup }}",
    ].join("\n");
    expect(stickyYamlOf("templates/x/.github/workflows/w.yml.jinja", source, vars)).toBe(
      [
        "",
        "",
        "name: Vivswan",
        "",
        "mounts: a",
        "",
        "mounts: b",
        "",
        'x: ${{ github.token }} "JINJA"',
      ].join("\n"),
    );
    expect(stickyYamlOf(".github/workflows/w.yml", source, vars)).toBe(source);
  });

  // Whitespace-control tags eat the newline beside them in jinja; the
  // scanner reads them as plain tags so every source line keeps its
  // number, and a planted post below one is reported at ITS line.
  test("stickyYamlOf keeps every source newline past a `{%-` tag", () => {
    const vars = { username: "Vivswan", slug: "s", copyrightHolder: "c" };
    const rel = "templates/x/.github/workflows/w.yml.jinja";
    const source = [
      "steps:",
      "  - run: echo one",
      "{%- if enable_codeql %}",
      "  - run: echo two",
      "{%- endif %}",
      "  - run: gh pr comment 1 --body hi",
    ].join("\n");
    const yaml = stickyYamlOf(rel, source, vars);
    expect(yaml.split("\n").length).toBe(source.split("\n").length);
    expect(stickyCommentMismatches(rel, yaml, strict("w"))).toEqual({
      stickySteps: 0,
      mismatches: [{ file: `${rel}:6`, expected: handRolled, got: "gh pr comment 1 --body hi" }],
    });
  });

  // A tag the subset cannot normalize leaves the source to the text
  // scanner, comments already blanked: a post quoted in a jinja comment
  // is not a post, the same text outside one is.
  test("stickyYamlOf's fallback keeps jinja comments blanked", () => {
    const vars = { username: "Vivswan", slug: "s", copyrightHolder: "c" };
    const rel = "templates/x/f.jinja";
    const commented = "{# gh pr comment 1 --body hi #}\n{% for x in y %}a{% endfor %}";
    expect(stickyYamlOf(rel, commented, vars)).toBe("\n{% for x in y %}a{% endfor %}");
    expect(stickyCommentMismatches(rel, stickyYamlOf(rel, commented, vars), strict())).toEqual({
      stickySteps: 0,
      mismatches: [],
    });
    const bare = "gh pr comment 1 --body hi\n{% for x in y %}a{% endfor %}";
    expect(stickyCommentMismatches(rel, stickyYamlOf(rel, bare, vars), strict())).toEqual({
      stickySteps: 0,
      mismatches: [{ file: `${rel}:1`, expected: handRolled, got: "gh pr comment 1 --body hi" }],
    });
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
            "the sticky action used by a step in a parseable YAML step list (workflow, composite action, or step fragment)",
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
      reason: "a fragment spliced into two workflows",
      rel: "templates/bun/fragments/toolchain-setup.jinja",
      scope: strict("auto-format", "copilot-setup-steps"),
      text: step("repo-platform/auto-format"),
      mismatches: [
        {
          file: "templates/bun/fragments/toolchain-setup.jinja:3",
          expected: "a source with exactly one host workflow or action (the header names it)",
          got: "2 hosts (auto-format, copilot-setup-steps)",
        },
      ],
    },
    {
      reason: "a fragment no workflow anchor splices",
      rel: "templates/bun/fragments/gitignore.jinja",
      scope: strict(),
      text: step("repo-platform/auto-format"),
      mismatches: [
        {
          file: "templates/bun/fragments/gitignore.jinja:3",
          expected: "a source with exactly one host workflow or action (the header names it)",
          got: "0 hosts ()",
        },
      ],
    },
  ])("$reason -> the whole mismatch list, one counted step", ({ rel, scope, text, mismatches }) => {
    expect(stickyCommentMismatches(rel, text, scope)).toEqual({ mismatches, stickySteps: 1 });
  });

  test("stickyTreeMismatches: hosts from the RAW anchors, every source scanned as its YAML, both anchors enforced", () => {
    const host = "steps:\n{# compose:auto-format #}\n";
    const blankJinjaComments = (_rel: string, text: string) =>
      text.replace(/\{#[\s\S]*?#\}/g, (comment) => comment.replace(/[^\n]/g, ""));
    const actionStep = step("repo-platform/check-file-size", PIN, [
      "        continue-on-error: true",
    ]);
    expect(
      stickyTreeMismatches(
        [
          [WORKFLOW, `{# gh pr comment 1 --body hi #}\n${step(HEADER)}`],
          [GATED, host],
          [FRAGMENT, step("repo-platform/auto-format")],
          [REPO_WORKFLOW, step("repo-platform/protect-build-branches")],
          [ACTION, actionStep],
          ["actions/check-file-size/check-file-size.ts", "// gh pr comment is not used here\n"],
        ],
        blankJinjaComments,
      ),
    ).toEqual([]);
    expect(
      stickyTreeMismatches([
        [GATED, host],
        [FRAGMENT, step(HEADER)],
        [REPO_WORKFLOW, "steps:\n  - run: gh pr comment 1 --body hi\n"],
        ["actions/check-file-size/action.yml", step("repo-platform/check-file-size", PIN)],
        ["actions/validate-template-report/action.yml", actionStep],
      ]),
    ).toEqual([
      {
        file: `${FRAGMENT}:3`,
        expected: "with.header: repo-platform/auto-format",
        got: `with.header: ${HEADER}`,
      },
      {
        file: `${REPO_WORKFLOW}:2`,
        expected: handRolled,
        got: "gh pr comment 1 --body hi",
      },
      {
        file: "actions/validate-template-report/action.yml:3",
        expected: "with.header: repo-platform/validate-template-report",
        got: "with.header: repo-platform/check-file-size",
      },
    ]);
    expect(
      stickyTreeMismatches([
        [GATED, host],
        ["templates/bun/fragments/gitignore.jinja", step(HEADER)],
        ["templates/bun/.github/dependabot.yml.jinja", step(HEADER)],
      ]).map((m) => [m.file, m.got]),
    ).toEqual([
      ["templates/bun/fragments/gitignore.jinja:3", "0 hosts ()"],
      ["templates/bun/.github/dependabot.yml.jinja:3", "0 hosts ()"],
    ]);
    expect(() =>
      stickyTreeMismatches([[WORKFLOW, `{#\n${step(HEADER)}\n#}\n`]], blankJinjaComments),
    ).toThrow(/no marocchino\/sticky-pull-request-comment step .* anchor lost/);
    expect(() => stickyTreeMismatches([[FRAGMENT, step(HEADER)]])).toThrow(
      /no template workflow sources found - anchor lost/,
    );
  });
});
