import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_NAME } from "../../../../actions/shared/platform.ts";
import { checkManifestParity } from "../../../../actions/validate-managed-files/validator/checks/manifest_parity.ts";
import { loadContext } from "../../../../actions/validate-managed-files/validator/context.ts";
import { boundedSpawnSync } from "../../../shared/bounded_spawn.ts";
import { tempDirs } from "../../../shared/temp_dir.ts";
import {
  B,
  BASELINE,
  COMMIT,
  E,
  gitFreeEnv,
  HB,
  HE,
  MANIFEST,
  managedEntry,
  manifestOf,
  regionOf,
  SELF_ENTRY,
  shaLatin1 as sha,
  splitEntry,
  stampedBaseline,
  VALIDATOR,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);

const RESYNC =
  "re-run the sync (dispatch sync-repos.yml in repo-platform with repo=<owner>/<name>), which replaces platform files whole";

describe("the manifest's shape", () => {
  test("a missing manifest is deletion damage", () => {
    const { exitCode, stderr } = runValidator({}, [], { noManifest: true });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST} is missing - every sync writes it`);
  });

  test("an unparsable manifest is its own error", () => {
    const { exitCode, stderr } = runValidator({ [MANIFEST]: "not json\n" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST}: does not parse as a manifest`);
  });

  test("a conflict-marked manifest is the conflict-marker check's report, with no parity double", () => {
    const conflicted = [
      `${"<".repeat(7)} ours`,
      manifestOf(stampedBaseline()),
      "=".repeat(7),
      `${">".repeat(7)} theirs`,
      "",
    ].join("\n");
    const { exitCode, stderr } = runValidator({ [MANIFEST]: conflicted });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${MANIFEST}: carries conflict-marker lines`);
    expect(stderr).not.toContain("does not parse as a manifest");
  });

  test("a manifest that does not list itself is an error", () => {
    const entries = {
      ".github/workflows/ci.yml": managedEntry(BASELINE[".github/workflows/ci.yml"]),
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("does not list itself");
  });

  test("the self entry carries class, hash, and commit alone", () => {
    const entries = {
      ...stampedBaseline(),
      [MANIFEST]: `{"class": "managed", "hash": null, "commit": "${COMMIT}", "kind": "symlink"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr.split("\n").filter((line) => line.startsWith("error:"))).toEqual([
      `error: ${MANIFEST}: entry '${MANIFEST}' carries "kind", which the sync never records on the manifest's own entry; revert the edit (git history has the stamped original) or ${RESYNC}`,
    ]);
  });

  test.each([
    { reason: "a null commit (before the first sync stamps it)", commit: "null", ok: true },
    { reason: "the build's full sha", commit: `"${COMMIT}"`, ok: true },
    { reason: "a short sha", commit: '"abc1234"', ok: false },
    { reason: "a number", commit: "42", ok: false },
    { reason: "uppercase hex", commit: `"${COMMIT.toUpperCase()}"`, ok: false },
  ])("the self entry's commit is null or a full sha: $reason", ({ commit, ok }) => {
    const entries = {
      ...stampedBaseline(),
      [MANIFEST]: `{"class": "managed", "hash": null, "commit": ${commit}}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    if (ok) {
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    } else {
      expect(exitCode).toBe(1);
      expect(stderr).toContain(
        "its self entry's commit must be null or the delivery commit's full 40-hex sha",
      );
    }
  });

  test("an entry field outside the vocabulary is an error naming the entry and the keys", () => {
    const stale = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        ".github/workflows/checks.yml": '{"class": "starter", "withheld": true}',
      }),
    });
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr.split("\n").filter((line) => line.startsWith("error:"))).toEqual([
      `error: ${MANIFEST}: entry '.github/workflows/checks.yml' carries field(s) "withheld" outside the manifest's vocabulary - no sync writes them; revert the edit (git history has the stamped original) or ${RESYNC}`,
    ]);
    const control = runValidator({ [MANIFEST]: manifestOf(stampedBaseline()) });
    expect({ exitCode: control.exitCode, stderr: control.stderr }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  // JSON.parse keeps the LAST binding silently, so a duplicate keeping a
  // second, starter-classed ci.yml line (or a second class field inside
  // the entry) would switch that file's parity off invisibly.
  test.each([
    {
      reason: "two entry lines for one path (the second starter-classed)",
      entryLines: [
        `    ".github/workflows/ci.yml": ${stampedBaseline()[".github/workflows/ci.yml"]}`,
        `    ".github/workflows/ci.yml": {"class": "starter"}`,
      ],
    },
    {
      reason: "a duplicated class field inside one entry object",
      entryLines: [
        `    ".github/workflows/ci.yml": {"class": "managed", "class": "starter", "hash": null}`,
      ],
    },
  ])("a duplicated manifest key is a hard error: $reason", ({ entryLines }) => {
    const text = `{\n  "files": {\n${[
      `    ${JSON.stringify(MANIFEST)}: ${SELF_ENTRY[MANIFEST]}`,
      ...entryLines,
    ].join(",\n")}\n  }\n}\n`;
    const { exitCode, stderr } = runValidator({ [MANIFEST]: text });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("binds a key more than once");
  });

  test("self mode inverts: a present manifest is the error", () => {
    const present = runValidator({ [MANIFEST]: manifestOf(SELF_ENTRY) }, ["--self"]);
    expect(present.exitCode).toBe(1);
    expect(present.stderr).toContain(`${MANIFEST}: exists in the operator repository`);
    const absent = runValidator({}, ["--self"]);
    expect(absent.stderr).toBe("");
    expect(absent.exitCode).toBe(0);
  });
});

