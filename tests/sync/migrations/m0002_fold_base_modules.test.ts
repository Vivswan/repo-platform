// m0002: the agents/auto-assign/settings-sync fold - the rung's byte
// splice of .repo-platform.yml's modules list against scratch checkouts
// (the edit left staged for the runner's commit; every byte outside the
// dropped items and their separators kept - the expected strings below are
// whole-file bytes, so spacing, quoting, and line endings are pinned, not
// only the parse), the fold of a repository's own agent-file aliases into
// AGENTS.md and the error arm for its own file at another managed arrival,
// its idempotency, the shapes it
// leaves to module selection, the error arms, and the runner CLI over a
// build history in which the rung appears.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import rung from "../../../.github/scripts/sync/migrations/m0002_fold_base_modules.ts";
import type { Rung } from "../../../.github/scripts/sync/run_migrations.ts";
import {
  MIGRATIONS_NAME,
  MIGRATIONS_REVIEW_NAME,
} from "../../../.github/scripts/sync/section_files.ts";
import { git, ladderFixtures } from "../../shared/migration_fixtures.ts";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const { platform, repo, runLadder } = ladderFixtures(temp);

// The runner's contract, pinned at the type level: the rung file imports
// nothing from the runner, so this is where the two shapes meet.
const typed: Rung = rung;

const SOURCE = readFileSync(
  join(import.meta.dir, "../../../.github/scripts/sync/migrations", `${rung.id}.ts`),
  "utf-8",
);

const REGISTRATION = ".repo-platform.yml";
const apply = (dir: string) => typed.apply({ dir, oldSha: "old", newSha: "new" });

// The shape the template renders: a header comment and a JSON-style flow
// list in copier's choice order.
const RENDERED_HEAD =
  "# Generated once by Vivswan/repo-platform and repo-owned from\n# then on: the sync reads this file, it never rewrites it.\n\n";
const RENDERED = `${RENDERED_HEAD}modules: ["agents", "uv", "release-please", "auto-assign", "settings-sync"]\n`;
const RENDERED_AFTER = `${RENDERED_HEAD}modules: ["uv", "release-please"]\n`;

const NOTE = (dropped: string) =>
  [
    "> [!NOTE]",
    "> MODULE FOLD: `agents`, `auto-assign`, and `settings-sync` are no longer",
    "> modules - every managed repository renders their files unconditionally",
    "> (AGENTS.md and its agent-file symlinks, the Copilot review instructions",
    "> and setup starter, auto-assign.yml, and the settings.yml starter), and",
    "> repository settings are applied centrally for every managed repository",
    "> (no settings-sync.yml workflow is rendered). This update drops the retired",
    "> name(s) from `.repo-platform.yml`'s `modules` list - the rest of the file,",
    "> comments and any `mirrors` declaration included, is untouched - and copier",
    "> records the shorter selection in `.github/.copier-answers.yml`. This rung",
    "> moves or removes no rendered file.",
    `> Dropped here: ${dropped}.`,
  ].join("\n");

const ALIAS_NOTE = [
  "> [!WARNING]",
  "> AGENT FILES FOLDED: this repository carried its own regular file at an",
  "> agent-file alias path that the template now renders as a symlink to",
  "> `AGENTS.md`. Its content was moved verbatim into `AGENTS.md` below the",
  "> managed region, under a heading naming the source path (a final newline",
  "> is added when the file had none), and the alias became the managed",
  "> symlink. Reconcile the moved content into your repository-specific",
  "> section before merging; nothing was deleted.",
].join("\n");

// The ownership manifest every render stamps; a fixture whose files the
// template rendered lists them here, a repository's own files are absent.
const MANIFEST = ".github/repo-platform-manifest.json";
const manifestOf = (...paths: string[]) =>
  JSON.stringify({ files: Object.fromEntries(paths.map((p) => [p, { class: "managed" }])) });

const folded = (alias: string, content: string) =>
  `\n## Folded from ${alias}\n\nThis repository carried its own \`${alias}\` before the agent files became managed symlinks to \`AGENTS.md\`; its content follows verbatim. Reconcile it into the sections above.\n\n${content}`;

