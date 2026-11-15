// What the autofix action decides rests on facts outside it: how git names a change, what a fast-forward lease refuses,
// which subjects the commit-names gate accepts, how Markdown closes a code span. None of these fail on their own when
// the code drifts, and a wrong verdict here pushes a commit with the write token. Every path and commit is synthetic.
// FORMAT and GENERATED are the shapes a member declares: a formatter's lists for the label, a generator's for a push.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import MarkdownIt from "markdown-it";
import {
  type Config,
  candidateSubject,
  type PullRequestEvent,
  type PushRequest,
  pushFix,
  type Runner,
  removeLabel,
  reportedSubject,
  type StageRequest,
  stageFix,
  startsFix,
  subjectOf,
  type Tools,
} from "../../../actions/autofix/autofix.ts";
import { displacedBy, noticeOf, type Outcome } from "../../../actions/autofix/notice.ts";
import {
  type Change,
  type FixEvent,
  type Lists,
  rejection,
} from "../../../actions/autofix/paths.ts";
import { capture, type RunResult } from "../../../actions/shared/action_runtime.ts";
import { commitlint } from "../../../actions/validate-commit-names/commitlint.ts";
import { REPO_ROOT } from "../../shared/action_step.ts";
import { boundedSpawnSync } from "../../shared/bounded_spawn.ts";
import { fixtureGit, fixtureGitEnv } from "../../shared/fixture_git.ts";
import { parseGithubOutput } from "../../shared/github_output.ts";
import { tempDirs } from "../../shared/temp_dir.ts";

const temp = tempDirs();
const markdown = new MarkdownIt();

const FORMAT = {
  paths: ["src/**", "tests/**", "docs/**", "*.ts", "*.json", "*.md"],
  delete: [],
};
const GENERATED = {
  paths: ["README.md", "docs/reference/{coverage,inputs}.md", "src/generated/{enums,rules}.ts"],
  delete: ["src/retired/"],
};
const EVERYTHING: Lists = { paths: ["**"], delete: ["**"] };
const GITHUB_REFUSED = "under .github/ outside .github/scripts/, which no fix changes";
const CONFIG: Config = { label: FORMAT, push: { ...GENERATED, on: ["src/**", "README.md"] } };

const file = (path: string, status = "M"): Change => ({
  path,
  status,
  oldMode: status === "A" ? "000000" : "100644",
  newMode: status === "D" ? "000000" : "100644",
});

