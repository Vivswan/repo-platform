// The manifest's guarantee is visibility: every class dispatch, every remedy the fleet reads, judged over trees the
// validator is run against. A state that produced no finding would pass a repository with zero parity checks.

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
  stampedBaseline,
  VALIDATOR,
  validatorRunner,
} from "./fixtures";

const temp = tempDirs();
const runValidator = validatorRunner(temp);
const errors = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("error:"));

const RESYNC =
  "re-run the sync (dispatch sync-repos.yml in repo-platform with repo=<owner>/<name>), which replaces platform files whole";
const REPAIR =
  "the sync refuses a record it cannot read, so revert the entry (git history has the stamped original)";
const REVERT_OR_RESYNC = `revert the edit (git history has the stamped original) or ${RESYNC}`;
const DRIFTED = (path: string) =>
  `error: ${path}: content does not match the sha256 recorded in ${MANIFEST} - the ` +
  "file drifted from the last sync; local edits to a managed file are replaced by the " +
  "next sync (move them to a repo-owned location), and platform-side updates restamp on that sync";

describe("the manifest's state", () => {
  // Each state is one the tool meets in the fleet (a deleted manifest, a hand edit, a merge that kept both bindings),
  // and each must be its own finding: JSON.parse would take the last of two bindings and switch a path's parity off.
  const CI = ".github/workflows/ci.yml";
  const MISSING = `error: ${MANIFEST} is missing - every sync writes it, so this is deletion or damage; restore it from git history or ${RESYNC}`;
  // The operator's own checkout (--self) differs in the walk alone: the shape and parity checks judge it like any target.
  test.each<{
    reason: string;
    text: string | null;
    files?: Record<string, string>;
    self?: true;
    expected: string[];
  }>([
    { reason: "missing: deletion damage", text: null, expected: [MISSING] },
    { reason: "missing under --self", text: null, self: true, expected: [MISSING] },
    {
      reason: "a drifted managed file under --self",
      text: manifestOf(stampedBaseline()),
      files: { [CI]: "name: edited\n" },
      self: true,
      expected: [DRIFTED(CI)],
    },
    {
      reason: "not JSON",
      text: "not json\n",
      expected: [
        `error: ${MANIFEST}: does not parse as a manifest (invalid JSON) - the file is managed; ${REVERT_OR_RESYNC}`,
      ],
    },
    {
      reason: "two entry lines for one path, the second starter-classed",
      text: `{\n  "files": {\n${[
        `    ${JSON.stringify(MANIFEST)}: ${SELF_ENTRY[MANIFEST]}`,
        `    ${JSON.stringify(CI)}: ${stampedBaseline()[CI]}`,
        `    ${JSON.stringify(CI)}: {"class": "starter"}`,
      ].join(",\n")}\n  }\n}\n`,
      expected: [
        `error: ${MANIFEST}: binds a key more than once (JSON consumers silently keep the last value, so a duplicate - an entry path or a field inside one - silently changes what the manifest declares) - the file is managed; ${REVERT_OR_RESYNC}`,
      ],
    },
    {
      reason: "two class fields inside one entry, the second a starter",
      text: `{\n  "files": {\n${[
        `    ${JSON.stringify(MANIFEST)}: ${SELF_ENTRY[MANIFEST]}`,
        `    ${JSON.stringify(CI)}: {"class": "mirror", "class": "starter"}`,
      ].join(",\n")}\n  }\n}\n`,
      expected: [
        `error: ${MANIFEST}: binds a key more than once (JSON consumers silently keep the last value, so a duplicate - an entry path or a field inside one - silently changes what the manifest declares) - the file is managed; ${REVERT_OR_RESYNC}`,
      ],
    },
    {
      reason: "does not list itself",
      text: manifestOf({ [CI]: managedEntry(BASELINE[CI]) }),
      expected: [
        `error: ${MANIFEST}: does not list itself - the manifest is a managed file like any other; ${RESYNC}`,
      ],
    },
  ])("$reason", ({ text, files, self, expected }) => {
    const args = self ? ["--self"] : [];
    const { exitCode, stderr } =
      text === null
        ? runValidator(files ?? {}, args, { noManifest: true })
        : runValidator({ ...files, [MANIFEST]: text }, args);
    expect([exitCode, errors(stderr)]).toEqual([1, expected]);
  });

  // RECORD_FIELDS and ENTRY_FIELDS are the writer's tables too: a record the validator passes and the writer refuses
  // fails the next sync on a repository the check called green. The self entry is the exception to both tables (managed,
  // hash null, the commit): its content holds every other hash, and a resync rewrites it without reading it.
  const SELF_MUST =
    `error: ${MANIFEST}: entry '${MANIFEST}' must be managed with hash null (its content includes ` +
    "every other hash, so a self-hash would be circular); re-run the sync to regenerate it";
  test.each<{ reason: string; entries: Record<string, string>; expected: string[] }>([
    {
      reason: "a stranger on a starter entry",
      entries: { ".github/workflows/checks.yml": '{"class": "starter", "withheld": true}' },
      expected: [
        `error: ${MANIFEST}: entry '.github/workflows/checks.yml' carries field(s) "withheld" outside the manifest's vocabulary - no sync writes them; ${REPAIR}`,
      ],
    },
    {
      reason:
        "a stranger on a missing file: the writer refuses the whole record, so no parity remedy of its own",
      entries: {
        "docs/gone.md": `{"class": "managed", "hash": "${sha("gone\n")}", "withheld": true}`,
      },
      expected: [
        `error: ${MANIFEST}: entry 'docs/gone.md' carries field(s) "withheld" outside the manifest's vocabulary - no sync writes them; ${REPAIR}`,
      ],
    },
    {
      reason: "a stranger on the self entry: a resync heals it",
      entries: { [MANIFEST]: '{"class": "managed", "hash": null, "withheld": true}' },
      expected: [
        `error: ${MANIFEST}: entry '${MANIFEST}' carries field(s) "withheld" outside the manifest's vocabulary - no sync writes them; ${REVERT_OR_RESYNC}`,
      ],
    },
    {
      reason: "a vocabulary field the self entry never carries",
      entries: { [MANIFEST]: '{"class": "managed", "hash": null, "kind": "symlink"}' },
      expected: [
        `error: ${MANIFEST}: entry '${MANIFEST}' carries "kind", which the sync never records on the manifest's own entry; ${REVERT_OR_RESYNC}`,
      ],
    },
    {
      reason: "the self entry stamped with the delivery commit",
      entries: {
        [MANIFEST]:
          '{"class": "managed", "hash": null, "commit": "a3f9c2e17b4d6c8f0a2e4b6d8c0f1a3b5d7e9f01"}',
      },
      expected: [],
    },
    {
      reason: "the commit on a managed record, a field its class does not carry",
      entries: {
        "docs/pinned.md": `{"class": "managed", "hash": "${"d".repeat(64)}", "commit": "a3f9c2e17b4d6c8f0a2e4b6d8c0f1a3b5d7e9f01"}`,
      },
      expected: [
        `error: ${MANIFEST}: entry 'docs/pinned.md' carries "commit", which the sync never records on a managed entry; ${REPAIR}`,
      ],
    },
    {
      reason:
        "the self entry relabeled a starter: parity off for the one file every other hash depends on",
      entries: { [MANIFEST]: '{"class": "starter", "hash": null}' },
      expected: [SELF_MUST],
    },
    {
      reason: "the self entry carrying a real hash: circular",
      entries: { [MANIFEST]: `{"class": "managed", "hash": "${"a".repeat(64)}"}` },
      expected: [SELF_MUST],
    },
    { reason: "the stamped baseline (control)", entries: {}, expected: [] },
  ])("the vocabulary: $reason", ({ entries, expected }) => {
    const { exitCode, stderr } = runValidator({
      [MANIFEST]: manifestOf({ ...stampedBaseline(), ...entries }),
    });
    expect([exitCode, errors(stderr)]).toEqual([expected.length === 0 ? 0 : 1, expected]);
  });
});