describe("byte parity, entry by entry", () => {
  test("a drifted managed entry names the file once", () => {
    const { exitCode, stdout, stderr } = runValidator({
      "docs/pinned.md": "drifted\n",
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        "docs/pinned.md": `{"class": "managed", "hash": "${"d".repeat(64)}"}`,
      }),
    });
    expect(exitCode).toBe(1);
    expect(stderr.split("\n").filter((line) => line.includes("docs/pinned.md"))).toEqual([
      `error: docs/pinned.md: content does not match the sha256 recorded in ${MANIFEST} - the ` +
        "file drifted from the last sync; local edits to a managed file are replaced by the " +
        "next sync (move them to a repo-owned location), and platform-side updates restamp on that sync",
    ]);
    expect(stdout).not.toContain("docs/pinned.md");
  });

  test("a starter entry passes whatever the file holds, and never carries a hash", () => {
    const good = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        ".github/settings.yml": '{"class": "starter"}',
      }),
      ".github/settings.yml": "repository:\n  has_issues: true\n",
    });
    expect(good.stderr).toBe("");
    expect(good.exitCode).toBe(0);
    const hashed = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        ".github/workflows/checks.yml": `{"class": "starter", "hash": "${"a".repeat(64)}"}`,
      }),
    });
    expect(hashed.exitCode).toBe(1);
    expect(hashed.stderr).toContain(
      'carries "hash", which the sync never records on a starter entry',
    );
  });

  test("a mirror entry is verified like a managed file: byte parity, presence", () => {
    const copy = "mirrored license text\n";
    const entries = {
      ...stampedBaseline(),
      "skills/a/LICENSE.md": `{"class": "mirror", "hash": "${sha(copy)}"}`,
    };
    const good = runValidator({ [MANIFEST]: manifestOf(entries), "skills/a/LICENSE.md": copy });
    expect(good.stderr).toBe("");
    expect(good.exitCode).toBe(0);
    const drifted = runValidator({
      [MANIFEST]: manifestOf(entries),
      "skills/a/LICENSE.md": "edited copy\n",
    });
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stderr).toContain("skills/a/LICENSE.md: content does not match the sha256");
    const missing = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("skills/a/LICENSE.md: listed as mirror in");
    expect(missing.stderr).toContain(RESYNC);
  });

  test("a split entry's region is sliced from marker line to marker line, trailing spaces tolerated", () => {
    // Marker LINES match by trimmed equality at every splitter (the writer
    // and this validator's parity slice must agree, or the sync would
    // deliver trees whose stamped region differs from the one parity
    // verifies).
    const content = `above\n${HB} \nroot = true\n${HE}\nrepo tail\n`;
    const region = regionOf(content, HB, HE);
    if (region === null) throw new Error("fixture lost its marker lines");
    const entries = {
      ...stampedBaseline(),
      ".editorconfig":
        `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(HB)}, ` +
        `"end": ${JSON.stringify(HE)}, "hash": "${sha(region)}"}`,
    };
    const { exitCode, stderr } = runValidator({
      ".editorconfig": content,
      [MANIFEST]: manifestOf(entries),
    });
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a split entry whose markers are missing, duplicated, or out of order fails closed", () => {
    const entries = {
      ...SELF_ENTRY,
      "LICENSE.md":
        `{"class": "split", "grammar": "managed-region", "begin": "# no-such-begin", ` +
        `"end": "# no-such-end", "hash": "${"c".repeat(64)}"}`,
    };
    const { exitCode, stderr } = runValidator({ [MANIFEST]: manifestOf(entries) });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("LICENSE.md: the managed-region marker lines ('# no-such-begin'");
    const reordered = runValidator({ ".gitignore": [HE, HB, ""].join("\n") });
    expect(reordered.exitCode).toBe(1);
    expect(reordered.stderr).toContain(".gitignore: the managed-region marker lines");
  });

  test("a symlink's hash covers the link target under the link class; a managed record on a symlink fails by class", () => {
    const build = (claudeEntry: string): string => {
      const root = temp.dir("validate-managed-link-");
      for (const [rel, content] of Object.entries(BASELINE)) {
        mkdirSync(join(root, dirname(rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
      }
      symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
      writeFileSync(join(root, "files.yml"), "");
      writeFileSync(
        join(root, MANIFEST),
        manifestOf({ ...stampedBaseline(), "CLAUDE.md": claudeEntry }),
      );
      return root;
    };
    const dataFile = join(temp.dir("validate-managed-link-data-"), "files.yml");
    writeFileSync(dataFile, "placeholders: []\nmodules: {uv: {}}\nfiles: []\n");
    const linked = build(`{"class": "link", "hash": "${sha("AGENTS.md")}"}`);
    const intact = boundedSpawnSync(
      [process.execPath, VALIDATOR, "--files", dataFile, "--private", "false", linked],
      { env: gitFreeEnv() },
    );
    expect(intact.stderr).toBe("");
    expect(intact.exitCode).toBe(0);
    const managed = build(`{"class": "managed", "hash": "${sha("AGENTS.md")}"}`);
    const byClass = boundedSpawnSync(
      [process.execPath, VALIDATOR, "--files", dataFile, "--private", "false", managed],
      { env: gitFreeEnv() },
    );
    expect(byClass.exitCode).toBe(1);
    expect(byClass.stderr).toContain(
      `CLAUDE.md: recorded as managed in ${MANIFEST} but is a symbolic link`,
    );
    const repointed = build(`{"class": "link", "hash": "${sha("docs/AGENTS.md")}"}`);
    const drifted = boundedSpawnSync(
      [process.execPath, VALIDATOR, "--files", dataFile, "--private", "false", repointed],
      { env: gitFreeEnv() },
    );
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stderr).toContain(
      `CLAUDE.md: its link target does not match the sha256 recorded in ${MANIFEST} - the link ` +
        "drifted from the last sync; local edits to the link are replaced by the next sync",
    );
  });

  test("a link record on a regular file fails parity by class", () => {
    const { exitCode, stderr } = runValidator({
      "CLAUDE.md": "AGENTS.md\n",
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        "CLAUDE.md": `{"class": "link", "hash": "${sha("AGENTS.md\n")}"}`,
      }),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      `CLAUDE.md: recorded as a link in ${MANIFEST} but is not a symbolic link`,
    );
  });

  test("the split entry builder and the validator agree on the baseline", () => {
    expect(stampedBaseline()["AGENTS.md"]).toBe(splitEntry(BASELINE["AGENTS.md"], B, E));
  });
});

