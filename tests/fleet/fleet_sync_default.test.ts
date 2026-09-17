import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOT_LOGIN,
  DELIVERED_SURFACE,
  deliveredBySync,
  type LabelEvent,
  type LabelHistory,
  LISTED_PATHS,
  labelHistory,
  MARKER,
  noteBody,
  type Plan,
  type PullRequest,
  plan,
} from "../../.github/scripts/fleet/fleet_sync_default.ts";
import {
  FLEET_SYNC_OVERLAY,
  fleetSyncLabels,
} from "../../.github/scripts/post-green/fleet_sync_marker.ts";
import { loadLayer } from "../../.github/scripts/sync/writer/settings_layers.ts";
import { argvStub } from "../shared/argv_stub";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const KNOWN = fleetSyncLabels(loadLayer(FLEET_SYNC_OVERLAY).doc, "overlay");
const PUBLIC = "fleet-sync:public";
const ALL = "fleet-sync:all";
const HUMAN = "vivswan";

const DOCS =
  "https://github.com/Vivswan/repo-platform/blob/main/docs/all-green.md#opting-a-pr-into-an-immediate-fleet-sync";
const ADDED_TWO = [
  "<!-- repo-platform/fleet-sync-default -->",
  "Added `fleet-sync:public`: this pull request changes what a fleet sync delivers, so the public repos sync from its merge.",
  "",
  "- `files.yml`",
  "- `files/base/AGENTS.md`",
  "",
  "Remove the label if you do not want that; with no label the weekly schedule carries it. `fleet-sync:all` only when necessary and approved by the repository owner: it bills private minutes. Details: " +
    `[all-green.md](${DOCS}).`,
  "",
].join("\n");
const KEPT_OFF_ONE = [
  MARKER,
  "`fleet-sync:public` was removed by vivswan; not re-adding it. This pull request changes what a fleet sync delivers:",
  "",
  "- `files.yml`",
  "",
  `With no label the weekly schedule carries it. Details: [all-green.md](${DOCS}).`,
  "",
].join("\n");
const TWO_SCOPES = "2 fleet-sync labels (fleet-sync:all, fleet-sync:public): one scope per merge";

const NEVER: LabelHistory = { lastAddedBy: null, removedBy: null };
const BOT_ADDED: LabelHistory = { lastAddedBy: BOT_LOGIN, removedBy: null };
const HUMAN_REMOVED: LabelHistory = { lastAddedBy: BOT_LOGIN, removedBy: HUMAN };
const HUMAN_READDED: LabelHistory = { lastAddedBy: HUMAN, removedBy: HUMAN };

const pr = (over: Partial<PullRequest>): PullRequest => ({
  open: true,
  changed: ["files/base/AGENTS.md", "docs/sync.md", "files.yml", "files/base/AGENTS.md"],
  labels: [],
  base: "main",
  defaultBranch: "main",
  history: NEVER,
  ...over,
});
const added = (label: Plan["label"], ...paths: string[]): Plan => ({
  label,
  comment: { kind: "comment", body: noteBody(paths, KNOWN, { kind: "added" }) },
});
const cleared = (label: Plan["label"], reason: string): Plan => ({
  label,
  comment: { kind: "clear", reason },
});
const TWO = ["files.yml", "files/base/AGENTS.md"];

describe("deliveredBySync", () => {
  test.each<[string, boolean]>([
    ["files.yml", true],
    ["files/base/AGENTS.md", true],
    ["files/bun/.bun-version", true],
    ["migrations/one-rung.ts", true],
    [".github/scripts/sync/writer/sync.ts", true],
    [".github/scripts/sync/deliver.ts", true],
    [".github/scripts/shared/proc.ts", true],
    ["actions/validate-managed-files/action.yml", true],
    ["actions/plan/plan.ts", true],
    ["bun.lock", true],
    ["package.json", true],
    [".github/workflows/fleet-ci.yml", false],
    [".github/scripts/fleet/fleet_sync_default.ts", false],
    [".github/settings.local.yml", false],
    ["docs/sync.md", false],
    ["knip.jsonc", false],
    ["files.yml.orig", false],
    ["filesystem/x.ts", false],
  ])("%s -> %p", (path, expected) => {
    expect(deliveredBySync(path)).toBe(expected);
  });
});