// A list entry is matched by a glob library whose rules are its own: `*` stopping at a slash, `**` crossing them and
// reaching dotfiles, a closing slash read as the directory. A list that allowed more than it reads as would let a fix
// rewrite a file nobody listed.
test.each<{ reason: string; change: Change; lists: Lists; refused: string | null }>([
  {
    reason: "a change under a listed directory",
    change: file("src/a/b.ts"),
    lists: FORMAT,
    refused: null,
  },
  {
    reason: "a root file under a root glob",
    change: file("package.json"),
    lists: FORMAT,
    refused: null,
  },
  {
    reason: "a root glob does not reach a nested file",
    change: file("packages/x/package.json"),
    lists: FORMAT,
    refused: "outside the paths list",
  },
  {
    reason: "a brace list names its members alone",
    change: file("docs/reference/sections.md"),
    lists: GENERATED,
    refused: "outside the paths list",
  },
  {
    reason: "a new file under the list",
    change: file("docs/new.md", "A"),
    lists: FORMAT,
    refused: null,
  },
  {
    reason: "a deletion where only changes are listed",
    change: file("src/a.ts", "D"),
    lists: FORMAT,
    refused: "a deletion outside the delete list",
  },
  {
    reason: "a deletion under a directory of the delete list",
    change: file("src/retired/old/gap.ts", "D"),
    lists: GENERATED,
    refused: null,
  },
  {
    reason: "the delete list allows no change",
    change: file("src/retired/new.ts", "A"),
    lists: GENERATED,
    refused: "outside the paths list",
  },
  {
    reason: "a workflow, under lists that allow everything",
    change: file(".github/workflows/ci.yml"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason:
      "a workflow directory in another case, which a case-insensitive checkout folds onto .github",
    change: file(".GitHub/dependabot.yml", "D"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "a step script, under lists that allow everything",
    change: file(".github/scripts/check.ts"),
    lists: EVERYTHING,
    refused: null,
  },
  {
    reason: "a step script the lists name",
    change: file(".github/scripts/lib/check.ts", "A"),
    lists: { paths: [".github/scripts/**"], delete: [] },
    refused: null,
  },
  {
    reason: "a step script the lists do not name",
    change: file(".github/scripts/check.ts"),
    lists: FORMAT,
    refused: "outside the paths list",
  },
  {
    reason: "a step script deleted where no deletion is listed",
    change: file(".github/scripts/check.ts", "D"),
    lists: { paths: ["**"], delete: [] },
    refused: "a deletion outside the delete list",
  },
  {
    reason: "a nested .github under the scripts directory, which GitHub reads nothing from",
    change: file(".github/scripts/.github/workflows/x.yml", "A"),
    lists: EVERYTHING,
    refused: null,
  },
  {
    reason: "the scripts directory under .github in another case",
    change: file(".GitHub/scripts/x.ts"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "the scripts directory in another case",
    change: file(".github/SCRIPTS/x.ts"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "both in another case",
    change: file(".GitHub/Scripts/x.ts", "A"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "a file named scripts, not a directory",
    change: file(".github/scripts", "A"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "a directory whose name only starts with scripts",
    change: file(".github/scripts-evil/x.ts", "A"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "a file whose name only starts with scripts",
    change: file(".github/scriptsx", "A"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "a path that climbs out of the scripts directory to a workflow",
    change: file(".github/scripts/../workflows/ci.yml"),
    lists: EVERYTHING,
    refused: "the path carries an empty, '.', or '..' segment",
  },
  {
    reason: "a path that climbs out of the scripts directory from deeper",
    change: file(".github/scripts/x/../../workflows/ci.yml"),
    lists: EVERYTHING,
    refused: "the path carries an empty, '.', or '..' segment",
  },
  {
    reason: "a symbolic link under the scripts directory",
    change: { path: ".github/scripts/ci.yml", status: "A", oldMode: "000000", newMode: "120000" },
    lists: EVERYTHING,
    refused: "a symbolic link",
  },
  {
    reason: "a submodule under the scripts directory",
    change: { path: ".github/scripts/lib", status: "A", oldMode: "000000", newMode: "160000" },
    lists: EVERYTHING,
    refused: "a submodule",
  },
  {
    reason: "a workflow moved into the scripts directory: the half that deletes the workflow",
    change: file(".github/workflows/a.yml", "D"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "the hook, which a fixer must not rewrite",
    change: file(".github/actions/autofix/action.yml"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "a file directly under .github",
    change: file(".github/CODEOWNERS"),
    lists: EVERYTHING,
    refused: GITHUB_REFUSED,
  },
  {
    reason: "the registration, which holds the lists",
    change: file(".repo-platform.yml"),
    lists: EVERYTHING,
    refused: "the registration, which no fix changes",
  },
  {
    reason: "the submodule list",
    change: file(".gitmodules", "A"),
    lists: EVERYTHING,
    refused: "the submodule list, which no fix changes",
  },
  {
    reason: "a file replaced by a symbolic link",
    change: { path: "src/a.ts", status: "T", oldMode: "100644", newMode: "120000" },
    lists: EVERYTHING,
    refused: "a symbolic link",
  },
  {
    reason: "a symbolic link replaced by a file",
    change: { path: "src/a.ts", status: "T", oldMode: "120000", newMode: "100644" },
    lists: EVERYTHING,
    refused: "a symbolic link",
  },
  {
    reason: "a submodule",
    change: { path: "vendor/lib", status: "A", oldMode: "000000", newMode: "160000" },
    lists: EVERYTHING,
    refused: "a submodule",
  },
  {
    reason: "a path carrying a line feed",
    change: file("src/a\n::error::b.ts"),
    lists: EVERYTHING,
    refused: "the path carries a control character",
  },
  {
    reason: "a name whose bytes were not UTF-8, read back with the replacement character",
    change: file("src/\uFFFD.ts"),
    lists: { paths: ["src/\uFFFD.ts"], delete: [] },
    refused: "the path is not valid UTF-8",
  },
  {
    reason: "an unmerged entry",
    change: file("src/a.ts", "U"),
    lists: EVERYTHING,
    refused: "git status U",
  },
])("a fix may carry a change or not: $reason", ({ change, lists, refused }) => {
  expect(rejection(change, lists)).toBe(refused);
});

// The hook's subject is put to the commit-names gate, which reads a message: it passes a subject with a body under
// it, and the body would ride into the commit the write token pushes. So only one printable line ever reaches the gate.
test("a subject with a second line passes the gate's commitlint, and is never put to it", async () => {
  const withBody = "style: format\n\nCo-authored-by: Someone <someone@example.com>";
  const gate = await commitlint(withBody);
  expect({
    gate: gate.status,
    candidates: [
      withBody,
      "style: format",
      "style: format \u2192 y",
      "style: \u001b[31mred",
      "::error::forged",
      "style: format ##[error]forged",
      " ::add-mask::forged",
      " style: format ",
      `style: ${"x".repeat(100)}`,
      "",
    ].map(candidateSubject),
    refusedByTheGate: subjectOf("style: format", false),
    acceptedByTheGate: subjectOf("style: format", true),
    noCandidate: subjectOf("", true),
  }).toEqual({
    gate: 0,
    candidates: ["", "style: format", "", "", "", "", "", "style: format", "", ""],
    refusedByTheGate: "style: apply automated fixes",
    acceptedByTheGate: "style: format",
    noCandidate: "style: apply automated fixes",
  });
});

/** A lane's marker as the pinned sticky comment action builds it: its header follows `Comment` with no space. */
function stickyMarker(lane: FixEvent, opener = "<!--"): string {
  return `${opener} Sticky Pull Request Commentrepo-platform/autofix-${lane} -->`;
}

describe("the notice", () => {
  // A file name and the hook's findings are text the pull request chose. Unquoted, a name could open a link, a heading,
  // or a mention in the comment the write token posts, and a fence in the findings could end the block early.
  test("a path and findings written to break out of their quoting render as code and nothing else", () => {
    const hostile = "a`b](https://example.com) @octocat\n# heading ::error::x";
    const notice = noticeOf(
      "push",
      {
        kind: "refused",
        why: "the patch changes paths a fix may not carry.",
        refused: [{ path: hostile, reason: "outside the paths list" }],
      },
      {
        findings: `\`\`\`\n# not a heading\n[link](https://example.com)\n\`\`\`\`\n${"x".repeat(3000)}`,
        // No path at all: an empty span would be an opener that the next span's delimiter closes.
        dropped: [{ path: "", reason: displacedBy("`[click](https://example.com) @octocat") }],
      },
    );
    const html = markdown.render(notice);
    expect({
      links: html.includes("<a "),
      headings: /<h\d/.test(html),
      path: html.includes("<code>a`b](https://example.com) @octocat # heading ::error::x</code>"),
      findingsCut: notice.includes("x".repeat(2001)),
    }).toEqual({ links: false, headings: false, path: true, findingsCut: false });
  });

  // The sticky comment action finds a lane's comment by its marker anywhere in a comment's body. A path, a subject,
  // or findings holding the other lane's marker would make that lane's next run replace or delete this lane's comment.
  test.each<FixEvent>(["label", "push"])(
    "no text the pull request chose leaves the %s lane's sticky marker in a notice",
    (lane) => {
      const marker = stickyMarker(lane);
      const notices = [
        noticeOf(
          "label",
          { kind: "pushed", commit: "a".repeat(40), subject: `style: ${marker}` },
          {
            findings: `left ${marker}`,
            dropped: [{ path: `src/${marker}.ts`, reason: displacedBy(`docs/${marker}.md`) }],
          },
        ),
        noticeOf(
          "push",
          { kind: "refused", why: "x", refused: [{ path: `${marker}/a.ts`, reason: null }] },
          { findings: "", dropped: [] },
        ),
      ];
      expect({
        markers: notices.filter((notice) => notice.includes(marker)).length,
        comments: notices.filter((notice) => notice.includes("<!--")).length,
        shown: notices[0].includes(`left ${stickyMarker(lane, "<\\x21--")}`),
      }).toEqual({ markers: 0, comments: 0, shown: true });
    },
  );
});

describe("the event", () => {
  const event = (kind: FixEvent, changedFiles = 2): PullRequestEvent => ({
    kind,
    number: 7,
    sha: "a".repeat(40),
    ref: "topic",
    author: "octocat",
    changedFiles,
  });

  // Without the stand-down every push to every pull request would run the hook; with one too eager, a generator's
  // inputs change and nothing regenerates.
  test.each<{
    reason: string;
    kind: FixEvent;
    config: Config;
    files: string[];
    count?: number;
    run: boolean;
  }>([
    { reason: "the label, whatever changed", kind: "label", config: CONFIG, files: [], run: true },
    {
      reason: "a push with no push block",
      kind: "push",
      config: { ...CONFIG, push: null },
      files: ["src/a.ts"],
      run: false,
    },
    {
      reason: "a push touching an `on` glob",
      kind: "push",
      config: CONFIG,
      files: ["docs/x.md", "src/a.ts"],
      run: true,
    },
    {
      reason: "a push touching none",
      kind: "push",
      config: CONFIG,
      files: ["docs/x.md"],
      run: false,
    },
    {
      reason: "a push changing more files than the listing returns",
      kind: "push",
      config: CONFIG,
      files: [],
      count: 3001,
      run: true,
    },
  ])("a fix starts or stands down: $reason", ({ kind, config, files, count, run }) => {
    expect(startsFix(event(kind, count), config, () => files)).toBe(run);
  });
});

// The label is removed on every path, and a rerun meets it already gone. gh answers a second removal with an error
// in prose, so the labels read back are what says whether the removal is done. The routes are GitHub's own and no
// test reaches GitHub: a wrong one is green here and fails every real removal.
describe("removing the label", () => {
  const ok = (stdout = ""): RunResult => ({
    exit: { kind: "exited", code: 0 },
    stdout,
    stderr: "",
  });
  const failed: RunResult = {
    exit: { kind: "exited", code: 1 },
    stdout: "",
    stderr: "gh: Label does not exist",
  };
  const EVENT: PullRequestEvent = {
    kind: "label",
    number: 7,
    sha: "a".repeat(40),
    ref: "topic",
    author: "octocat",
    changedFiles: 1,
  };

  const LIST = "GET repos/example/widget/issues/7/labels";
  const DELETE = "DELETE repos/example/widget/issues/7/labels/fix-lint";

  function removal(answers: RunResult[]): { calls: string[]; error: string | null } {
    const calls: string[] = [];
    const run: Runner = (command) => {
      const route = command.find((word) => word.startsWith("repos/"));
      calls.push(`${command.includes("DELETE") ? "DELETE" : "GET"} ${route}`);
      return answers.shift() ?? failed;
    };
    try {
      removeLabel("example/widget", EVENT, { run, log: { info: () => {}, warning: () => {} } });
      return { calls, error: null };
    } catch (cause) {
      return { calls, error: (cause as Error).message };
    }
  }

  test.each<{ reason: string; answers: RunResult[]; calls: string[]; error: string | null }>([
    {
      reason: "the label is not on the pull request: a rerun",
      answers: [ok("bug\n")],
      calls: [LIST],
      error: null,
    },
    {
      reason: "the label is there and goes",
      answers: [ok("bug\nFix-Lint\n"), ok()],
      calls: [LIST, DELETE],
      error: null,
    },
    {
      reason: "the removal fails because another run took it first",
      answers: [ok("fix-lint\n"), failed, ok("")],
      calls: [LIST, DELETE, LIST],
      error: null,
    },
    {
      reason: "the removal fails and the label is still there",
      answers: [ok("fix-lint\n"), failed, ok("fix-lint\n")],
      calls: [LIST, DELETE, LIST],
      error: "removing the fix-lint label failed: gh: Label does not exist",
    },
    {
      reason: "the labels cannot be read",
      answers: [failed],
      calls: [LIST],
      error: "reading the pull request's labels failed: gh: Label does not exist",
    },
  ])("$reason", ({ answers, calls, error }) => {
    expect(removal(answers)).toEqual({ calls, error });
  });
});

// The two phases over real git: a bare repository stands for the remote, one clone for the job the hook runs in, a
// fresh clone for the job that pushes.
describe("stage and push", () => {
  const SEED: Record<string, string> = {
    "src/a.ts": "export const a   = 1;\n",
    "src/retired/old.ts": "export const gap = 1;\n",
    "docs/guide.md": "# Guide\n",
    "README.md": "# Widget\n",
    "LICENSE": "MIT\n",
    ".github/workflows/ci.yml": "name: CI\n",
  };
  const ambient = () => Object.keys(process.env).filter((name) => !(name in fixtureGitEnv()));
  const run: Runner = (command, options) =>
    capture(command, {
      ...options,
      env: {
        ...Object.fromEntries(ambient().map((name) => [name, undefined])),
        ...fixtureGitEnv(),
        ...options.env,
      },
    });
  const warnings: string[] = [];
  const tools: Tools = {
    run,
    log: { info: () => {}, warning: (text) => warnings.push(String(text)) },
  };

  let root: string;
  let origin: string;
  let clones = 0;
  let ancestor: string;
  let base: string;

  beforeAll(() => {
    root = temp.dir("autofix-phases-");
    origin = join(root, "origin.git");
    const seed = join(root, "seed");
    mkdirSync(seed);
    fixtureGit(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    fixtureGit(seed, ["init", "--quiet", "--initial-branch=main"]);
    const identity = ["-c", "user.name=Seed", "-c", "user.email=seed@example.com"];
    fixtureGit(seed, [...identity, "commit", "--quiet", "--allow-empty", "-m", "chore: root"]);
    ancestor = fixtureGit(seed, ["rev-parse", "HEAD"]);
    write(seed, SEED);
    fixtureGit(seed, ["add", "--all"]);
    fixtureGit(seed, [...identity, "commit", "--quiet", "-m", "chore: seed"]);
    fixtureGit(seed, ["push", "--quiet", origin, "main"]);
    base = fixtureGit(seed, ["rev-parse", "HEAD"]);
  });

  function write(directory: string, files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
  }

  /** A clone of the remote's branch, as a job's checkout. */
  function clone(branch: string, name: string): string {
    const directory = join(root, `${branch}-${name}`);
    fixtureGit(root, ["clone", "--quiet", "--branch", branch, origin, directory]);
    return directory;
  }

  const event = (kind: FixEvent, ref: string, author = "octocat"): PullRequestEvent => ({
    kind,
    number: 7,
    sha: base,
    ref,
    author,
    changedFiles: 1,
  });

  /** The stage job: the hook's changes written into a clone, then staged under the lists. */
  function staged(
    kind: FixEvent,
    branch: string,
    lists: Lists,
    hook: (directory: string) => void,
    said: Partial<Pick<StageRequest, "findings" | "subject">> = {},
  ): { out: string; changed: boolean } {
    fixtureGit(origin, ["update-ref", `refs/heads/${branch}`, base]);
    const repository = clone(branch, "stage");
    hook(repository);
    const out = join(root, `${branch}-out`);
    const request = { kind, lists, repository, out, findings: "", subject: "", ...said };
    return { out, changed: stageFix(request, tools) };
  }

  /** The push job: a fresh clone at the event's sha, the staged directory, the lists it read itself. */
  function pushed(kind: FixEvent, branch: string, lists: Lists, out: string, author?: string) {
    // The checkout is at the event's sha, wherever the branch is by now.
    const repository = clone(branch, `push-${clones++}`);
    fixtureGit(repository, ["checkout", "--quiet", "--detach", base]);
    return pushFix(request(event(kind, branch, author), lists, repository, out), tools);
  }

  const request = (
    prEvent: PullRequestEvent,
    lists: Lists,
    repository: string,
    out: string,
  ): PushRequest => ({
    event: prEvent,
    lists,
    repository,
    staged: out,
    subject: "style: format with biome",
    credential: null,
  });

  const remote = (branch: string) => fixtureGit(origin, ["rev-parse", `refs/heads/${branch}`]);
  const shown = (branch: string, format: string) =>
    fixtureGit(origin, ["show", "--no-patch", `--format=${format}`, `refs/heads/${branch}`]);
  const tree = (branch: string) =>
    fixtureGit(origin, [
      "diff",
      "--name-status",
      "--no-renames",
      base,
      `refs/heads/${branch}`,
    ]).split("\n");

  // The whole label path: what the lists allow is committed on the built sha and pushed, what they do not is named
  // and left out, and a rerun of the push job rebuilds the same commit and finds it there.
  test("the label: the allowed changes are pushed as one commit on the built sha, the rest is dropped and named, and a rerun converges", () => {
    const { out, changed } = staged(
      "label",
      "label-fix",
      FORMAT,
      (directory) =>
        write(directory, {
          "src/a.ts": "export const a = 1;\n",
          "docs/new.md": "# New\n",
          "LICENSE": "Apache\n",
          ".github/workflows/ci.yml": "name: Changed\n",
        }),
      { subject: "style: format with biome", findings: "src/a.ts:1 a finding\n" },
    );
    const first = pushed("label", "label-fix", FORMAT, out);
    const commit = remote("label-fix");
    const rerun = pushed("label", "label-fix", FORMAT, out);
    expect({
      changed,
      subjectForTheGate: reportedSubject(out),
      outcome: first.outcome,
      parent: shown("label-fix", "%P"),
      author: shown("label-fix", "%an <%ae>"),
      message: shown("label-fix", "%B"),
      tree: tree("label-fix"),
      rerun: rerun.outcome,
      afterRerun: remote("label-fix"),
      dropped: first.notice.split("\n").filter((line) => line.startsWith("- ")),
      findings: first.notice.includes("src/a.ts:1 a finding"),
    }).toEqual({
      changed: true,
      subjectForTheGate: "style: format with biome",
      outcome: { kind: "pushed", commit, subject: "style: format with biome" },
      parent: base,
      author: "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
      message: "style: format with biome",
      tree: ["A\tdocs/new.md", "M\tsrc/a.ts"],
      rerun: { kind: "pushed", commit, subject: "style: format with biome" },
      afterRerun: commit,
      dropped: ["- `.github/workflows/ci.yml`", "- `LICENSE`"],
      findings: true,
    });
  });

  // A regeneration: files change and a directory goes, all inside the push lists.
  test("a push: changes and a deletion inside the push lists are committed, with the trailer on a Dependabot pull request", () => {
    const { out } = staged("push", "push-fix", GENERATED, (directory) => {
      write(directory, { "README.md": "# Widget, regenerated\n" });
      rmSync(join(directory, "src/retired"), { recursive: true });
    });
    const result = pushed("push", "push-fix", GENERATED, out, "dependabot[bot]");
    expect({
      outcome: result.outcome.kind,
      tree: tree("push-fix"),
      message: shown("push-fix", "%B"),
    }).toEqual({
      outcome: "pushed",
      tree: ["M\tREADME.md", "D\tsrc/retired/old.ts"],
      message: "style: format with biome\n\n[dependabot skip]",
    });
  });

  test("a push whose fixer changed a path outside the push lists commits nothing and names the path", () => {
    const { out, changed } = staged("push", "push-refused", GENERATED, (directory) =>
      write(directory, { "README.md": "# Regenerated\n", "src/a.ts": "export const a = 2;\n" }),
    );
    const result = pushed("push", "push-refused", GENERATED, out);
    expect({
      changed,
      outcome: result.outcome.kind,
      names: result.notice.includes("- `src/a.ts`"),
      remote: remote("push-refused"),
    }).toEqual({ changed: false, outcome: "refused", names: true, remote: base });
  });

  // One fix, both rules: a formatter that also formats the step scripts under .github/scripts/ has that file carried
  // when the lists reach it, while the workflow beside it stays out under any list.
  test.each<{ kind: FixEvent; outcome: Outcome["kind"]; tree: string[]; named: string[] }>([
    {
      kind: "label",
      outcome: "pushed",
      tree: ["A\t.github/scripts/b.ts", "M\tsrc/a.ts"],
      named: ["- `.github/workflows/c.yml`"],
    },
    {
      kind: "push",
      outcome: "refused",
      tree: [""],
      named: ["- `.github/workflows/c.yml`"],
    },
  ])(
    "a fix that changes a source file, a step script, and a workflow under lists that allow everything: $kind",
    ({ kind, outcome, tree: carried, named }) => {
      const branch = `scripts-${kind}`;
      const lists: Lists = { paths: ["**"], delete: [] };
      const { out } = staged(kind, branch, lists, (directory) =>
        write(directory, {
          "src/a.ts": "export const a = 1;\n",
          ".github/scripts/b.ts": "export const b = 1;\n",
          ".github/workflows/c.yml": "name: Added\n",
        }),
      );
      const result = pushed(kind, branch, lists, out);
      expect({
        outcome: result.outcome.kind,
        tree: tree(branch),
        named: result.notice.split("\n").filter((line) => line.startsWith("- ")),
      }).toEqual({ outcome, tree: carried, named });
    },
  );

  // The stage job runs pull request code, so its patch may be anything. Each patch here is what a bypassed stage
  // could upload: built under lists that allow everything, then judged by the push job under the real ones.
  test.each<{
    reason: string;
    branch: string;
    hook: (directory: string) => void;
    path: string;
    why: string;
  }>([
    {
      reason: "a workflow rewritten",
      branch: "bypass-workflow",
      hook: (directory) =>
        write(directory, {
          ".github/workflows/ci.yml": "name: Owned\n",
          "src/a.ts": "export const a = 1;\n",
        }),
      path: ".github/workflows/ci.yml",
      why: GITHUB_REFUSED,
    },
    {
      reason: "a step script the lists do not name",
      branch: "bypass-script",
      hook: (directory) => write(directory, { ".github/scripts/b.ts": "export const b = 1;\n" }),
      path: ".github/scripts/b.ts",
      why: "outside the paths list",
    },
    {
      reason: "a file deleted where only changes are listed",
      branch: "bypass-delete",
      hook: (directory) => rmSync(join(directory, "src/a.ts")),
      path: "src/a.ts",
      why: "a deletion outside the delete list",
    },
    {
      reason: "a symbolic link added under a listed directory",
      branch: "bypass-symlink",
      hook: (directory) => symlinkSync("/etc/passwd", join(directory, "src/link.ts")),
      path: "src/link.ts",
      why: "a symbolic link",
    },
  ])(
    "a patch the stage job should never have built is refused whole: $reason",
    ({ branch, hook, path, why }) => {
      const { out } = staged(
        "label",
        branch,
        { paths: ["**", ".github/**"], delete: ["**"] },
        hook,
      );
      // The always-refused set is dropped by an honest stage, so the bypass writes the patch itself.
      const bypass = clone(branch, "bypass");
      hook(bypass);
      fixtureGit(bypass, ["add", "--all"]);
      fixtureGit(bypass, [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-renames",
        `--output=${join(out, "fix.patch")}`,
      ]);

      const result = pushed("label", branch, FORMAT, out);
      expect({ outcome: result.outcome, remote: remote(branch) }).toEqual({
        outcome: {
          kind: "refused",
          why: "the patch changes paths a fix may not carry.",
          refused: [{ path, reason: why }],
        },
        remote: base,
      });
    },
  );

  // The lease: a fix built on a sha is pushed only while the branch still names that sha.
  test("a branch that moved while the fix was built keeps its new head, and the run is superseded, not failed", () => {
    const { out } = staged("label", "moved", FORMAT, (directory) =>
      write(directory, { "src/a.ts": "export const a = 1;\n" }),
    );
    const other = clone("moved", "other");
    write(other, { "docs/guide.md": "# Guide, edited\n" });
    fixtureGit(other, [
      "-c",
      "user.name=Dev",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "--quiet",
      "--all",
      "-m",
      "docs: edit",
    ]);
    const head = fixtureGit(other, ["rev-parse", "HEAD"]);
    // The push job cloned before the branch moved; the remote moves between its checkout and its push.
    const repository = clone("moved", "push");
    fixtureGit(other, ["push", "--quiet", "origin", "moved"]);

    const result = pushFix(request(event("label", "moved"), FORMAT, repository, out), tools);
    expect({ outcome: result.outcome, remote: remote("moved") }).toEqual({
      outcome: { kind: "superseded", branch: "moved" },
      remote: head,
    });
  });

  // A branch moved BACK to an ancestor takes a plain push as a fast-forward: the lease is to the exact sha.
  test("a branch rewound to an ancestor is not pushed over, though the fix would fast-forward it", () => {
    const { out } = staged("label", "rewound", FORMAT, (directory) =>
      write(directory, { "src/a.ts": "export const a = 1;\n" }),
    );
    const repository = clone("rewound", "push");
    fixtureGit(origin, ["update-ref", "refs/heads/rewound", ancestor]);

    const result = pushFix(request(event("label", "rewound"), FORMAT, repository, out), tools);
    expect({ outcome: result.outcome, remote: remote("rewound") }).toEqual({
      outcome: { kind: "superseded", branch: "moved" },
      remote: ancestor,
    });
  });

  // A deleted branch refuses the leased push as a moved one does, and no new head follows it: a notice promising the
  // new head its own run, or asking for the label again, would send the reader after a branch that is not there.
  test.each<FixEvent>(["label", "push"])(
    "a branch deleted while the %s fix was built reads as superseded, and the notice says it is gone",
    (kind) => {
      const branch = `gone-${kind}`;
      const lists = kind === "label" ? FORMAT : GENERATED;
      const { out } = staged(kind, branch, lists, (directory) =>
        write(directory, { "README.md": "# Widget, fixed\n" }),
      );
      const repository = clone(branch, "push");
      fixtureGit(origin, ["update-ref", "-d", `refs/heads/${branch}`]);

      const result = pushFix(request(event(kind, branch), lists, repository, out), tools);
      expect({
        result,
        branches: fixtureGit(origin, ["for-each-ref", `refs/heads/${branch}`]),
      }).toEqual({
        result: {
          outcome: { kind: "superseded", branch: "gone" },
          notice: "Not pushed: the branch was deleted while the fix was built.",
        },
        branches: "",
      });
    },
  );

  // `git ls-remote origin refs/heads/topic` also answers for refs/heads/a/refs/heads/topic, which sorts first: git
  // matches the pattern against the tail of a ref name. Read by position, the decoy's sha stands for the branch's.
  test("a rejected push is classed by the branch itself, not by another branch whose name ends in its full name", () => {
    const { out } = staged("label", "decoyed", FORMAT, (directory) =>
      write(directory, { "src/a.ts": "export const a = 1;\n" }),
    );
    const repository = clone("decoyed", "push");
    // The decoy names the leased sha, so the moved branch would read as unmoved, and the race as a failure.
    fixtureGit(origin, ["update-ref", "refs/heads/a/refs/heads/decoyed", base]);
    fixtureGit(origin, ["update-ref", "refs/heads/decoyed", ancestor]);

    const result = pushFix(request(event("label", "decoyed"), FORMAT, repository, out), tools);
    expect({ outcome: result.outcome, remote: remote("decoyed") }).toEqual({
      outcome: { kind: "superseded", branch: "moved" },
      remote: ancestor,
    });
  });

  // A remote that refuses the push for its own reasons (a protected branch) says "rejected" as a moved branch does,
  // and a patch git will not apply never reaches the remote: the notice may claim of the branch only what was read.
  test.each<{
    reason: string;
    branch: string;
    spoil?: string;
    unreadable?: boolean;
    headline: string;
  }>([
    {
      reason: "the patch does not apply, so nothing was pushed",
      branch: "guarded-apply",
      spoil: [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-a line the file does not hold",
        "+x",
        "",
      ].join("\n"),
      headline: "The fix failed before anything was pushed: the patch does not apply to BASE.",
    },
    {
      reason: "the remote refuses the push and the branch reads back unmoved",
      branch: "guarded-unmoved",
      headline:
        "The push failed and the branch has not moved: git push was rejected; the run's log has git's words.",
    },
    {
      reason: "the remote refuses the push and then cannot be read",
      branch: "guarded-unread",
      unreadable: true,
      headline:
        "The push failed, and the branch could not be read back: git push was rejected; the run's log has git's words.",
    },
  ])(
    "a failed fix claims only what was checked: $reason",
    ({ branch, spoil, unreadable, headline }) => {
      const { out } = staged("label", branch, FORMAT, (directory) =>
        write(directory, { "src/a.ts": "export const a = 1;\n" }),
      );
      if (spoil !== undefined) writeFileSync(join(out, "fix.patch"), spoil);
      const hook = join(origin, "hooks/update");
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/heads/guarded-*) exit 1 ;; esac\n');
      chmodSync(hook, 0o755);

      const repository = clone(branch, "push");
      // The remote goes away after it refused the push: the read back is the one command that finds it gone.
      const losingRemote: Tools = {
        ...tools,
        run: (command, options) => {
          if (unreadable === true && command[1] === "ls-remote") {
            fixtureGit(repository, ["remote", "set-url", "origin", join(root, "no-such.git")]);
          }

          return run(command, options);
        },
      };
      const result = pushFix(
        request(event("label", branch), FORMAT, repository, out),
        losingRemote,
      );
      expect({
        outcome: result.outcome.kind,
        headline: result.notice.split("\n")[0],
        remote: remote(branch),
      }).toEqual({ outcome: "failed", headline: headline.replace("BASE", base), remote: base });
    },
  );

  // A file name is bytes, and git's are read here as UTF-8: a name that is none comes back changed. Unstaged by the
  // name as read, the file stayed in the patch, and the push job refused the whole fix for one stray file. The name is
  // put into the index directly, because not every file system stores such a name.
  test("the label drops a file whose name is not UTF-8 and names it, and the rest is pushed, a deletion included", () => {
    const stray = Buffer.concat([Buffer.from("src/caf"), Buffer.from([0xe9]), Buffer.from(".ts")]);
    const hookWithStray: Tools = {
      ...tools,
      run: (command, options) => {
        const result = run(command, options);
        if (command.join(" ") !== "git add --all") return result;

        const blob = fixtureGit(options.cwd ?? "", ["rev-parse", "HEAD:src/a.ts"]);
        const entry = Buffer.concat([Buffer.from(`100644 ${blob}\t`), stray, Buffer.from([0])]);
        const added = boundedSpawnSync(["git", "update-index", "-z", "--index-info"], {
          cwd: options.cwd,
          env: fixtureGitEnv(),
          stdin: entry,
        });
        if (added.exitCode !== 0) throw new Error(added.stderr);

        return result;
      },
    };
    fixtureGit(origin, ["update-ref", "refs/heads/stray-name", base]);
    const repository = clone("stray-name", "stage");
    write(repository, { "src/a.ts": "export const a = 1;\n" });
    rmSync(join(repository, "LICENSE"));
    rmSync(join(repository, "src/retired"), { recursive: true });
    const lists = { paths: FORMAT.paths, delete: ["src/retired/"] };
    const out = join(root, "stray-name-out");
    stageFix({ kind: "label", lists, repository, out, findings: "", subject: "" }, hookWithStray);

    const result = pushed("label", "stray-name", lists, out);
    expect({
      outcome: result.outcome.kind,
      tree: tree("stray-name"),
      dropped: result.notice.split("\n").filter((line) => line.startsWith("- ")),
    }).toEqual({
      outcome: "pushed",
      tree: ["M\tsrc/a.ts", "D\tsrc/retired/old.ts"],
      dropped: ["- `LICENSE`", "- `src/caf\uFFFD.ts`"],
    });
  });

  // git reads a pathspec that names a directory as everything under it. A dropped or carried path unstaged or staged
  // that way takes its neighbours along when a file and a directory swapped places: a refused file rides into the
  // patch, or an allowed deletion is lost without a word.
  test("the label drops exactly the paths outside its lists when a file became a directory and a directory a file", () => {
    const lists = { paths: ["src/a.ts"], delete: ["LICENSE", "src/retired/"] };
    const { out } = staged("label", "swapped", lists, (directory) => {
      rmSync(join(directory, "LICENSE"));
      rmSync(join(directory, "src/retired"), { recursive: true });
      write(directory, {
        "LICENSE/private.txt": "x\n",
        "src/retired": "now a file\n",
        "src/a.ts": "export const a = 1;\n",
      });
    });

    const result = pushed("label", "swapped", lists, out);
    expect({
      outcome: result.outcome.kind,
      tree: tree("swapped"),
      dropped: result.notice.split("\n").filter((line) => line.startsWith("- ")),
    }).toEqual({
      outcome: "pushed",
      tree: ["D\tLICENSE", "M\tsrc/a.ts", "D\tsrc/retired/old.ts"],
      dropped: ["- `LICENSE/private.txt`", "- `src/retired`"],
    });
  });

  // Git holds a name as a file or as a directory, never both. Bringing a refused deletion back into the index evicts
  // the allowed file that took its place: the commit lacked it, the run was green, and the notice named only the deletion.
  test.each<{
    reason: string;
    branch: string;
    paths: string[];
    hook: (directory: string) => void;
    dropped: string[];
  }>([
    {
      reason: "a directory's file deleted and a file added under the directory's name",
      branch: "evicted-file",
      paths: ["src/a.ts", "src/retired"],
      hook: (directory) => {
        rmSync(join(directory, "src/retired"), { recursive: true });
        write(directory, { "src/retired": "now a file\n" });
      },
      dropped: [
        "- `src/retired`: cannot be carried without deleting `src/retired/old.ts`",
        "- `src/retired/old.ts`",
      ],
    },
    {
      reason: "a file deleted and a file added under a directory of its name",
      branch: "evicted-directory",
      paths: ["src/a.ts", "LICENSE/x.txt"],
      hook: (directory) => {
        rmSync(join(directory, "LICENSE"));
        write(directory, { "LICENSE/x.txt": "x\n" });
      },
      dropped: ["- `LICENSE`", "- `LICENSE/x.txt`: cannot be carried without deleting `LICENSE`"],
    },
  ])(
    "the label names an allowed addition that a refused deletion takes out of the commit: $reason",
    ({ branch, paths, hook, dropped }) => {
      const lists = { paths, delete: [] };
      const { out } = staged("label", branch, lists, (directory) => {
        hook(directory);
        write(directory, { "src/a.ts": "export const a = 1;\n" });
      });

      const result = pushed("label", branch, lists, out);
      expect({
        outcome: result.outcome.kind,
        tree: tree(branch),
        dropped: result.notice.split("\n").filter((line) => line.startsWith("- ")),
      }).toEqual({ outcome: "pushed", tree: ["M\tsrc/a.ts"], dropped });
    },
  );

  test("a hook that changed nothing: no commit, the label says so and a push says nothing", () => {
    const label = staged("label", "clean-label", FORMAT, () => {});
    const push = staged("push", "clean-push", GENERATED, () => {});
    expect({
      changed: [label.changed, push.changed],
      label: pushed("label", "clean-label", FORMAT, label.out).notice,
      push: pushed("push", "clean-push", GENERATED, push.out).notice,
      remotes: [remote("clean-label"), remote("clean-push")],
    }).toEqual({
      changed: [false, false],
      label: "Nothing to fix: the fixer changed no file.",
      push: "",
      remotes: [base, base],
    });
  });

  // The push job's checkout is the pull request's tree, and git runs a repository's hooks on commit. A hook that ran
  // there would run beside the write token.
  test("a git hook in the push job's checkout does not run", () => {
    const { out } = staged("label", "hooks", FORMAT, (directory) =>
      write(directory, { "src/a.ts": "export const a = 1;\n" }),
    );
    const repository = clone("hooks", "push");
    const marker = join(root, "hook-ran");
    for (const hook of ["pre-commit", "post-commit", "pre-push"]) {
      const path = join(repository, ".git/hooks", hook);
      writeFileSync(path, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(path, 0o755);
    }

    const result = pushFix(request(event("label", "hooks"), FORMAT, repository, out), tools);
    expect({ outcome: result.outcome.kind, hookRan: existsSync(marker) }).toEqual({
      outcome: "pushed",
      hookRan: false,
    });
  });

  // git prints the path it refuses, and a path can hold a line feed. Logged as git wrote it, the line after the feed
  // opens with `::` and the runner reads it as a command; it reads a `##[` anywhere in a line as one too.
  test("a patch whose path git refuses fails the fix, and no line of git's words reaches the log as a workflow command", () => {
    const { out } = staged("label", "forged-log", FORMAT, () => {});
    const path = String.raw`"b/../##[error]old\n::error::forged"`;
    const patch = [
      String.raw`diff --git "a/../##[error]old\n::error::forged" ${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ ${path}`,
      "@@ -0,0 +1 @@",
      "+x",
      "",
    ].join("\n");
    writeFileSync(join(out, "fix.patch"), patch);
    const logged: string[] = [];
    const recording: Tools = { run, log: { info: (text) => logged.push(text), warning: () => {} } };
    const repository = clone("forged-log", "push");

    const result = pushFix(
      request(event("label", "forged-log"), FORMAT, repository, out),
      recording,
    );
    const lines = logged.join("\n").split("\n");
    expect({
      outcome: result.outcome.kind,
      said: lines.some((line) => line.includes("::error::forged")),
      commands: lines.filter((line) => !line.startsWith("  | ") || line.includes("##[")),
    }).toEqual({ outcome: "failed", said: true, commands: [] });
  });

  // A phase that throws ends as an error annotation, and git's errors name the pull request's paths. The annotation
  // is one more place the pull request's text is published, so it passes the same quoting as the notice.
  test("a stage that git fails names the path in its error annotation with no HTML comment opener", () => {
    fixtureGit(origin, ["update-ref", "refs/heads/unreadable", base]);
    const repository = clone("unreadable", "stage");
    write(repository, { "src/<!-- marker -->.ts": "x\n" });
    chmodSync(join(repository, "src/<!-- marker -->.ts"), 0o000);
    const payload = {
      action: "labeled",
      label: { name: "fix-lint" },
      pull_request: {
        number: 7,
        head: { sha: base, ref: "unreadable" },
        user: { login: "octocat" },
      },
    };
    writeFileSync(join(root, "unreadable-event.json"), JSON.stringify(payload));

    const child = boundedSpawnSync(
      [process.execPath, join(REPO_ROOT, "actions/autofix/autofix.ts")],
      {
        cwd: root,
        env: {
          ...fixtureGitEnv(),
          PATH: process.env.PATH ?? "",
          PHASE: "stage",
          CONFIG: JSON.stringify(CONFIG),
          REPOSITORY_DIRECTORY: repository,
          RUNNER_TEMP: join(root, "unreadable-temp"),
          GITHUB_REPOSITORY: "example/widget",
          GITHUB_EVENT_PATH: join(root, "unreadable-event.json"),
        },
      },
    );
    const annotation = child.stdout.split("\n").find((line) => line.startsWith("::error::")) ?? "";
    expect({
      exitCode: child.exitCode,
      named: annotation.includes("src/<\\x21-- marker -->.ts"),
      opener: child.stdout.includes("<!--"),
    }).toEqual({ exitCode: 1, named: true, opener: false });
  });

  // What crosses from the stage job is data, read as data: anything that is not the two regular files is refused
  // before git reads a byte of it.
  test.each<{ reason: string; spoil: (out: string) => void; error: string }>([
    {
      reason: "a report that is not the report's shape",
      spoil: (out) => writeFileSync(join(out, "report.json"), '{"subject":"x","extra":true}'),
      error: "the staged report.json is not a report",
    },
    ...[
      { path: "", without: null },
      { path: "src/a.ts", without: "" },
    ].map((dropped) => ({
      reason: `a report naming no text as a path: ${JSON.stringify(dropped)}`,
      spoil: (out: string) =>
        writeFileSync(
          join(out, "report.json"),
          JSON.stringify({ subject: "", findings: "", dropped: [dropped], refused: [] }),
        ),
      error: "the staged report.json is not a report",
    })),
    {
      reason: "a report refusing no text as a path",
      spoil: (out) =>
        writeFileSync(
          join(out, "report.json"),
          JSON.stringify({ subject: "", findings: "", dropped: [], refused: [""] }),
        ),
      error: "the staged report.json is not a report",
    },
    {
      reason: "a patch that is a symbolic link",
      spoil: (out) => {
        rmSync(join(out, "fix.patch"));
        symlinkSync("/etc/passwd", join(out, "fix.patch"));
      },
      error: "the staged fix.patch is missing or is not a regular file",
    },
  ])("a staged directory is refused: $reason", ({ reason, spoil, error }) => {
    const name = `spoiled-${reason.replaceAll(/\W+/g, "-")}`;
    const { out } = staged("label", name, FORMAT, (directory) =>
      write(directory, { "src/a.ts": "export const a = 1;\n" }),
    );
    spoil(out);
    expect(() => pushed("label", name, FORMAT, out)).toThrow(error);
  });
});

// Each phase runs from a workflow step that passes it only the inputs that phase reads. A phase that asked for one
// more (the lists, in a step that reads the report alone) fails every fix at that step, green in every unit test.
test("the read phase runs on the staged directory and the event alone, and hands back the subject", () => {
  const root = temp.dir("autofix-read-");
  const output = join(root, "output");
  writeFileSync(output, "");
  writeFileSync(
    join(root, "report.json"),
    JSON.stringify({ subject: "style: format", findings: "", dropped: [], refused: [] }),
  );
  writeFileSync(
    join(root, "event.json"),
    JSON.stringify({
      action: "synchronize",
      pull_request: {
        number: 7,
        head: { sha: "a".repeat(40), ref: "topic" },
        user: { login: "octocat" },
      },
    }),
  );
  const child = boundedSpawnSync(
    [process.execPath, join(REPO_ROOT, "actions/autofix/autofix.ts")],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        PHASE: "read",
        STAGED_DIRECTORY: root,
        GITHUB_REPOSITORY: "example/widget",
        GITHUB_EVENT_PATH: join(root, "event.json"),
        GITHUB_OUTPUT: output,
      },
    },
  );
  expect({
    exitCode: child.exitCode,
    outputs: parseGithubOutput(readFileSync(output, "utf8")),
  }).toEqual({ exitCode: 0, outputs: { subject: "style: format" } });
});