describe("byte parity, entry by entry", () => {
  // The core verdict per class. A split region is sliced marker LINE to marker line by trimmed equality at every
  // splitter (the writer and this validator share grammar.ts cleanManagedRegion), so trailing spaces on a marker line
  // are the fleet's, not a drift.
  const spaced = `above\n${HB} \nroot = true\n${HE}\nrepo tail\n`;
  const spacedRegion = regionOf(spaced, HB, HE);
  if (spacedRegion === null) throw new Error("fixture lost its marker lines");
  const copy = "mirrored license text\n";
  const MIRROR = `{"class": "mirror", "hash": "${sha(copy)}"}`;
  test.each<{
    reason: string;
    files: Record<string, string>;
    entries: Record<string, string>;
    expected: string[];
  }>([
    {
      reason: "a drifted managed entry names the file once",
      files: { "docs/pinned.md": "drifted\n" },
      entries: { "docs/pinned.md": `{"class": "managed", "hash": "${"d".repeat(64)}"}` },
      expected: [DRIFTED("docs/pinned.md")],
    },
    {
      reason: "a mirror in place passes",
      files: { "skills/a/LICENSE.md": copy },
      entries: { "skills/a/LICENSE.md": MIRROR },
      expected: [],
    },
    {
      reason: "a drifted mirror is verified like a managed file",
      files: { "skills/a/LICENSE.md": "edited copy\n" },
      entries: { "skills/a/LICENSE.md": MIRROR },
      expected: [DRIFTED("skills/a/LICENSE.md")],
    },
    {
      reason: "a missing mirror names the class and the resync",
      files: {},
      entries: { "skills/a/LICENSE.md": MIRROR },
      expected: [
        `error: skills/a/LICENSE.md: listed as mirror in ${MANIFEST} but missing from the repo - a managed file deleted outside a sync; restore it from git history or ${RESYNC}`,
      ],
    },
    {
      reason: "a split region with a trailing space on its marker line passes",
      files: { ".editorconfig": spaced },
      entries: {
        ".editorconfig":
          `{"class": "split", "grammar": "managed-region", "begin": ${JSON.stringify(HB)}, ` +
          `"end": ${JSON.stringify(HE)}, "hash": "${sha(spacedRegion)}"}`,
      },
      expected: [],
    },
  ])("$reason", ({ files, entries, expected }) => {
    const { exitCode, stdout, stderr } = runValidator({
      ...files,
      [MANIFEST]: manifestOf({ ...stampedBaseline(), ...entries }),
    });
    expect([exitCode, errors(stderr)]).toEqual([expected.length === 0 ? 0 : 1, expected]);
    for (const path of Object.keys(entries)) expect(stdout).not.toContain(path);
  });

  // A starter's branch verifies nothing, so the declared starter passes whatever it holds; a hash on one is a hand edit
  // (a relabel to starter is the class check's, below).
  test("a starter entry passes whatever the file holds, and never carries a hash", () => {
    const good = runValidator({
      ".github/workflows/checks.yml": "name: edited\n",
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        ".github/workflows/checks.yml": '{"class": "starter"}',
      }),
    });
    expect([good.exitCode, good.stderr]).toEqual([0, ""]);
    const hashed = runValidator({
      [MANIFEST]: manifestOf({
        ...stampedBaseline(),
        ".github/workflows/checks.yml": `{"class": "starter", "hash": "${"a".repeat(64)}"}`,
      }),
    });
    expect([hashed.exitCode, errors(hashed.stderr)]).toEqual([
      1,
      [
        `error: ${MANIFEST}: entry '.github/workflows/checks.yml' carries "hash", which the sync never records on a starter entry; ${REPAIR}`,
      ],
    ]);
  });

  // A null slice that passed would let a corrupted record reclassifying a file as split exempt it silently.
  test("a split entry whose markers are missing, duplicated, or out of order fails closed", () => {
    const markers = (path: string, begin: string, end: string) =>
      `error: ${path}: the managed-region marker lines ('${begin}' ... '${end}') recorded in ${MANIFEST} are missing, duplicated, or out of order in the file, so managed-region parity cannot be verified - restore the single marker pair or re-run the sync`;
    const missing = runValidator({
      [MANIFEST]: manifestOf({
        ...SELF_ENTRY,
        "LICENSE.md":
          `{"class": "split", "grammar": "managed-region", "begin": "# no-such-begin", ` +
          `"end": "# no-such-end", "hash": "${"c".repeat(64)}"}`,
      }),
    });
    expect([missing.exitCode, errors(missing.stderr)]).toEqual([
      1,
      [markers("LICENSE.md", "# no-such-begin", "# no-such-end")],
    ]);
    const reordered = runValidator({ ".gitignore": [HE, HB, ""].join("\n") });
    expect([reordered.exitCode, errors(reordered.stderr)]).toEqual([
      1,
      [markers(".gitignore", HB, HE)],
    ]);
  });

  // The record is the sha of the link target text, so a validator reading through the link would hash the target
  // file's content and report an intact link as drift; the occupant-kind rule is the one the writer's kind-change hold
  // relies on.
  test("a symlink's hash covers the link target under a symlink mirror record; a managed record on a symlink fails by class", () => {
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
    const judge = (entry: string) => {
      const run = boundedSpawnSync(
        [process.execPath, VALIDATOR, "--files", dataFile, "--private", "false", build(entry)],
        { env: gitFreeEnv() },
      );
      return [run.exitCode, errors(run.stderr)];
    };
    expect(judge(`{"class": "mirror", "kind": "symlink", "hash": "${sha("AGENTS.md")}"}`)).toEqual([
      0,
      [],
    ]);
    expect(judge(`{"class": "managed", "hash": "${sha("AGENTS.md")}"}`)).toEqual([
      1,
      [
        `error: CLAUDE.md: recorded as managed in ${MANIFEST} but is a symbolic link - the record (a file's content hash) cannot verify a link, which the sync never reads through; ` +
          `restore the file from git history, or remove what stands at the path and ${RESYNC}`,
      ],
    ]);
    expect(
      judge(`{"class": "mirror", "kind": "symlink", "hash": "${sha("docs/AGENTS.md")}"}`),
    ).toEqual([
      1,
      [
        `error: CLAUDE.md: its link target does not match the sha256 recorded in ${MANIFEST} - the link drifted from the last sync; ` +
          "local edits to the link are replaced by the next sync (move them to a repo-owned location), and platform-side updates restamp on that sync",
      ],
    ]);
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

  // The starter row is the one that passed before: its branch verifies nothing, so a relabel switched parity off.
  // Every record here is readable (a starter, or a stamped hash) so the class verdict, not the readability refusal,
  // is what the row exercises; the managed-at-a-starter row carries the file's true hash for the same reason.
  const checks = "name: checks\n";
  test.each<{ path: string; file: string; recorded: string; declared: string; entry: string }>([
    {
      path: CI,
      file: "name: edited\n",
      recorded: "starter",
      declared: "managed",
      entry: '{"class": "starter"}',
    },
    {
      path: CI,
      file: "name: edited\n",
      recorded: "split",
      declared: "managed",
      entry: `{"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": "${sha("other\n")}"}`,
    },
    {
      path: CI,
      file: "name: edited\n",
      recorded: "mirror",
      declared: "managed",
      entry: `{"class": "mirror", "hash": "${sha("other\n")}"}`,
    },
    {
      path: CHECKS,
      file: checks,
      recorded: "managed",
      declared: "starter",
      entry: managedEntry(checks),
    },
  ])(
    "a $declared path recorded as $recorded is one error, whatever the file holds",
    ({ path, file, recorded, declared, entry }) => {
      const { exitCode, stderr } = runValidator({
        [path]: file,
        [MANIFEST]: manifestOf({ ...stampedBaseline(), [path]: entry }),
      });
      expect([exitCode, errors(stderr)]).toEqual([1, [classError(path, recorded, declared)]]);
    },
  );

  // The table holds only the declarations the selection makes live: the writer reserves a path by the same rule, so a
  // mirror it wrote at a deselected path is a record every later sync reproduces, and a path no declaration covers is
  // verified as recorded.
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
      name: "a path no declaration covers: its record is verified as recorded",
      registration: "modules: []\n",
      entries: { "docs/old.md": managedEntry("original\n") },
      expected: [DRIFTED("docs/old.md")],
    },
    {
      name: "an excepted path is dispatched as recorded: the registration keeps it as the repository's own",
      registration: "modules: []\nexcept: [docs/source.md]\n",
      entries: { "docs/source.md": STARTER },
      expected: [],
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
    expect([exitCode, errors(stderr)]).toEqual([expected.length === 0 ? 0 : 1, expected]);
  });
});