describe("m0002_fold_base_modules", () => {
  test.each([
    {
      label: "the rendered flow list, header comment kept",
      before: RENDERED,
      after: RENDERED_AFTER,
      note: "`agents`, `auto-assign`, `settings-sync`",
    },
    {
      label: "a flow list with a trailing comment and mixed quoting",
      before: "modules: ['agents', uv, \"settings-sync\"] # keep me\nmirrors: []\n",
      after: "modules: [uv] # keep me\nmirrors: []\n",
      note: "`agents`, `settings-sync`",
    },
    {
      // The splice keeps the kept items' own spacing and the line's CRLF;
      // a rebuilt line would normalize both.
      label: "a CRLF flow list with irregular spacing: only the items and their separators leave",
      before: "modules: [agents,   uv ,pages,settings-sync]\r\nmirrors: []\r\n",
      after: "modules: [uv ,pages]\r\nmirrors: []\r\n",
      note: "`agents`, `settings-sync`",
    },
    {
      // A folded item between two kept ones: the kept successor keeps the
      // separator to its own predecessor, so the dropped item cannot ride
      // back in with an inter-item slice.
      label: "folded items between kept ones leave with one separator each",
      before: "modules: [uv,  agents, pages , auto-assign,\tnightly]\n",
      after: "modules: [uv, pages,\tnightly]\n",
      note: "`agents`, `auto-assign`",
    },
    {
      // YAML allows a trailing comma; it is not an item (the selector
      // reads the list fine), so the splice keeps it while items remain.
      label: "a trailing comma stays while an item is kept",
      before: "modules: [agents, uv,]\n",
      after: "modules: [uv,]\n",
      note: "`agents`",
    },
    {
      label: "a trailing comma leaves with the last folded item",
      before: "modules: [agents, settings-sync, ]\n",
      after: "modules: []\n",
      note: "`agents`, `settings-sync`",
    },
    {
      label: "a padded flow list keeps its padding",
      before: 'modules: [ "agents" , "uv" ]\n',
      after: 'modules: [ "uv" ]\n',
      note: "`agents`",
    },
    {
      label: "a CRLF block list with item comments keeps every other line byte for byte",
      before:
        "# head\r\nmodules:\r\n  - agents # a\r\n  - uv # keep\r\n  - auto-assign\r\nmirrors: []\r\n",
      after: "# head\r\nmodules:\r\n  - uv # keep\r\nmirrors: []\r\n",
      note: "`agents`, `auto-assign`",
    },
    {
      label: "an emptied CRLF block list keeps the line ending",
      before: "modules:\r\n  - agents\r\nmirrors: []\r\n",
      after: "modules: []\r\nmirrors: []\r\n",
      note: "`agents`",
    },
    {
      label: "a block list with item comments, a comment line, and a mirrors block",
      before:
        "modules:\n  - agents # agent files\n  # the toolchain\n  - uv\n  - settings-sync\nmirrors:\n  - source: LICENSE.md\n    targets: [copies/LICENSE.md]\n",
      after:
        "modules:\n  # the toolchain\n  - uv\nmirrors:\n  - source: LICENSE.md\n    targets: [copies/LICENSE.md]\n",
      note: "`agents`, `settings-sync`",
    },
    {
      label: "a block list of only folded names empties to [] and keeps the key comment",
      before: "modules: # selection\n  - agents\n  - auto-assign\n\n# tail comment\nmirrors: []\n",
      after: "modules: [] # selection\n\n# tail comment\nmirrors: []\n",
      note: "`agents`, `auto-assign`",
    },
    {
      label: "a flow list of only folded names empties to []",
      before: 'modules: ["settings-sync"]\n',
      after: "modules: []\n",
      note: "`settings-sync`",
    },
  ])("dropped: $label", ({ before, after, note }) => {
    const dir = repo({ [REGISTRATION]: before, "README.md": "readme\n" });
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: { kind: "dropped", note: { text: NOTE(note), review: false } },
    });
    expect(readFileSync(join(dir, REGISTRATION), "utf-8")).toBe(after);
    // Staged, not committed: the runner commits as the sync identity.
    expect(git(dir, "status", "--porcelain")).toBe(`M  ${REGISTRATION}\n`);
    expect(git(dir, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  test("idempotent: a second run over the committed rewrite is in-place and stages nothing", () => {
    const dir = repo({ [REGISTRATION]: RENDERED });
    apply(dir);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "dropped");
    expect(apply(dir)).toEqual({ kind: "verdict", verdict: { kind: "in-place", note: null } });
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(dir, REGISTRATION), "utf-8")).toBe(RENDERED_AFTER);
  });

  test.each<{ label: string; files: Record<string, string>; kind: string }>([
    {
      label: "none of the three declared",
      files: { [REGISTRATION]: 'modules: ["uv", "pages"]\n' },
      kind: "in-place",
    },
    {
      label: "no registration file (selection reports the absence)",
      files: { "README.md": "readme\n" },
      kind: "missing",
    },
    {
      label: "a modules value that is not a list (selection reports the shape)",
      files: { [REGISTRATION]: "modules: agents\n" },
      kind: "unreadable",
    },
    {
      label: "a non-string entry (selection reports the shape)",
      files: { [REGISTRATION]: "modules: [agents, 3]\n" },
      kind: "unreadable",
    },
    {
      label: "unparsable YAML (selection reports the parse error)",
      files: { [REGISTRATION]: "modules: [agents\n" },
      kind: "unreadable",
    },
    {
      // Selection refuses a duplicate; rewriting it to [] would launder it.
      label: "a duplicate entry (selection refuses it)",
      files: { [REGISTRATION]: "modules: [agents, agents]\n" },
      kind: "unreadable",
    },
    {
      label: "an empty entry (selection refuses it)",
      files: { [REGISTRATION]: 'modules: [agents, ""]\n' },
      kind: "unreadable",
    },
  ])("nothing to do, nothing touched: $label", ({ files, kind }) => {
    const dir = repo(files);
    const before = git(dir, "ls-files", "-s");
    expect(apply(dir)).toEqual({ kind: "verdict", verdict: { kind, note: null } });
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "ls-files", "-s")).toBe(before);
  });

  // Shapes the line edit refuses rather than guesses at: the file is left
  // byte-identical and the arm tells the human what to do.
  test.each([
    {
      label: "a flow list spanning lines",
      text: 'modules: [\n  "agents",\n  "uv"\n]\n',
    },
    {
      label: "an aliased item",
      text: "agent: &agent agents\nmodules: [*agent, uv, settings-sync]\n",
    },
    {
      label: "a tagged scalar item",
      text: "modules: [!!str agents, uv]\n",
    },
  ])("$label is the hand-edit error arm", ({ text }) => {
    const dir = repo({ [REGISTRATION]: text });
    expect(apply(dir)).toEqual({
      kind: "error",
      message: expect.stringContaining("cannot be rewritten mechanically"),
    });
    expect(readFileSync(join(dir, REGISTRATION), "utf-8")).toBe(text);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  // An own alias file is folded into AGENTS.md and removed, both staged, and
  // the note holds the PR; the declaration part keeps its own kind and note.
  test.each<{
    label: string;
    files: Record<string, string>;
    untracked?: Record<string, string>;
    kind: string;
    noteText: string;
    agents: string;
    status: string;
    again?: string;
  }>([
    {
      label: "no AGENTS.md yet, nothing to drop: AGENTS.md is created from the alias",
      files: {
        [REGISTRATION]: 'modules: ["uv"]\n',
        [MANIFEST]: manifestOf(),
        "CLAUDE.md": "# Ours\n\nours line\n",
      },
      kind: "in-place+aliases",
      noteText: ALIAS_NOTE,
      agents: folded("CLAUDE.md", "# Ours\n\nours line\n"),
      status: "A  AGENTS.md\nD  CLAUDE.md\n",
    },
    {
      label:
        "an existing marked AGENTS.md grows below its END marker; two aliases fold in order; names drop too",
      files: {
        [REGISTRATION]: RENDERED,
        [MANIFEST]: manifestOf("AGENTS.md"),
        "AGENTS.md":
          "<!-- BEGIN REPO-PLATFORM MANAGED -->\nmanaged\n<!-- END REPO-PLATFORM MANAGED -->\n\n## Local\n\nlocal tail\n",
        ".github/agents.md": "agents alias body",
        ".github/copilot-instructions.md": "copilot alias body\n",
      },
      kind: "dropped+aliases",
      noteText: `${NOTE("`agents`, `auto-assign`, `settings-sync`")}\n>\n${ALIAS_NOTE}`,
      agents:
        "<!-- BEGIN REPO-PLATFORM MANAGED -->\nmanaged\n<!-- END REPO-PLATFORM MANAGED -->\n\n## Local\n\nlocal tail\n" +
        folded(".github/agents.md", "agents alias body\n") +
        folded(".github/copilot-instructions.md", "copilot alias body\n"),
      status: `D  .github/agents.md\nD  .github/copilot-instructions.md\nM  ${REGISTRATION}\nM  AGENTS.md\n`,
    },
    {
      // No registration at all: the declaration is `missing` (selection's
      // preflight reports it), the alias is folded all the same.
      label: "no registration, an own alias: missing+aliases",
      files: { [MANIFEST]: manifestOf(), "CLAUDE.md": "ours\n" },
      kind: "missing+aliases",
      noteText: ALIAS_NOTE,
      agents: folded("CLAUDE.md", "ours\n"),
      status: "A  AGENTS.md\nD  CLAUDE.md\n",
      again: "missing",
    },
    {
      // An UNTRACKED alias (never committed): its content folds, and only
      // AGENTS.md is staged - there is no removal to stage.
      label: "an untracked alias folds with only AGENTS.md staged",
      files: { [REGISTRATION]: 'modules: ["uv"]\n', [MANIFEST]: manifestOf() },
      untracked: { "CLAUDE.md": "untracked ours\n" },
      kind: "in-place+aliases",
      noteText: ALIAS_NOTE,
      agents: folded("CLAUDE.md", "untracked ours\n"),
      status: "A  AGENTS.md\n",
    },
  ])("aliases folded: $label", ({ files, kind, noteText, agents, status, again, untracked }) => {
    const dir = repo(files);
    for (const [rel, content] of Object.entries(untracked ?? {})) {
      writeFileSync(join(dir, rel), content);
    }
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: { kind, note: { text: noteText, review: true } },
    });
    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toBe(agents);
    for (const alias of ["CLAUDE.md", ".github/agents.md", ".github/copilot-instructions.md"]) {
      if (alias in files) expect(existsSync(join(dir, alias))).toBe(false);
    }
    expect(git(dir, "status", "--porcelain")).toBe(status);
    // Idempotent: the aliases are gone, so a second run is the declaration's
    // in-place verdict with nothing staged.
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "folded");
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: { kind: again ?? "in-place", note: null },
    });
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("files the template rendered (listed in the manifest) are left to copier: a repo that selected the three", () => {
    // The main harness leg's shape: every arrival and alias exists, all
    // template-rendered; the rung drops the names and folds nothing.
    const rendered = [
      ".github/instructions/review.instructions.md",
      ".github/workflows/auto-assign.yml",
      ".github/workflows/settings-sync.yml",
      "CLAUDE.md",
      ".github/agents.md",
      ".github/copilot-instructions.md",
    ];
    const dir = repo({
      [REGISTRATION]: RENDERED,
      [MANIFEST]: manifestOf("AGENTS.md", ...rendered),
      "AGENTS.md": "managed\n",
      ...Object.fromEntries(rendered.map((rel) => [rel, "rendered\n"])),
    });
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: {
        kind: "dropped",
        note: { text: NOTE("`agents`, `auto-assign`, `settings-sync`"), review: false },
      },
    });
    expect(git(dir, "status", "--porcelain")).toBe(`M  ${REGISTRATION}\n`);
  });

  test("a repository's own settings-sync.yml is not an arrival: the template no longer renders that path", () => {
    // Unlisted in the manifest, so the repository's own; nothing lands or
    // leaves there, and the rung neither refuses nor touches it.
    const ours = "name: ours\n";
    const dir = repo({
      [REGISTRATION]: RENDERED,
      [MANIFEST]: manifestOf(),
      ".github/workflows/settings-sync.yml": ours,
    });
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: {
        kind: "dropped",
        note: { text: NOTE("`agents`, `auto-assign`, `settings-sync`"), review: false },
      },
    });
    expect(readFileSync(join(dir, ".github/workflows/settings-sync.yml"), "utf-8")).toBe(ours);
    expect(git(dir, "status", "--porcelain")).toBe(`M  ${REGISTRATION}\n`);
  });

  test("the registration's bytes outside the spliced items ride verbatim: 0xFF in a comment and in a kept item's comment", () => {
    // A utf-8 read would turn each 0xFF into U+FFFD (EF BF BD) on the write.
    const before = Buffer.concat([
      Buffer.from("# ", "utf-8"),
      Buffer.from([0xff]),
      Buffer.from(" keep\nmodules:\n  - agents\n  - uv # ", "utf-8"),
      Buffer.from([0xff]),
      Buffer.from(" item\n  - settings-sync\nmirrors: []\n", "utf-8"),
    ]);
    const after = Buffer.concat([
      Buffer.from("# ", "utf-8"),
      Buffer.from([0xff]),
      Buffer.from(" keep\nmodules:\n  - uv # ", "utf-8"),
      Buffer.from([0xff]),
      Buffer.from(" item\nmirrors: []\n", "utf-8"),
    ]);
    const dir = repo({ [MANIFEST]: manifestOf() });
    writeFileSync(join(dir, REGISTRATION), before);
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "latin1 registration");
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: {
        kind: "dropped",
        note: { text: NOTE("`agents`, `settings-sync`"), review: false },
      },
    });
    expect(Buffer.compare(readFileSync(join(dir, REGISTRATION)), after)).toBe(0);
    expect(git(dir, "status", "--porcelain")).toBe(`M  ${REGISTRATION}\n`);
  });

  test("repository bytes ride the fold verbatim: a non-UTF-8 byte and no trailing newline", () => {
    // A utf-8 read would turn 0xFF into U+FFFD (EF BF BD) and the write would
    // store that; the fold must carry the repository's exact bytes.
    const dir = repo({ [REGISTRATION]: 'modules: ["uv"]\n', [MANIFEST]: manifestOf() });
    const ours = Buffer.from([0x23, 0x20, 0xff, 0x20, 0x6f, 0x75, 0x72, 0x73]);
    writeFileSync(join(dir, "CLAUDE.md"), ours);
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "latin1 alias");
    expect(apply(dir)).toMatchObject({ kind: "verdict", verdict: { kind: "in-place+aliases" } });
    const agents = readFileSync(join(dir, "AGENTS.md"));
    const heading = Buffer.from(folded("CLAUDE.md", ""), "utf-8");
    // The body rides verbatim: the repository's bytes follow the heading exactly.
    expect(
      Buffer.compare(agents.subarray(heading.length, heading.length + ours.length), ours),
    ).toBe(0);
    // The one addition: a final newline, because the file had none.
    expect(Buffer.compare(agents.subarray(heading.length + ours.length), Buffer.from("\n"))).toBe(
      0,
    );
    expect(Buffer.compare(agents.subarray(0, heading.length), heading)).toBe(0);
  });

  test("the template's own alias symlinks (a repo that selected agents, or a Windows-free render) are left to copier", () => {
    const dir = repo({
      [REGISTRATION]: RENDERED,
      [MANIFEST]: manifestOf(
        "AGENTS.md",
        "CLAUDE.md",
        ".github/agents.md",
        ".github/copilot-instructions.md",
      ),
      "AGENTS.md": "managed\n",
    });
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    symlinkSync("../AGENTS.md", join(dir, ".github/agents.md"));
    symlinkSync("../AGENTS.md", join(dir, ".github/copilot-instructions.md"));
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "template aliases");
    expect(apply(dir)).toEqual({
      kind: "verdict",
      verdict: {
        kind: "dropped",
        note: { text: NOTE("`agents`, `auto-assign`, `settings-sync`"), review: false },
      },
    });
    expect(git(dir, "status", "--porcelain")).toBe(`M  ${REGISTRATION}\n`);
  });

  test.each<{
    label: string;
    files: Record<string, string>;
    link?: [string, string];
    message: string;
  }>([
    {
      label: "its own file at a managed arrival that is not an alias",
      files: {
        [REGISTRATION]: RENDERED,
        [MANIFEST]: manifestOf(),
        ".github/workflows/auto-assign.yml": "name: ours\n",
      },
      message: "carries its own regular file at .github/workflows/auto-assign.yml",
    },
    {
      label: "an alias to fold but AGENTS.md is a directory",
      files: {
        [REGISTRATION]: RENDERED,
        [MANIFEST]: manifestOf(),
        "CLAUDE.md": "ours\n",
        "AGENTS.md/nested": "x\n",
      },
      message: "something other than a regular file at AGENTS.md",
    },
    {
      // Absent or unreadable manifest: whether the template rendered the
      // file cannot be told, and guessing either way risks its content.
      label: "a file at an arrival path with no readable manifest",
      files: { [REGISTRATION]: RENDERED, "CLAUDE.md": "ours\n" },
      message: "repo-platform-manifest.json cannot be read",
    },
    {
      // An alias pointing anywhere but AGENTS.md is not the template's: the
      // sync must neither fold through it nor let copier replace it.
      label: "an alias symlink pointing elsewhere",
      files: {
        [REGISTRATION]: RENDERED,
        [MANIFEST]: manifestOf(),
        "docs/agents.md": "elsewhere\n",
      },
      link: ["docs/agents.md", "CLAUDE.md"],
      message: "something other than a regular file at CLAUDE.md",
    },
    {
      label: "a directory at an alias path",
      files: { [REGISTRATION]: RENDERED, [MANIFEST]: manifestOf(), "CLAUDE.md/nested": "x\n" },
      message: "something other than a regular file at CLAUDE.md",
    },
    {
      label: "a directory at a non-alias arrival",
      files: {
        [REGISTRATION]: RENDERED,
        [MANIFEST]: manifestOf(),
        ".github/workflows/auto-assign.yml/nested": "x\n",
      },
      message: "something other than a regular file at .github/workflows/auto-assign.yml",
    },
    {
      // No alias to fold, yet AGENTS.md itself is not a file: copier would
      // write the managed file over a directory.
      label: "a directory at AGENTS.md with nothing to fold",
      files: { [REGISTRATION]: RENDERED, [MANIFEST]: manifestOf(), "AGENTS.md/nested": "x\n" },
      message: "something other than a regular file at AGENTS.md",
    },
    {
      // Kinds are classified before the manifest is read: with both broken,
      // the AGENTS.md shape is named, not the unreadable manifest.
      label: "a directory AGENTS.md and an unreadable manifest: the shape is named",
      files: {
        [REGISTRATION]: RENDERED,
        [MANIFEST]: "{not json",
        "CLAUDE.md": "ours\n",
        "AGENTS.md/nested": "x\n",
      },
      message: "something other than a regular file at AGENTS.md",
    },
    {
      // lstat follows a symlinked parent, so .github is judged before any
      // path beneath it is probed (m0001 refuses the same shape).
      label: "a symlinked .github",
      files: { [REGISTRATION]: RENDERED, "real-github/keep": "" },
      link: ["real-github", ".github"],
      message: ".github is not a real directory",
    },
  ])("$label is the error arm before anything is staged", ({ files, message, link }) => {
    const dir = repo(files);
    if (link !== undefined) {
      // A linked .github replaces the .github/keep repo() plants.
      if (link[1] === ".github") rmSync(join(dir, ".github"), { recursive: true });
      symlinkSync(link[0], join(dir, link[1]));
      git(dir, "add", "-A");
      git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "linked parent");
    }
    const before = git(dir, "ls-files", "-s");
    expect(apply(dir)).toEqual({ kind: "error", message: expect.stringContaining(message) });
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(git(dir, "ls-files", "-s")).toBe(before);
    expect(readFileSync(join(dir, REGISTRATION), "utf-8")).toBe(RENDERED);
  });

  test("a directory at the registration path is the non-file error arm, not a thrown read", () => {
    const dir = repo({ [`${REGISTRATION}/nested`]: "x\n" });
    expect(apply(dir)).toEqual({
      kind: "error",
      message: expect.stringContaining("not a regular file"),
    });
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("a symlinked registration is the error arm: nothing is written through it", () => {
    const dir = repo({ "real.yml": RENDERED });
    symlinkSync("real.yml", join(dir, REGISTRATION));
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-qm", "symlinked");
    expect(apply(dir)).toEqual({
      kind: "error",
      message: expect.stringContaining("not a regular file"),
    });
    expect(readFileSync(join(dir, "real.yml"), "utf-8")).toBe(RENDERED);
    expect(git(dir, "status", "--porcelain")).toBe("");
  });

  test("an untracked registration cannot be staged: the arm names git's reason", () => {
    const dir = repo({});
    writeFileSync(join(dir, REGISTRATION), RENDERED);
    // The rewrite itself is fine; `git add` of an ignored path fails.
    writeFileSync(join(dir, ".gitignore"), `${REGISTRATION}\n`);
    expect(apply(dir)).toEqual({
      kind: "error",
      message: expect.stringMatching(/^git add \.repo-platform\.yml failed \(exit 1: /),
    });
  });
});

// Through the runner CLI, from a history where the rung appears after the
// recorded build: the rewrite is committed as the sync identity, the note lands
// in the informational report.
describe("m0002 through run_migrations.ts", () => {
  const history = () =>
    platform([
      { tag: "old", rungs: {} },
      { tag: "new", rungs: { [`${rung.id}.ts`]: SOURCE } },
    ]);

  test("pending: the rewrite is committed alone and the note is informational", () => {
    const target = repo({ [REGISTRATION]: RENDERED, "README.md": "readme\n" });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `::notice::Vivswan/demo: migration ${rung.id} -> dropped (committed) (the PR body carries the note)`,
    );
    expect(readFileSync(join(target, REGISTRATION), "utf-8")).toBe(RENDERED_AFTER);
    expect(git(target, "status", "--porcelain")).toBe("");
    expect(git(target, "log", "-1", "--format=%an %s").trim()).toBe(
      `repo-platform-sync chore: run migration ${rung.id}`,
    );
    expect(git(target, "log", "-1", "--name-status", "--format=")).toBe(`M\t${REGISTRATION}\n`);
    expect(readFileSync(join(result.temp, MIGRATIONS_NAME), "utf-8")).toBe(
      `${NOTE("`agents`, `auto-assign`, `settings-sync`")}\n`,
    );
    expect(readFileSync(join(result.temp, MIGRATIONS_REVIEW_NAME), "utf-8")).toBe("");
  });

  test("no usable base still runs the rung; a crossed target reports in-place without a commit", () => {
    const target = repo({ [REGISTRATION]: RENDERED });
    const first = runLadder(history(), target, "");
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("no usable base");
    expect(first.stdout).toContain(`migration ${rung.id} -> dropped (committed)`);
    const again = runLadder(history(), target, "");
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain(`migration ${rung.id} -> in-place`);
    expect(again.stdout).not.toContain("(committed)");
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("2");
    expect(readFileSync(join(target, REGISTRATION), "utf-8")).toBe(RENDERED_AFTER);
  });

  test("an alias fold lands in the review report and holds the PR", () => {
    const target = repo({
      [REGISTRATION]: 'modules: ["uv"]\n',
      [MANIFEST]: manifestOf(),
      "CLAUDE.md": "ours\n",
    });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      `::notice::Vivswan/demo: migration ${rung.id} -> in-place+aliases (committed) (the PR body carries the note)`,
    );
    expect(git(target, "log", "-1", "--name-status", "--format=")).toBe(
      "A\tAGENTS.md\nD\tCLAUDE.md\n",
    );
    expect(readFileSync(join(result.temp, MIGRATIONS_REVIEW_NAME), "utf-8")).toBe(
      `${ALIAS_NOTE}\n`,
    );
    expect(readFileSync(join(result.temp, MIGRATIONS_NAME), "utf-8")).toBe("");
  });

  test("the error arm fails the step with ::error:: on stdout and writes nothing", () => {
    const text = 'modules: [\n  "agents",\n  "uv"\n]\n';
    const target = repo({ [REGISTRATION]: text });
    const result = runLadder(history(), target, "old");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain(
      `::error::Vivswan/demo: migration ${rung.id}: ${REGISTRATION}'s modules list cannot be rewritten mechanically`,
    );
    expect(readFileSync(join(target, REGISTRATION), "utf-8")).toBe(text);
    expect(git(target, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });
});