describe("the recorded class against files.yml", () => {
  const CI = ".github/workflows/ci.yml";
  const CHECKS = ".github/workflows/checks.yml";
  const classError = (path: string, recorded: string, declared: string) =>
    `error: ${MANIFEST}: entry '${path}' is recorded as ${recorded} but files.yml declares ` +
    `the path ${declared} - the class decides what parity verifies, and the sync records the ` +
    "declared one; revert a hand edit (git history has the stamped original: the sync judges a " +
    "file under a stale class record as an unrecorded file by the declared class and restamps a " +
    "successful outcome; only a write it must hold keeps the old record), merge the pending sync PR " +
    "when the platform changed the path's class since the last sync (a row that PR holds keeps " +
    "the old record until it is resolved), or, when this registration's module change flips it " +
    "(a mirror target a newly selected entry writes, say), land the edit that retires the old " +
    "record first (docs/new-repo.md, PR edits modules)";
  const errors = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("error:"));

  // The starter row is the one that passed before: its branch verifies
  // nothing, so a relabel with the hash dropped switched parity off.
  test.each([
    { recorded: "starter", entry: '{"class": "starter"}' },
    {
      recorded: "split",
      entry:
        '{"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": null}',
    },
    { recorded: "link", entry: '{"class": "link", "hash": null}' },
    { recorded: "mirror", entry: '{"class": "mirror", "hash": null}' },
  ])(
    "a managed path recorded as $recorded is one error, whatever the file holds",
    ({ recorded, entry }) => {
      const { exitCode, stderr } = runValidator({
        [CI]: "name: edited\non: [push]\njobs: {}\n",
        [MANIFEST]: manifestOf({ ...stampedBaseline(), [CI]: entry }),
      });
      expect(exitCode).toBe(1);
      expect(errors(stderr)).toEqual([classError(CI, recorded, "managed")]);
    },
  );

  test("a starter path recorded as managed, with the file's true hash, is the same error", () => {
    const content = "name: checks\n";
    const { exitCode, stderr } = runValidator({
      [CHECKS]: content,
      [MANIFEST]: manifestOf({ ...stampedBaseline(), [CHECKS]: managedEntry(content) }),
    });
    expect(exitCode).toBe(1);
    expect(errors(stderr)).toEqual([classError(CHECKS, "managed", "starter")]);
  });

  test("the declared starter passes whatever it holds; an undeclared path is dispatched as recorded", () => {
    const declared = runValidator({
      [CHECKS]: "name: edited\n",
      [MANIFEST]: manifestOf({ ...stampedBaseline(), [CHECKS]: '{"class": "starter"}' }),
    });
    expect(declared.stderr).toBe("");
    expect(declared.exitCode).toBe(0);
    const copy = "mirrored\n";
    const undeclared = runValidator({
      "docs/copy.md": copy,
      "docs/own.md": "repo-owned\n",
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        "docs/copy.md": `{"class": "mirror", "hash": "${sha(copy)}"}`,
        "docs/own.md": '{"class": "starter"}',
      }),
    });
    expect(undeclared.stderr).toBe("");
    expect(undeclared.exitCode).toBe(0);
  });

  test("an unknown class at a declared path is the unknown-class error alone", () => {
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf({ ...stampedBaseline(), [CI]: '{"class": "bespoke"}' }),
    });
    expect(exitCode).toBe(1);
    expect(errors(stderr)).toEqual([
      `error: ${MANIFEST}: entry '${CI}' has unknown class "bespoke" (expected one of managed, split, starter, mirror, link); re-run the sync to regenerate the manifest`,
    ]);
  });

  // The table holds only the declarations the selection makes live: the
  // writer reserves a path by the same rule, so a mirror it wrote at a
  // deselected path is a record every later sync reproduces.
  const SELECTION_FILES = [
    "placeholders: []",
    "modules: {optional: {}}",
    "files:",
    "  - {path: docs/source.md, class: managed}",
    "  - {path: docs/copy.md, class: managed, when: {modules: [optional]}}",
    "  - {path: docs/either.md, class: managed, when: {modules: [optional]}}",
    "  - {path: docs/either.md, class: starter, when: {without: [optional]}}",
    "  - {path: docs/local.md, class: starter, when: {private: false}}",
    "  - {path: docs/local.md, class: managed, when: {private: true}}",
    "retired: [{path: docs/old.md, moved_to: docs/source.md}]",
    "",
  ].join("\n");
  const MIRRORS = "mirrors: [{source: docs/source.md, targets: [docs/copy.md]}]\n";
  const SHARED = "shared\n";
  const MIRROR = `{"class": "mirror", "hash": "${sha(SHARED)}"}`;
  const STARTER = '{"class": "starter"}';
  test.each<{
    name: string;
    registration: string;
    private?: boolean;
    entries: Record<string, string>;
    expected: string[];
  }>([
    {
      name: "a mirror at a managed path the selection leaves out is dispatched as recorded",
      registration: `modules: []\n${MIRRORS}`,
      entries: { "docs/copy.md": MIRROR },
      expected: [],
    },
    {
      name: "the same mirror at a selected managed path is the class error",
      registration: `modules: [optional]\n${MIRRORS}`,
      entries: { "docs/copy.md": MIRROR },
      expected: [classError("docs/copy.md", "mirror", "managed")],
    },
    {
      name: "the without variant is live: its starter record passes",
      registration: "modules: []\n",
      entries: { "docs/either.md": STARTER },
      expected: [],
    },
    {
      name: "the without variant is live: a managed record with the true hash is the error",
      registration: "modules: []\n",
      entries: { "docs/either.md": managedEntry("either\n") },
      expected: [classError("docs/either.md", "managed", "starter")],
    },
    {
      name: "the modules variant is live: the starter record is the error",
      registration: "modules: [optional]\n",
      entries: { "docs/either.md": STARTER },
      expected: [classError("docs/either.md", "starter", "managed")],
    },
    {
      name: "visibility is one side of the selection: private makes the managed variant live",
      registration: "modules: []\n",
      private: true,
      entries: { "docs/local.md": STARTER },
      expected: [classError("docs/local.md", "starter", "managed")],
    },
    {
      name: "visibility is one side of the selection: public makes the starter variant live",
      registration: "modules: []\n",
      private: false,
      entries: { "docs/local.md": STARTER },
      expected: [],
    },
    {
      name: "a retired path is no declaration: its record is verified as recorded",
      registration: "modules: []\n",
      entries: { "docs/old.md": managedEntry("original\n") },
      expected: [
        `error: docs/old.md: content does not match the sha256 recorded in ${MANIFEST} - the ` +
          "file drifted from the last sync; local edits to a managed file are replaced by the " +
          "next sync (move them to a repo-owned location), and platform-side updates restamp on that sync",
      ],
    },
    {
      name: "a registration without a modules list names no selection, so the classes stand unjudged",
      registration: "modules: {uv: true}\n",
      entries: { "docs/source.md": STARTER },
      expected: [
        "error: .repo-platform.yml: top-level `modules` is missing or not a list (the file may " +
          "have failed to parse); set it to a YAML list of module names, e.g. modules: [uv, release-please]",
      ],
    },
  ])("$name", ({ registration, private: privateRepo, entries, expected }) => {
    const { exitCode, stderr } = runValidator(
      {
        ".repo-platform.yml": registration,
        "docs/source.md": SHARED,
        "docs/copy.md": SHARED,
        "docs/either.md": "either\n",
        "docs/local.md": "local\n",
        "docs/old.md": "moved\n",
        [MANIFEST]: manifestOf({
          ...stampedBaseline(),
          "docs/source.md": managedEntry(SHARED),
          ...entries,
        }),
      },
      [],
      { filesYml: SELECTION_FILES, private: privateRepo },
    );
    expect(errors(stderr)).toEqual(expected);
    expect(exitCode).toBe(expected.length === 0 ? 0 : 1);
  });

  test("a data file without a files list is one error and the classes stand unjudged", () => {
    const { exitCode, stderr } = runValidator(
      { [MANIFEST]: manifestOf({ ...stampedBaseline(), [CI]: '{"class": "starter"}' }) },
      [],
      { filesYml: "placeholders: []\nmodules: {uv: {}}\n" },
    );
    expect(exitCode).toBe(1);
    expect(errors(stderr)).toHaveLength(1);
    expect(errors(stderr)[0]).toContain(
      "the module data file carries no files list - neither the registration's module names nor the manifest's classes can be judged without it",
    );
  });
});

