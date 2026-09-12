import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MANIFEST_NAME } from "../../../../actions/shared/manifest.ts";
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
  "re-run the sync (dispatch sync-repos.yml in Vivswan/repo-platform with repo=<owner>/<name>), which replaces platform files whole";

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
    expect(stderr).toContain(`${MANIFEST}: contains unresolved merge-conflict markers`);
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
        "its self entry's commit must be null or the build's full 40-hex sha",
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
      `error: ${MANIFEST}: entry '.github/workflows/checks.yml' carries field(s) "withheld" outside the manifest's vocabulary - no sync writes them; the next sync restamps the entry without them, or revert the edit`,
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
    expect(hashed.stderr).toContain("a starter carrying a hash");
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

  test("a symlink's hash covers the link target, under the link class or an older managed record", () => {
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
    for (const cls of ["managed", "link"]) {
      const root = build(`{"class": "${cls}", "hash": "${sha("AGENTS.md")}"}`);
      const result = boundedSpawnSync(
        [process.execPath, VALIDATOR, "--files", dataFile, "--private", "false", root],
        { env: gitFreeEnv() },
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
    }
    const repointed = build(`{"class": "link", "hash": "${sha("docs/AGENTS.md")}"}`);
    const drifted = boundedSpawnSync(
      [process.execPath, VALIDATOR, "--files", dataFile, "--private", "false", repointed],
      { env: gitFreeEnv() },
    );
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stderr).toContain("CLAUDE.md: content does not match the sha256");
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
    "declared one; revert a hand edit (git history has the stamped original: the sync holds a " +
    "drifted file whose record it cannot verify, never restamps it), merge the pending sync PR " +
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
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    symlinkSync("intact.md", join(root, "docs/link.md"));
    symlinkSync("intact.md", join(root, "docs/linked.md"));
    symlinkSync("drifted.md", join(root, "docs/repointed.md"));
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
      `docs/unstamped.md: ${MANIFEST_NAME} records no hash for it (unstamped)`,
      `${MANIFEST_NAME}: entry 'docs/starter.md' is a starter carrying a hash`,
      `${MANIFEST_NAME}: entry 'docs/relabeled.md' is recorded as starter but files.yml declares the path managed`,
      `${MANIFEST_NAME}: entry 'docs/odd.md' has unknown class "bespoke" (expected one of managed, split, starter, mirror, link)`,
      `${MANIFEST_NAME}: entry 'docs/short-hash.md': hash must be null or a lowercase sha256 hex digest`,
      `docs/dir.md: listed in ${MANIFEST_NAME} but is neither a regular file nor a symlink`,
      `docs/deleted.md: listed as managed in ${MANIFEST_NAME} but missing from the repo`,
      `docs/repointed.md: content does not match the sha256 recorded in ${MANIFEST_NAME}`,
      `docs/file-as-link.md: recorded as a link in ${MANIFEST_NAME} but is not a symbolic link`,
      `docs/link-gone.md: listed as link in ${MANIFEST_NAME} but missing from the repo`,
    ]);
    for (const finding of findings) expect(finding.message).not.toContain("template");
  });
});