describe("checkManifestParity over one tree walking every dispatch branch", () => {
  // The census, in manifest order. A message names what the record and the tree show, never who made it: a symlink
  // under a file record (or the reverse) says nothing about who placed it. The validator reads no mirror declaration,
  // so one mirror remedy names what the re-run does at every path a record can sit on; every other class holds a
  // wrong-kind occupant, so that occupant must go before a resync can write. A hash-null record is no record at all:
  // refused before the occupant is looked at. Those remedies are asserted whole; the rest by their first clause.
  const REMOVE_THEN_RESYNC = `or remove what stands at the path and ${RESYNC}`;
  const MIRROR_REACHED =
    `${RESYNC} and read its report: a target a declaration reaches is rewritten (unless it already carries the ` +
    "mirror) and restamped";
  const MIRROR_FAILS =
    "; a run the writer cannot finish (a declaration it cannot honour, a directory or a symbolic-link ancestor at " +
    "a path it must probe) fails by name instead";
  const MIRROR_RESYNC = `${MIRROR_REACHED}; a record none reaches is dropped${MIRROR_FAILS}`;
  const MIRROR_DIRECTORY_RESYNC =
    `${MIRROR_REACHED}, except under a * in the pattern's last segment, which matches files and links alone and ` +
    `passes a directory by (the run fails when it is the pattern's only match); a record none reaches is dropped${MIRROR_FAILS}`;
  const HASH_REFUSED = (path: string) =>
    `${MANIFEST_NAME}: entry '${path}': hash must be a lowercase sha256 hex digest; ${REPAIR}`;
  const FILE_RECORDED = (path: string, cls: string, remedy: string) =>
    `${path}: recorded as ${cls} in ${MANIFEST_NAME} but is a symbolic link - the record (a file's ` +
    `content hash) cannot verify a link, which the sync never reads through; restore the file from git ` +
    `history, ${remedy}`;
  const DIRECTORY = (path: string, restore: "file" | "link", remedy: string) =>
    `${path}: listed in ${MANIFEST_NAME} but is neither a regular file nor a symlink; restore the ${restore} ` +
    `from git history, ${remedy}`;
  const WHOLE = new Set([
    "docs/odd.md",
    "docs/unstamped-link.md",
    "docs/link.md",
    "docs/link-as-copy-mirror.md",
    "docs/dir-as-copy-mirror.md",
    "docs/dir-as-mirror-link.md",
    "docs/file-as-mirror-link.md",
  ]);
  const subject = (message: string): string =>
    /^(?:[^:]+: entry '([^']+)'|([^:]+):)/.exec(message)?.[1] ??
    /^([^:]+):/.exec(message)?.[1] ??
    "";
  const head = (message: string) => message.split(" - ")[0].split(";")[0];

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
      "docs/unstamped-mirror.md": "managed content\n",
      "docs/starter.md": "repo-owned\n",
      "docs/relabeled.md": "repo-owned now\n",
      "docs/odd.md": "content\n",
      "docs/copy-mirror.md": "managed content\n",
      "docs/file-as-mirror-link.md": "../intact.md",
      "docs/kind-on-managed.md": "managed content\n",
      "docs/grammar-on-managed.md": "managed content\n",
      "docs/dir-as-copy-mirror.md/keep": "",
      "docs/dir-as-mirror-link.md/keep": "",
    };
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    symlinkSync("intact.md", join(root, "docs/link.md"));
    symlinkSync("intact.md", join(root, "docs/unstamped-link.md"));
    symlinkSync("intact.md", join(root, "docs/mirror-link.md"));
    symlinkSync("drifted.md", join(root, "docs/mirror-link-elsewhere.md"));
    symlinkSync("intact.md", join(root, "docs/link-as-copy-mirror.md"));
    symlinkSync("intact.md", join(root, "docs/mirror-odd-kind.md"));
    mkdirSync(join(root, "docs/dir.md"));
    mkdirSync(join(root, ".github"));
    writeFileSync(join(root, ".repo-platform.yml"), "modules: []\n");
    // docs/odd.md is declared, so the unknown-class verdict is proven to stand alone: the class-vs-declared check
    // never reaches a record it cannot read.
    writeFileSync(
      join(root, "files.yml"),
      "placeholders: []\nmodules: {}\nfiles:\n  - {path: docs/relabeled.md, class: managed}\n  - {path: docs/odd.md, class: managed}\n",
    );
    const split = (hash: string, grammar = "managed-region") =>
      `{"class": "split", "grammar": ${JSON.stringify(grammar)}, "begin": ${JSON.stringify(B)}, "end": ${JSON.stringify(E)}, "hash": "${hash}"}`;
    const entries: Record<string, string> = {
      [MANIFEST_NAME]: '{"class": "managed", "hash": null}',
      "docs/intact.md": `{"class": "managed", "hash": "${sha("managed content\n")}"}`,
      "docs/drifted.md": `{"class": "managed", "hash": "${sha("original content\n")}"}`,
      "docs/notes.md": split(sha(region)),
      "docs/broken-region.md": split(sha(region)),
      "docs/unknown-grammar.md": split(sha(region), "prefix"),
      "docs/no-grammar.md": `{"class": "split", "begin": "# b", "end": "# e", "hash": "${"d".repeat(64)}"}`,
      "docs/unstamped.md": '{"class": "managed", "hash": null}',
      "docs/unstamped-link.md": '{"class": "managed", "hash": null}',
      "docs/unstamped-mirror.md": '{"class": "mirror", "hash": null}',
      "docs/starter.md": `{"class": "starter", "hash": "${"a".repeat(64)}"}`,
      "docs/relabeled.md": '{"class": "starter"}',
      "docs/odd.md": '{"class": "bespoke"}',
      "docs/short-hash.md": '{"class": "managed", "hash": "abc"}',
      "docs/link.md": `{"class": "managed", "hash": "${sha("intact.md")}"}`,
      "docs/dir.md": `{"class": "managed", "hash": "${"e".repeat(64)}"}`,
      "docs/deleted.md": `{"class": "managed", "hash": "${"f".repeat(64)}"}`,
      "docs/link-record.md": `{"class": "link", "hash": "${sha("intact.md")}"}`,
      "docs/copy-mirror.md": `{"class": "mirror", "hash": "${sha("managed content\n")}"}`,
      "docs/mirror-link.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha("intact.md")}"}`,
      "docs/mirror-link-elsewhere.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha("intact.md")}"}`,
      "docs/file-as-mirror-link.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha("../intact.md")}"}`,
      "docs/link-as-copy-mirror.md": `{"class": "mirror", "hash": "${sha("intact.md")}"}`,
      "docs/dir-as-copy-mirror.md": `{"class": "mirror", "hash": "${sha("# copy\n")}"}`,
      "docs/dir-as-mirror-link.md": `{"class": "mirror", "kind": "symlink", "hash": "${sha("../intact.md")}"}`,
      "docs/mirror-odd-kind.md": `{"class": "mirror", "kind": "hardlink", "hash": "${sha("intact.md")}"}`,
      "docs/kind-on-managed.md": `{"class": "managed", "kind": "symlink", "hash": "${sha("managed content\n")}"}`,
      "docs/grammar-on-managed.md": `{"class": "managed", "grammar": "managed-region", "hash": "${sha("managed content\n")}"}`,
    };
    writeFileSync(join(root, MANIFEST_NAME), manifestOf(entries));
    const findings = checkManifestParity(
      loadContext(root, join(root, "files.yml"), { self: false, private: false }),
    );
    const messages = findings.map((finding) =>
      WHOLE.has(subject(finding.message)) ? finding.message : head(finding.message),
    );
    expect(messages).toEqual([
      `docs/drifted.md: content does not match the sha256 recorded in ${MANIFEST_NAME}`,
      `docs/broken-region.md: the managed-region marker lines ('${B}' ... '${E}') recorded in ${MANIFEST_NAME} are missing, duplicated, or out of order in the file, so managed-region parity cannot be verified`,
      `${MANIFEST_NAME}: entry 'docs/unknown-grammar.md' declares split grammar "prefix", which this validator does not read (one grammar exists: managed-region)`,
      `${MANIFEST_NAME}: entry 'docs/no-grammar.md' lacks the split grammar field every sync stamps`,
      `${MANIFEST_NAME}: entry 'docs/unstamped.md': hash must be a lowercase sha256 hex digest`,
      HASH_REFUSED("docs/unstamped-link.md"),
      `${MANIFEST_NAME}: entry 'docs/unstamped-mirror.md': hash must be a lowercase sha256 hex digest`,
      `${MANIFEST_NAME}: entry 'docs/starter.md' carries "hash", which the sync never records on a starter entry`,
      `${MANIFEST_NAME}: entry 'docs/relabeled.md' is recorded as starter but files.yml declares the path managed`,
      `${MANIFEST_NAME}: entry 'docs/odd.md' has unknown class "bespoke" (expected one of managed, split, starter, mirror); ${REPAIR}`,
      `${MANIFEST_NAME}: entry 'docs/short-hash.md': hash must be a lowercase sha256 hex digest`,
      FILE_RECORDED("docs/link.md", "managed", REMOVE_THEN_RESYNC),
      `docs/dir.md: listed in ${MANIFEST_NAME} but is neither a regular file nor a symlink`,
      `docs/deleted.md: listed as managed in ${MANIFEST_NAME} but missing from the repo`,
      `${MANIFEST_NAME}: entry 'docs/link-record.md' has unknown class "link" (expected one of managed, split, starter, mirror)`,
      `docs/mirror-link-elsewhere.md: its link target does not match the sha256 recorded in ${MANIFEST_NAME}`,
      `docs/file-as-mirror-link.md: recorded as a symlink mirror in ${MANIFEST_NAME} but is not a symbolic link - the record (a link target's hash) can verify a link alone; restore the link from git history, or ${MIRROR_RESYNC}`,
      FILE_RECORDED("docs/link-as-copy-mirror.md", "mirror", `or ${MIRROR_RESYNC}`),
      DIRECTORY("docs/dir-as-copy-mirror.md", "file", `or ${MIRROR_DIRECTORY_RESYNC}`),
      DIRECTORY("docs/dir-as-mirror-link.md", "link", `or ${MIRROR_DIRECTORY_RESYNC}`),
      `${MANIFEST_NAME}: entry 'docs/mirror-odd-kind.md' carries kind "hardlink"`,
      `${MANIFEST_NAME}: entry 'docs/kind-on-managed.md' carries "kind", which the sync never records on a managed entry`,
      `${MANIFEST_NAME}: entry 'docs/grammar-on-managed.md' carries "grammar", which the sync never records on a managed entry`,
    ]);
    for (const finding of findings) expect(finding.message).not.toContain("template");
  });
});