describe("parity messages name what the record and the tree show, never who made it", () => {
  // Each input is one the tool itself produces or cannot tell from a hand edit: the sync carries a hash-null
  // record through every held retirement, and a symlink under a file record (or the reverse) says nothing about
  // who placed it. The validator reads no mirror declaration and no retired list, so one mirror remedy names what
  // the re-run does at every path a record can sit on; every other class holds a wrong-kind occupant, so that
  // occupant must go before a resync can write.
  const REMOVE_THEN_RESYNC = `or remove what stands at the path and ${RESYNC}`;
  const MIRROR_REACHED =
    `${RESYNC} and read its report: a target a declaration reaches is rewritten (unless it already carries the ` +
    "mirror) and restamped";
  const MIRROR_FAILS =
    "; a run the writer cannot finish (a declaration it cannot honour, a directory or a symbolic-link ancestor at " +
    "a path it must probe) fails by name instead";
  const MIRROR_RESYNC =
    `${MIRROR_REACHED}; a record none reaches is dropped, or at a path files.yml retires is retired as the ` +
    "Retirement table in docs/sync.md says (a wrong-kind or hash-null occupant is held as it stands unless a " +
    `moved_to moves it; remove a held occupant, then re-run)${MIRROR_FAILS}`;
  const MIRROR_DIRECTORY_RESYNC =
    `${MIRROR_REACHED}, except under a * in the pattern's last segment, which matches files and links alone and ` +
    "passes a directory by (the run fails when it is the pattern's only match); a record none reaches is " +
    `dropped; a directory at a path files.yml retires fails the run (remove it, then re-run)${MIRROR_FAILS}`;
  const LINK_RECORDED = (noun: string, remedy: string) =>
    `CLAUDE.md: recorded as ${noun} in ${MANIFEST_NAME} but is not a symbolic link - the record (a link ` +
    `target's hash) can verify a link alone; restore the link from git history, ${remedy}`;
  const FILE_RECORDED = (cls: string, remedy: string) =>
    `CLAUDE.md: recorded as ${cls} in ${MANIFEST_NAME} but is a symbolic link - the record (a file's ` +
    `content hash) cannot verify a link, which the sync never reads through; restore the file from git ` +
    `history, ${remedy}`;
  const DIRECTORY = (path: string, restore: "file" | "link", remedy: string) =>
    `${path}: listed in ${MANIFEST_NAME} but is neither a regular file nor a symlink; restore the ${restore} ` +
    `from git history, ${remedy}`;
  test.each([
    {
      reason:
        "a hash-null managed record: a re-run stamps a selected write, retires a retired path as its row says, and holds a stale one",
      files: { "UNHASHED.md": "# unhashed notes\n" },
      links: {},
      entry: ["UNHASHED.md", '{"class": "managed", "hash": null}'],
      message:
        `UNHASHED.md: ${MANIFEST_NAME} records no hash for it (hash null), so there is no recorded write to ` +
        `verify the file against - the sync carries such a record as it found it: ${RESYNC} and read its ` +
        "report (a selected entry's write, when it goes through, stamps the hash; a path files.yml retires gets " +
        "its Retired row; a stale path is held as it stands: delete the file and its manifest entry)",
    },
    {
      reason: "a symbolic link under a managed record",
      files: { "AGENTS.md": "agents\n" },
      links: { "CLAUDE.md": "AGENTS.md" },
      entry: ["CLAUDE.md", `{"class": "managed", "hash": "${sha("AGENTS.md")}"}`],
      message: FILE_RECORDED("managed", REMOVE_THEN_RESYNC),
    },
    {
      reason:
        "a hash-null managed record over a symbolic link: the occupant's kind is judged first",
      files: { "AGENTS.md": "agents\n" },
      links: { "CLAUDE.md": "AGENTS.md" },
      entry: ["CLAUDE.md", '{"class": "managed", "hash": null}'],
      message: FILE_RECORDED("managed", REMOVE_THEN_RESYNC),
    },
    {
      reason:
        "a symbolic link under a copy-mirror record: the mirror writer replaces it at a literal target and a pattern match alike",
      files: { "AGENTS.md": "agents\n" },
      links: { "CLAUDE.md": "AGENTS.md" },
      entry: ["CLAUDE.md", `{"class": "mirror", "hash": "${sha("agents\n")}"}`],
      message: FILE_RECORDED("mirror", `or ${MIRROR_RESYNC}`),
    },
    {
      reason:
        "a directory under a copy-mirror record: written over where a declaration reaches it, passed by under a final *, refused at a retired path",
      files: { "copies/copy.md/keep": "" },
      links: {},
      entry: ["copies/copy.md", `{"class": "mirror", "hash": "${sha("# copy\n")}"}`],
      message: DIRECTORY("copies/copy.md", "file", `or ${MIRROR_DIRECTORY_RESYNC}`),
    },
    {
      reason:
        "a directory under a symlink-mirror record: the same directory remedy, not the not-a-symbolic-link one",
      files: { "copies/copy.md/keep": "" },
      links: {},
      entry: [
        "copies/copy.md",
        `{"class": "mirror", "kind": "symlink", "hash": "${sha("../AGENTS.md")}"}`,
      ],
      message: DIRECTORY("copies/copy.md", "link", `or ${MIRROR_DIRECTORY_RESYNC}`),
    },
    {
      reason:
        "a hash-null copy-mirror record: a re-run restamps a reached target (deleting a pattern's only match would fail it), and a retired path holds or moves it",
      files: { "copies/copy.md": "# copy\n" },
      links: {},
      entry: ["copies/copy.md", '{"class": "mirror", "hash": null}'],
      message:
        `copies/copy.md: ${MANIFEST_NAME} records no hash for it (hash null), so there is no recorded write to ` +
        `verify the file against - ${MIRROR_RESYNC}`,
    },
    {
      reason: "a regular file under a link record",
      files: { "CLAUDE.md": "AGENTS.md" },
      links: {},
      entry: ["CLAUDE.md", `{"class": "link", "hash": "${sha("AGENTS.md")}"}`],
      message: LINK_RECORDED("a link", REMOVE_THEN_RESYNC),
    },
    {
      reason:
        "a directory under a link record: neither a symbolic link nor a regular file, so the directory message",
      files: { "CLAUDE.md/keep": "" },
      links: {},
      entry: ["CLAUDE.md", `{"class": "link", "hash": "${sha("AGENTS.md")}"}`],
      message: DIRECTORY("CLAUDE.md", "link", REMOVE_THEN_RESYNC),
    },
    {
      reason:
        "a regular file under a symlink-mirror record: the mirror writer replaces it at a literal target and a pattern match alike",
      files: { "CLAUDE.md": "AGENTS.md" },
      links: {},
      entry: ["CLAUDE.md", `{"class": "mirror", "kind": "symlink", "hash": "${sha("AGENTS.md")}"}`],
      message: LINK_RECORDED("a symlink mirror", `or ${MIRROR_RESYNC}`),
    },
  ])("$reason", ({ files, links, entry, message }) => {
    const root = temp.dir("manifest-parity-message-");
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    for (const [rel, target] of Object.entries(links)) symlinkSync(target, join(root, rel));
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".repo-platform.yml"), "modules: []\n");
    writeFileSync(join(root, "files.yml"), "modules: {}\nfiles: []\n");
    writeFileSync(join(root, MANIFEST_NAME), manifestOf({ ...SELF_ENTRY, [entry[0]]: entry[1] }));
    const findings = checkManifestParity(
      loadContext(root, join(root, "files.yml"), { mode: "render", private: false }),
    );
    expect(findings).toEqual([{ severity: "error", message }]);
  });
});