describe("the delivered surface", () => {
  const REPO_ROOT = new URL("../..", import.meta.url).pathname;

  test("is the list docs/all-green.md documents, each path the kind its spelling says", () => {
    const line = readFileSync(join(REPO_ROOT, "docs/all-green.md"), "utf-8")
      .split("\n")
      .find((l) => l.includes("`DELIVERED_SURFACE`"));
    expect(line).toBeDefined();
    const spans = [...(line ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    // The paths are the code spans before the one naming the constant.
    const named = spans.indexOf("DELIVERED_SURFACE");
    expect(named).toBeGreaterThan(0);
    expect(spans.slice(0, named)).toEqual([...DELIVERED_SURFACE]);
    for (const path of DELIVERED_SURFACE) {
      expect(lstatSync(join(REPO_ROOT, path)).isDirectory()).toBe(path.endsWith("/"));
    }
  });
});

describe("labelHistory", () => {
  const ev = (event: string, actor: string | null, label?: string): LabelEvent => ({
    event,
    actor: actor === null ? null : { login: actor },
    ...(label === undefined ? {} : { label: { name: label } }),
  });
  test.each<{ reason: string; events: LabelEvent[]; expected: LabelHistory }>([
    { reason: "no label event yet", events: [ev("assigned", HUMAN)], expected: NEVER },
    { reason: "the bot added it", events: [ev("labeled", BOT_LOGIN, PUBLIC)], expected: BOT_ADDED },
    {
      reason: "a human took the bot's label off",
      events: [ev("labeled", BOT_LOGIN, PUBLIC), ev("unlabeled", HUMAN, "Fleet-Sync:Public")],
      expected: HUMAN_REMOVED,
    },
    {
      reason: "a human took it off and put it back: theirs now, and the removal still stands",
      events: [
        ev("labeled", BOT_LOGIN, PUBLIC),
        ev("unlabeled", HUMAN, PUBLIC),
        ev("labeled", HUMAN, PUBLIC),
      ],
      expected: HUMAN_READDED,
    },
    {
      reason:
        "the bot withdrawing its own label is no human decision, and other labels do not count",
      events: [
        ev("labeled", BOT_LOGIN, PUBLIC),
        ev("unlabeled", BOT_LOGIN, PUBLIC),
        ev("labeled", HUMAN, ALL),
        ev("unlabeled", HUMAN, "bug"),
        ev("unlabeled", null, PUBLIC),
      ],
      expected: BOT_ADDED,
    },
  ])("$reason", ({ events, expected }) => {
    expect(labelHistory(events, PUBLIC)).toEqual(expected);
  });
});

describe("plan", () => {
  test("a fresh pull request touching the delivered paths gets the public label and the note, paths sorted and deduplicated", () => {
    expect(plan(pr({ labels: ["bug"] }), KNOWN)).toEqual(added("add", ...TWO));
    expect(noteBody(TWO, KNOWN, { kind: "added" })).toBe(ADDED_TWO);
  });

  test.each<{ reason: string; pr: PullRequest; expected: Plan }>([
    {
      reason: "the bot's label is on: nothing to do, the note stays current",
      pr: pr({ labels: [PUBLIC], history: BOT_ADDED }),
      expected: added("keep", ...TWO),
    },
    {
      reason: "a human took the label off: final, the note says so",
      pr: pr({ history: HUMAN_REMOVED }),
      expected: {
        label: "keep",
        comment: { kind: "comment", body: noteBody(TWO, KNOWN, { kind: "kept-off", by: HUMAN }) },
      },
    },
    {
      reason: "a human put the label back themselves: their choice, no note",
      pr: pr({ labels: [PUBLIC], history: HUMAN_READDED }),
      expected: cleared("keep", "fleet-sync:public chosen"),
    },
    {
      reason: "a human picked all beside the bot's public: the bot's is withdrawn, no note",
      pr: pr({ labels: [PUBLIC, ALL], history: BOT_ADDED }),
      expected: cleared("remove", "fleet-sync:all chosen"),
    },
    {
      reason: "two human labels: the refusal is named, nothing withdrawn",
      pr: pr({ labels: [ALL, PUBLIC], history: HUMAN_READDED }),
      expected: {
        label: "keep",
        comment: {
          kind: "comment",
          body: noteBody(TWO, KNOWN, { kind: "refused", error: TWO_SCOPES }),
        },
      },
    },
    {
      reason: "the delivered paths left the diff: the bot's label and note go",
      pr: pr({ changed: [".github/workflows/fleet-ci.yml"], labels: [PUBLIC], history: BOT_ADDED }),
      expected: cleared("remove", "no path here reaches the fleet through a sync"),
    },
    {
      reason: "the delivered paths left the diff and the label is a human's: it stays",
      pr: pr({ changed: ["docs/all-green.md"], labels: [PUBLIC], history: HUMAN_READDED }),
      expected: cleared("keep", "no path here reaches the fleet through a sync"),
    },
    {
      reason: "a stacked pull request merges into a branch no sync reads",
      pr: pr({ base: "feat/parent", labels: [PUBLIC], history: BOT_ADDED }),
      expected: cleared("remove", "merges into feat/parent, not main"),
    },
    {
      reason: "a closed pull request is left as it is, label and note",
      pr: pr({ open: false, labels: [PUBLIC], history: BOT_ADDED }),
      expected: { label: "keep", comment: { kind: "leave", reason: "the pull request is closed" } },
    },
    {
      reason: "nothing delivered and nothing to withdraw",
      pr: pr({ changed: ["docs/all-green.md"] }),
      expected: cleared("keep", "no path here reaches the fleet through a sync"),
    },
  ])("$reason", ({ pr, expected }) => {
    expect(plan(pr, KNOWN)).toEqual(expected);
  });

  test("the kept-off and refused notes, and a sweep lists the first paths and counts the rest", () => {
    expect(noteBody(["files.yml"], KNOWN, { kind: "kept-off", by: HUMAN })).toBe(KEPT_OFF_ONE);
    expect(noteBody(["files.yml"], KNOWN, { kind: "refused", error: TWO_SCOPES })).toBe(
      [
        MARKER,
        "This pull request changes what a fleet sync delivers:",
        "",
        "- `files.yml`",
        "",
        `Its fleet-sync label would be refused at merge and nothing would sync: ${TWO_SCOPES}. Details: [all-green.md](${DOCS}).`,
        "",
      ].join("\n"),
    );
    const paths = Array.from({ length: LISTED_PATHS + 2 }, (_, i) => `files/base/f${i}.md`);
    const lines = noteBody(paths, KNOWN, { kind: "added" }).split("\n");
    expect(lines.slice(3, 3 + LISTED_PATHS)).toEqual(
      paths.slice(0, LISTED_PATHS).map((path) => `- \`${path}\``),
    );
    expect(lines[3 + LISTED_PATHS]).toBe("- and 2 more");
    expect(lines[4 + LISTED_PATHS]).toBe("");
  });
});

describe("main", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/fleet_sync_default.ts");
  const root = temp.dir("fleet-sync-default-");
  // The stub answers each endpoint from the scenario's directory; an endpoint with no file answers `{}` (a write's reply).
  // DENY_WRITES is a fork's token: reads pass, every -X call is refused.
  const gh = argvStub(root, "gh", [
    'if [ -n "$DENY_WRITES" ] && [ "$3" = "-X" ]; then echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi',
    'key=$(printf "%s" "$2" | tr "/" "_")',
    'if [ -f "$ANSWERS/$key.json" ]; then cat "$ANSWERS/$key.json"; else printf "{}"; fi',
  ]);

  type File = { filename: string; previous_filename?: string };
  type Comment = { id: number; body: string };
  interface Scenario {
    files: File[][];
    labels: string[];
    events: LabelEvent[];
    comments: Comment[];
    base?: string;
    state?: "open" | "closed";
    /** The pull request's own count; the listing's length unless a scenario says otherwise. */
    changedFiles?: number;
    stubEnv?: Record<string, string>;
  }
  const file = (filename: string, previous_filename?: string): File =>
    previous_filename === undefined ? { filename } : { filename, previous_filename };
  const ev = (event: string, actor: string, label: string): LabelEvent => ({
    event,
    actor: { login: actor },
    label: { name: label },
  });
  const note = (...paths: string[]) => noteBody(paths, KNOWN, { kind: "added" });

  const PULL = "repos/o/r/pulls/7";
  const ISSUE = "repos/o/r/issues/7";
  const COMMENTS = `${ISSUE}/comments`;
  const comment = (id: number) => `repos/o/r/issues/comments/${id}`;
  const READS = [
    [PULL],
    [`${PULL}/files`, "--paginate", "--slurp"],
    [`${ISSUE}/events`, "--paginate", "--slurp"],
  ];
  const COMMENTS_READ = [COMMENTS, "--paginate", "--slurp"];
  const labelAdded = [`${ISSUE}/labels`, "-X", "POST", "-f", `labels[]=${PUBLIC}`];
  const labelRemoved = [`${ISSUE}/labels/fleet-sync%3Apublic`, "-X", "DELETE"];
  const posted = (body: string) => [COMMENTS, "-X", "POST", "-f", `body=${body}`];
  const patched = (id: number, body: string) => [comment(id), "-X", "PATCH", "-f", `body=${body}`];
  const deleted = (id: number) => [comment(id), "-X", "DELETE"];
  const notice = (label: string, text: string) => `::notice::${label}; ${text}\n`;
  const warning = (text: string) => `::warning::fleet-sync default skipped: ${text}\n`;

  function run(name: string, scenario: Scenario) {
    const answers = join(root, name);
    mkdirSync(answers);
    const answer = (endpoint: string, value: unknown) =>
      writeFileSync(join(answers, `${endpoint.replaceAll("/", "_")}.json`), JSON.stringify(value));
    answer(PULL, {
      state: scenario.state ?? "open",
      labels: scenario.labels.map((label) => ({ name: label })),
      changed_files: scenario.changedFiles ?? scenario.files.flat().length,
      base: { ref: scenario.base ?? "main", repo: { default_branch: "main" } },
    });
    answer(`${PULL}/files`, scenario.files);
    answer(`${ISSUE}/events`, [scenario.events]);
    answer(COMMENTS, [scenario.comments]);
    const before = gh.calls().length;
    const proc = boundedSpawnSync(["bun", script], {
      env: {
        ...process.env,
        PATH: `${gh.bin}:${process.env.PATH}`,
        GH_TOKEN: "t",
        GITHUB_REPOSITORY: "o/r",
        PR_NUMBER: "7",
        ANSWERS: answers,
        ...scenario.stubEnv,
      },
    });
    const calls = gh
      .calls()
      .slice(before)
      .map((call) => call.slice(2));
    return { exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr, calls };
  }

  const trigger = [[file("files/base/AGENTS.md"), file("docs/sync.md"), file("files.yml")]];
  const workflow = [[file(".github/workflows/fleet-ci.yml")]];
  const botAdded = [ev("labeled", BOT_LOGIN, PUBLIC)];

  test("a fresh pull request gets the label and the note; the next run finds both current", () => {
    const body = note(...TWO);
    expect(run("fresh", { files: trigger, labels: ["bug"], events: [], comments: [] })).toEqual({
      exitCode: 0,
      stdout: notice("added fleet-sync:public", "posted the comment"),
      stderr: "",
      calls: [...READS, labelAdded, COMMENTS_READ, posted(body)],
    });
    // A reply quoting the note carries the marker mid-text and is not the sticky comment.
    const quoting = { id: 3, body: `> ${MARKER}\n> Added...\n\nWhy?` };
    const steady = {
      files: trigger,
      labels: [PUBLIC],
      events: botAdded,
      comments: [quoting, { id: 5, body }],
    };
    expect(run("steady", steady)).toEqual({
      exitCode: 0,
      stdout: notice("label kept", "the comment is current"),
      stderr: "",
      calls: [...READS, COMMENTS_READ],
    });
  });

  test("a changed path list rewrites the note in place, the listing read across pages", () => {
    const pages = [[file("docs/sync.md"), file("files.yml")], [file("files/base/AGENTS.md")]];
    const stale = { id: 5, body: note("files.yml") };
    expect(
      run("patch", { files: pages, labels: [PUBLIC], events: botAdded, comments: [stale] }),
    ).toEqual({
      exitCode: 0,
      stdout: notice("label kept", "updated the comment"),
      stderr: "",
      calls: [...READS, COMMENTS_READ, patched(5, note(...TWO))],
    });
  });

  test("a rename out of files/ is judged by the path it left", () => {
    const moved = [[file("docs/old.md", "files/base/old.md")]];
    expect(run("rename", { files: moved, labels: [], events: [], comments: [] }).calls).toEqual([
      ...READS,
      labelAdded,
      COMMENTS_READ,
      posted(note("files/base/old.md")),
    ]);
  });

  test("a human's removal is final: the note changes, the label is not re-added", () => {
    const events = [...botAdded, ev("unlabeled", HUMAN, PUBLIC)];
    const existing = [{ id: 5, body: note(...TWO) }];
    expect(run("kept-off", { files: trigger, labels: [], events, comments: existing })).toEqual({
      exitCode: 0,
      stdout: notice("label kept", "updated the comment"),
      stderr: "",
      calls: [
        ...READS,
        COMMENTS_READ,
        patched(5, noteBody(TWO, KNOWN, { kind: "kept-off", by: HUMAN })),
      ],
    });
  });

  test("the bot's label is withdrawn when a human picks all or the paths leave the diff; a closed pull request is left alone", () => {
    const existing = [{ id: 5, body: note(...TWO) }];
    const withdrawn = (reason: string) => ({
      exitCode: 0,
      stdout: notice("removed fleet-sync:public", `removed the comment: ${reason}`),
      stderr: "",
      calls: [...READS, labelRemoved, COMMENTS_READ, deleted(5)],
    });
    const humanAll = [...botAdded, ev("labeled", HUMAN, ALL)];
    expect(
      run("all", { files: trigger, labels: [PUBLIC, ALL], events: humanAll, comments: existing }),
    ).toEqual(withdrawn("fleet-sync:all chosen"));
    expect(
      run("left", { files: workflow, labels: [PUBLIC], events: botAdded, comments: existing }),
    ).toEqual(withdrawn("no path here reaches the fleet through a sync"));
    expect(
      run("closed", {
        files: trigger,
        labels: [PUBLIC],
        events: botAdded,
        comments: existing,
        state: "closed",
      }),
    ).toEqual({
      exitCode: 0,
      stdout: notice("label kept", "comment left as it is (the pull request is closed)"),
      stderr: "",
      calls: READS,
    });
    expect(run("quiet", { files: workflow, labels: [], events: [], comments: [] })).toEqual({
      exitCode: 0,
      stdout: notice(
        "label kept",
        "nothing to say (no path here reaches the fleet through a sync)",
      ),
      stderr: "",
      calls: [...READS, COMMENTS_READ],
    });
  });

  test("a failed read, a refused write, or a capped listing is a warning and exit 0, and nothing is deleted", () => {
    const existing = [{ id: 5, body: note("files.yml") }];
    const fresh = { files: trigger, labels: [], events: [], comments: [] };
    expect(run("down", { ...fresh, stubEnv: { STUB_EXIT: "1" } })).toEqual({
      exitCode: 0,
      stdout: warning(`${PULL}: gh api exit 1`),
      stderr: "",
      calls: [[PULL]],
    });
    expect(run("fork", { ...fresh, stubEnv: { DENY_WRITES: "1" } })).toEqual({
      exitCode: 0,
      stdout: warning(
        `${ISSUE}/labels: gh api exit 1: HTTP 403: Resource not accessible by integration`,
      ),
      stderr: "",
      calls: [...READS, labelAdded],
    });
    // The listing stops at 3,000 files; the omitted ones may be the delivered ones.
    const docsOnly = [[file("docs/sync.md")]];
    expect(
      run("capped", {
        files: docsOnly,
        labels: [PUBLIC],
        events: botAdded,
        comments: existing,
        changedFiles: 3001,
      }),
    ).toEqual({
      exitCode: 0,
      stdout: warning(`${PULL}/files lists 1 of 3001 changed files`),
      stderr: "",
      calls: READS.slice(0, 2),
    });
  });
});