describe("checkManifestParity over one tree walking every dispatch branch", () => {
  test("reports exactly these verdicts, in manifest order", () => {
    const root = temp.dir("manifest-parity-");
    const region = `${B}\n# Notes\n${E}\n`;
    const files: Record<string, string> = {
      "docs/intact.md": "managed content\n",
      "docs/drifted.md": "edited content\n",
      "docs/notes.md": `preamble\n${region}tail\n`,
      "docs/broken-region.md": `${B}\n${B}\nno end\n`,
      "docs/unknown-grammar.md": region,
      "docs/unstamped.md": "content\n",
      "docs/starter.md": "repo-owned\n",
      "docs/relabeled.md": "repo-owned now\n",
      "docs/odd.md": "content\n",
      "docs/file-as-link.md": "intact.md",
      "docs/copy-mirror.md": "managed content\n",
      "docs/file-as-mirror-link.md": "../intact.md",
      "docs/kind-on-managed.md": "managed content\n",
      "docs/grammar-on-managed.md": "managed content\n",
      "docs/commit-on-managed.md": "managed content\n",
      "docs/commit-on-mirror.md": "managed content\n",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    symlinkSync("intact.md", join(root, "docs/link.md"));
    symlinkSync("intact.md", join(root, "docs/linked.md"));
    symlinkSync("drifted.md", join(root, "docs/repointed.md"));
    symlinkSync("intact.md", join(root, "docs/mirror-link.md"));
    symlinkSync("drifted.md", join(root, "docs/mirror-link-elsewhere.md"));
    symlinkSync("intact.md", join(root, "docs/link-as-copy-mirror.md"));
    symlinkSync("intact.md", join(root, "docs/mirror-odd-kind.md"));
    mkdirSync(join(root, "docs/dir.md"));
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".repo-platform.yml"), "modules: []\n");
    writeFileSync(
      join(root, "files.yml"),
      "modules: {}\nfiles:\n  - {path: docs/relabeled.md, class: managed}\n",
    );
    const split = (hash: string, grammar = "managed-region") =>
      `{"class": "split", "grammar": ${JSON.stringify(grammar)}, "begin": ${JSON.stringify(B)}, "end": ${JSON.stringify(E)}, "hash": "${hash}"}`;
    const entries: Record<string, string> = {
      [MANIFEST_NAME]: `{"class": "managed", "hash": null, "commit": "${COMMIT}"}`,
      "docs/intact.md": `{"class": "managed", "hash": "${sha("managed content\n")}"}`,
      "docs/drifted.md": `{"class": "managed", "hash": "${sha("original content\n")}"}`,
      "docs/notes.md": split(sha(region)),
      "docs/broken-region.md": split(sha(region)),
      "docs/unknown-grammar.md": split(sha(region), "prefix"),
      "docs/no-grammar.md": `{"class": "split", "begin": "# b", "end": "# e", "hash": "${"d".repeat(64)}"}`,
      "docs/unstamped.md": '{"class": "managed", "hash": null}',
      "docs/starter.md": `{"class": "starter", "hash": "${"a".repeat(64)}"}`,
      "docs/relabeled.md": '{"class": "starter"}',
      "docs/odd.md": '{"class": "bespoke"}',
      "docs/short-hash.md": '{"class": "managed", "hash": "abc"}',
      "docs/link.md": `{"class": "managed", "hash": "${sha("intact.md")}"}`,
      "docs/dir.md": `{"class": "managed", "hash": "${"e".repeat(64)}"}`,
      "docs/deleted.md": `{"class": "managed", "hash": "${"f".repeat(64)}"}`,
      "docs/linked.md": `{"class": "link", "hash": "${sha("intact.md")}"}`,
      "docs/repointed.md": `{"class": "link", "hash": "${sha("intact.md")}"}`,
      "docs/file-as-link.md": `{"class": "link", "hash": "${sha("intact.md")}"}`,
      "docs/link-gone.md": `{"class": "link", "hash": "${sha("intact.md")}"}`,
      "docs/copy-mirror.md": `{"class": "mirror", "hash": "${sha("managed content\n")}"}`,
      "docs/mirror-link.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha("intact.md")}"}`,
      "docs/mirror-link-elsewhere.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha("intact.md")}"}`,
      "docs/file-as-mirror-link.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha("../intact.md")}"}`,
      "docs/link-as-copy-mirror.md": `{"class": "mirror", "hash": "${sha("intact.md")}"}`,
      "docs/mirror-odd-kind.md": `{"class": "mirror", "kind": "hardlink", "hash": "${sha("intact.md")}"}`,
      "docs/kind-on-managed.md": `{"class": "managed", "kind": "symlink", "hash": "${sha("managed content\n")}"}`,
      "docs/grammar-on-managed.md": `{"class": "managed", "grammar": "managed-region", "hash": "${sha("managed content\n")}"}`,
      "docs/commit-on-managed.md": `{"class": "managed", "commit": "${COMMIT}", "hash": "${sha("managed content\n")}"}`,
      "docs/commit-on-mirror.md": `{"class": "mirror", "commit": "${COMMIT}", "hash": "${sha("managed content\n")}"}`,
    };
    writeFileSync(join(root, MANIFEST_NAME), manifestOf(entries));
    const findings = checkManifestParity(
      loadContext(root, join(root, "files.yml"), { mode: "render", private: false }),
    );
    const messages = findings.map((finding) => {
      expect(finding.severity).toBe("error");
      return finding.message.split(" - ")[0].split(";")[0];
    });
    expect(messages).toEqual([
      `docs/drifted.md: content does not match the sha256 recorded in ${MANIFEST_NAME}`,
      `docs/broken-region.md: the managed-region marker lines ('${B}' ... '${E}') recorded in ${MANIFEST_NAME} are missing, duplicated, or out of order in the file, so managed-region parity cannot be verified`,
      `${MANIFEST_NAME}: entry 'docs/unknown-grammar.md' declares split grammar "prefix", which this validator does not read (one grammar exists: managed-region)`,
      `${MANIFEST_NAME}: entry 'docs/no-grammar.md' lacks the split grammar field every sync stamps`,
      `docs/unstamped.md: ${MANIFEST_NAME} records no hash for it (hash null), so there is no recorded write to verify the file against`,
      `${MANIFEST_NAME}: entry 'docs/starter.md' carries "hash", which the sync never records on a starter entry`,
      `${MANIFEST_NAME}: entry 'docs/relabeled.md' is recorded as starter but files.yml declares the path managed`,
      `${MANIFEST_NAME}: entry 'docs/odd.md' has unknown class "bespoke" (expected one of managed, split, starter, mirror, link)`,
      `${MANIFEST_NAME}: entry 'docs/short-hash.md': hash must be null or a lowercase sha256 hex digest`,
      `docs/link.md: recorded as managed in ${MANIFEST_NAME} but is a symbolic link`,
      `docs/dir.md: listed in ${MANIFEST_NAME} but is neither a regular file nor a symlink`,
      `docs/deleted.md: listed as managed in ${MANIFEST_NAME} but missing from the repo`,
      `docs/repointed.md: its link target does not match the sha256 recorded in ${MANIFEST_NAME}`,
      `docs/file-as-link.md: recorded as a link in ${MANIFEST_NAME} but is not a symbolic link`,
      `docs/link-gone.md: listed as link in ${MANIFEST_NAME} but missing from the repo`,
      `docs/mirror-link-elsewhere.md: its link target does not match the sha256 recorded in ${MANIFEST_NAME}`,
      `docs/file-as-mirror-link.md: recorded as a symlink mirror in ${MANIFEST_NAME} but is not a symbolic link`,
      `docs/link-as-copy-mirror.md: recorded as mirror in ${MANIFEST_NAME} but is a symbolic link`,
      `${MANIFEST_NAME}: entry 'docs/mirror-odd-kind.md' carries kind "hardlink"`,
      `${MANIFEST_NAME}: entry 'docs/kind-on-managed.md' carries "kind", which the sync never records on a managed entry`,
      `${MANIFEST_NAME}: entry 'docs/grammar-on-managed.md' carries "grammar", which the sync never records on a managed entry`,
      `${MANIFEST_NAME}: entry 'docs/commit-on-managed.md' carries "commit", which the sync never records on a managed entry`,
      `${MANIFEST_NAME}: entry 'docs/commit-on-mirror.md' carries "commit", which the sync never records on a mirror entry`,
    ]);
    for (const finding of findings) expect(finding.message).not.toContain("template");
  });
});
