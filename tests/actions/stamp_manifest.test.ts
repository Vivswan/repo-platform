// Unit tests for the manifest stamper: in-place hash substitution on the
// rendered one-entry-per-line layout, the split-region and symlink hashing
// rules, the self-entry exclusion, conflict-block resolution toward the
// template side, and the warn-don't-fail contract on unparseable input.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMarkerLine, type RegionSlice, splitManagedRegion } from "../../actions/shared/grammar";
import {
  type ManifestEntryShape,
  parseManifestFiles,
  resolveConflictsTowardAfter,
} from "../../actions/shared/manifest";
import {
  describeRewritten,
  entryHash,
  hookArgs,
  normalizeFromText,
  normalizeSymlinkTargets,
  provenanceSlotProblem,
  recordedCommit,
  rewriteRecordedCommit,
  stampManifestText,
} from "../../actions/shared/stamp_manifest";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();

function sha256(data: string): string {
  return new Bun.CryptoHasher("sha256").update(Buffer.from(data, "latin1")).digest("hex");
}

function tree(files: Record<string, string>): string {
  const root = temp.dir("stamp-manifest-");
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function manifestText(entries: string[]): string {
  return `{\n  "$comment": "test",\n  "files": {\n${entries.join(",\n")}\n  }\n}\n`;
}

describe("isMarkerLine", () => {
  test("trim semantics: stray whitespace and a CR still count, substrings do not", () => {
    // THE shared predicate: the stamper, the carries, and the validator's
    // twin must agree on what a marker line is - a trailing space used to
    // count at two of three sites and not the third.
    expect(isMarkerLine("# m", "# m")).toBe(true);
    expect(isMarkerLine("# m ", "# m")).toBe(true);
    expect(isMarkerLine("  # m", "# m")).toBe(true);
    expect(isMarkerLine("# m\r", "# m")).toBe(true);
    expect(isMarkerLine("x # m", "# m")).toBe(false);
    expect(isMarkerLine("# mx", "# m")).toBe(false);
  });
});

describe("splitManagedRegion", () => {
  const markers = { begin: "# b", end: "# e" };
  // The whole slice is the contract: above and below are the repo-owned
  // sides the sync writes back around the region, so each case pins all
  // three parts.
  const sliced: [string, string, RegionSlice][] = [
    [
      "plain marker lines",
      "above\n# b\nmanaged\n# e\nbelow\n",
      { above: "above\n", region: "# b\nmanaged\n# e\n", below: "below\n" },
    ],
    [
      "an indented BEGIN line (matched by trimmed content, kept in the region)",
      "a\n  # b\nx\n# e\nz\n",
      { above: "a\n", region: "  # b\nx\n# e\n", below: "z\n" },
    ],
    [
      "an END at end of file without a trailing newline (stays in bounds)",
      "# b\nx\n# e",
      { above: "", region: "# b\nx\n# e", below: "" },
    ],
  ];
  test.each(sliced)(
    "slices above, region (markers included), and below: %s",
    (_reason, content, expected) => {
      expect(splitManagedRegion(content, markers)).toEqual(expected);
    },
  );
  test("a missing marker returns null", () => {
    expect(splitManagedRegion("# b\nx\n", markers)).toBeNull();
    expect(splitManagedRegion("x\n# e\n", markers)).toBeNull();
    // END must come AFTER BEGIN.
    expect(splitManagedRegion("# e\nx\n# b\n", markers)).toBeNull();
  });
});

describe("resolveConflictsTowardAfter", () => {
  test("keeps the template side and drops the local side and markers", () => {
    const text = [
      "a",
      "<<<<<<< before updating",
      "local",
      "=======",
      "template",
      ">>>>>>> after updating",
      "b",
    ].join("\n");
    expect(resolveConflictsTowardAfter(text)).toBe("a\ntemplate\nb");
  });
  // Anything that is not a well-sequenced copier block passes through
  // byte-identical: dropping lines on a guess could silently discard
  // entries, and the parse step then reports the mess.
  const unchanged: [string, string][] = [
    ["marker-free text", "a\nb\n"],
    ["a bare ======= outside a block (ordinary content)", "a\n=======\nb"],
    ["an unterminated block (no separator, no end)", "a\n<<<<<<< before updating\nlocal\nb"],
    [
      "a block whose separator never arrives before the end marker",
      ["<<<<<<< before updating", "local", ">>>>>>> after updating"].join("\n"),
    ],
    ["an end marker outside any block", "a\n>>>>>>> after updating\nb"],
    [
      "a nested start inside a block",
      [
        "<<<<<<< before updating",
        "<<<<<<< before updating",
        "=======",
        "x",
        ">>>>>>> after updating",
      ].join("\n"),
    ],
    [
      "a second separator inside the template side",
      [
        "<<<<<<< before updating",
        "local",
        "=======",
        "x",
        "=======",
        "y",
        ">>>>>>> after updating",
      ].join("\n"),
    ],
    [
      "git-style labels, which are not copier's markers",
      ["<<<<<<< HEAD", "local", "=======", "theirs", ">>>>>>> main"].join("\n"),
    ],
  ];
  test.each(unchanged)("returns the text unchanged for %s instead of guessing", (_reason, text) => {
    expect(resolveConflictsTowardAfter(text)).toBe(text);
  });
});

describe("recordedCommit", () => {
  test("reads the plain, double-quoted, and single-quoted forms", () => {
    expect(
      recordedCommit(tree({ ".github/.copier-answers.yml": "_commit: templates/v1.2.3\n" })),
    ).toBe("templates/v1.2.3");
    expect(recordedCommit(tree({ ".github/.copier-answers.yml": '_commit: "abc1234"\n' }))).toBe(
      "abc1234",
    );
    expect(recordedCommit(tree({ ".github/.copier-answers.yml": "_commit: 'abc1234'\n" }))).toBe(
      "abc1234",
    );
  });
  test("a missing file or key yields null", () => {
    expect(recordedCommit(tree({}))).toBeNull();
    expect(recordedCommit(tree({ ".github/.copier-answers.yml": "_src_path: x\n" }))).toBeNull();
  });
});

describe("rewriteRecordedCommit", () => {
  const SHA = "31beeca7cfa33c8b7271e31d16d6517902131ac8";
  const REST = "_src_path: gh:Vivswan/repo-platform\nproject_name: X\n";
  test.each([
    {
      reason: "copier's plain abbreviation",
      before: "_commit: 31beeca\n",
      after: `_commit: ${SHA}\n`,
    },
    { reason: "a double-quoted value", before: '_commit: "2753404"\n', after: `_commit: ${SHA}\n` },
    { reason: "a single-quoted value", before: "_commit: '2753404'\n", after: `_commit: ${SHA}\n` },
    {
      reason: "an exponent-shaped bare value copier leaves unquoted",
      before: "_commit: 1626e53\n",
      after: `_commit: ${SHA}\n`,
    },
    {
      reason: "a tag name from describe",
      before: "_commit: v1.0-rc-1\n",
      after: `_commit: ${SHA}\n`,
    },
    {
      reason: "an already-full sha (idempotent)",
      before: `_commit: ${SHA}\n`,
      after: `_commit: ${SHA}\n`,
    },
    {
      reason: "odd spacing after the key survives, the value does not",
      before: "_commit:   abc1234   \n",
      after: `_commit:   ${SHA}\n`,
    },
  ])("$reason", ({ before, after }) => {
    // Only the _commit line moves; the header comment and other keys are
    // byte-identical.
    const header = "# managed by repo-platform\n";
    expect(rewriteRecordedCommit(header + before + REST, SHA)).toBe(header + after + REST);
  });

  test("an all-digit sha is written quoted so PyYAML keeps it a string", () => {
    const digits = "1234567890".repeat(4);
    expect(rewriteRecordedCommit("_commit: abc1234\n", digits)).toBe(`_commit: "${digits}"\n`);
    // Round trip through the hook's own reader: the quotes are transparent.
    expect(recordedCommit(tree({ ".github/.copier-answers.yml": `_commit: "${digits}"\n` }))).toBe(
      digits,
    );
  });

  test("a text without exactly one _commit line, or a bad sha, is refused", () => {
    expect(() => rewriteRecordedCommit(REST, SHA)).toThrow("carries 0 _commit lines");
    expect(() => rewriteRecordedCommit("", SHA)).toThrow("carries 0 _commit lines");
    expect(() => rewriteRecordedCommit("_commit: a\n_commit: b\n", SHA)).toThrow(
      "carries 2 _commit lines",
    );
    for (const bad of ["31beeca", SHA.toUpperCase(), `${SHA}f`, "v1.0", ""]) {
      expect(() => rewriteRecordedCommit("_commit: x\n", bad)).toThrow("must be a full 40-hex sha");
    }
  });
});

describe("provenanceSlotProblem", () => {
  // Parser-level successes only: every REJECTION is judged where it
  // matters, in the whole-process table below (exit code, message, both
  // files untouched), so no case is asserted twice.
  test.each([
    {
      reason: "the rendered self entry",
      text: manifestText([
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`,
      ]),
    },
    {
      reason: "a stamped self entry (idempotent re-stamp)",
      text: manifestText([
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": "abc"}`,
      ]),
    },
    {
      reason: "the self entry beside other entries, wherever it sits",
      text: manifestText([
        `    "a.md": {"class": "managed", "hash": null}`,
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`,
        `    "z.md": {"class": "starter"}`,
      ]),
    },
  ])("$reason", ({ text }) => {
    expect(provenanceSlotProblem(text)).toBeNull();
  });
});

describe("hookArgs", () => {
  const SHA = "31beeca7cfa33c8b7271e31d16d6517902131ac8";
  const ANS = ".github/.copier-answers.yml";
  test.each([
    { argv: [], expected: { root: null, commit: null, answers: null } },
    { argv: ["--root", "/x"], expected: { root: "/x", commit: null, answers: null } },
    {
      argv: ["--commit", SHA, "--answers", ANS],
      expected: { root: null, commit: SHA, answers: ANS },
    },
    {
      argv: ["--root", "/x", "--commit", SHA, "--answers", ANS],
      expected: { root: "/x", commit: SHA, answers: ANS },
    },
    {
      reason: "any order",
      argv: ["--answers", ANS, "--commit", SHA, "--root", "/x"],
      expected: { root: "/x", commit: SHA, answers: ANS },
    },
  ])("$argv", ({ argv, expected }) => {
    expect(hookArgs(argv)).toEqual(expected);
  });

  test.each([
    { argv: ["--commit"], message: "usage:" },
    { argv: ["--root"], message: "usage:" },
    { argv: ["--other", SHA], message: "usage:" },
    { argv: ["--commit", SHA, "--answers", ANS, "extra"], message: "usage:" },
    { argv: ["--root", "/x", "--root", "/y"], message: "usage:" },
    { argv: ["--commit", SHA, "--commit", SHA, "--answers", ANS], message: "usage:" },
    { argv: ["--root", "--commit"], message: "usage:" },
    { argv: ["--root", "--commit", SHA], message: "usage:" },
    { argv: ["--commit", "31beeca", "--answers", ANS], message: "must be a full 40-hex sha" },
    // An unrendered template expression (copier without vcs_ref_hash
    // support, or a hand-run outside a git clone) is the loud case.
    {
      argv: ["--commit", "{{ _copier_conf.vcs_ref_hash }}", "--answers", ANS],
      message: "must be a full 40-hex sha",
    },
    { argv: ["--commit", "None", "--answers", ANS], message: "must be a full 40-hex sha" },
    { argv: ["--commit", SHA], message: "--commit and --answers come together" },
    { argv: ["--answers", ANS], message: "--commit and --answers come together" },
    {
      reason: "a render into another answers file is refused, not stamped",
      argv: ["--commit", SHA, "--answers", "other.yml"],
      message:
        "--answers names 'other.yml', but this template records its answers in '.github/.copier-answers.yml'",
    },
    {
      // On POSIX a backslash is a filename character: this names a
      // root-level file, not the declared path (on Windows it is the
      // host's own spelling of the declared path and is accepted).
      reason: "a backslash spelling on POSIX is another file",
      argv: ["--commit", SHA, "--answers", ".github\\.copier-answers.yml"],
      message: "outside the template's contract",
      posixOnly: true,
    },
    {
      reason: "a dot-prefixed spelling is not the declared spelling (copier never sends one)",
      argv: ["--commit", SHA, "--answers", "./.github/.copier-answers.yml"],
      message: "outside the template's contract",
    },
    {
      reason: "a traversal that folds to the declared path could cross a symlink",
      argv: ["--commit", SHA, "--answers", ".github/link/../.copier-answers.yml"],
      message: "outside the template's contract",
    },
    {
      reason: "the root-level pre-move path is another file too",
      argv: ["--commit", SHA, "--answers", ".copier-answers.yml"],
      message: "outside the template's contract",
    },
  ])("refuses $argv", ({ argv, message, posixOnly }) => {
    if (posixOnly === true && process.platform === "win32") return;
    expect(() => hookArgs(argv)).toThrow(message);
  });
});

describe("the root the hook stamps", () => {
  const SHA = "31beeca7cfa33c8b7271e31d16d6517902131ac8";
  const hook = join(import.meta.dir, "../../actions/shared/stamp_manifest.ts");
  const ANSWERS = "_commit: 31beeca\n_src_path: ./tree\n";
  const manifest = () =>
    manifestText([
      `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`,
    ]);
  const pair = () =>
    tree({
      ".github/.copier-answers.yml": ANSWERS,
      ".github/repo-platform-manifest.json": manifest(),
    });

  test("an inherited TARGET_DIR never chooses the tree: --root wins, else cwd", () => {
    // The class this guards: a harness exported TARGET_DIR for one leg and
    // a later render's hook stamped THAT tree instead of its own.
    const other = pair();
    const viaRoot = pair();
    const viaCwd = pair();
    const env = { ...process.env, TARGET_DIR: other };
    expect(
      boundedSpawnSync(
        [
          "bun",
          hook,
          "--root",
          viaRoot,
          "--commit",
          SHA,
          "--answers",
          ".github/.copier-answers.yml",
        ],
        { env },
      ).exitCode,
    ).toBe(0);
    expect(
      boundedSpawnSync(["bun", hook, "--commit", SHA, "--answers", ".github/.copier-answers.yml"], {
        cwd: viaCwd,
        env,
      }).exitCode,
    ).toBe(0);
    expect(recordedCommit(viaRoot)).toBe(SHA);
    expect(recordedCommit(viaCwd)).toBe(SHA);
    expect(readFileSync(join(other, ".github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
    expect(readFileSync(join(other, ".github/repo-platform-manifest.json"), "utf-8")).toBe(
      manifest(),
    );
  });
});

describe("the hook as copier runs it", () => {
  const SHA = "31beeca7cfa33c8b7271e31d16d6517902131ac8";
  const hook = join(import.meta.dir, "../../actions/shared/stamp_manifest.ts");
  const run = (root: string, args: string[]) =>
    boundedSpawnSync(["bun", hook, "--root", root, ...args], { env: process.env });

  test("--commit rewrites the answers line and the manifest's provenance slot follows", () => {
    const answers = "# managed\n_commit: 31beeca\n_src_path: ./tree\n";
    const root = tree({
      ".github/.copier-answers.yml": answers,
      ".github/repo-platform-manifest.json": manifestText([
        `    ".github/.copier-answers.yml": {"class": "managed", "hash": null}`,
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`,
      ]),
    });
    const proc = run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
    expect(proc.exitCode).toBe(0);
    const rewritten = `# managed\n_commit: ${SHA}\n_src_path: ./tree\n`;
    expect(Bun.file(join(root, ".github/.copier-answers.yml")).text()).resolves.toBe(rewritten);
    const manifest = readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8");
    expect(manifest).toContain(`"commit": "${SHA}"`);
    expect(manifest).toContain(`"hash": "${sha256(rewritten)}"`);
    // The sync's final re-stamp (no argument) keeps the recorded value.
    expect(run(root, []).exitCode).toBe(0);
    expect(recordedCommit(root)).toBe(SHA);
  });

  test("--commit against a tree without an answers file fails instead of stamping blind", () => {
    const manifest = manifestText([
      `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`,
    ]);
    const root = tree({ ".github/repo-platform-manifest.json": manifest });
    const proc = run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("ENOENT");
    expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toBe(manifest);
  });

  const ANSWERS = "# managed\n_commit: 31beeca\n_src_path: ./tree\n";
  const SELF = `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`;
  test.each([
    { reason: "a missing manifest", manifest: null, stderr: "not found" },
    { reason: "a malformed manifest", manifest: "not json\n", stderr: "does not parse" },
    {
      reason: "a manifest without a self entry",
      manifest: manifestText([`    "x.md": {"class": "managed", "hash": null}`]),
      stderr: "has no .github/repo-platform-manifest.json entry under files",
    },
    {
      reason: "a canonical top-level decoy beside a files entry without slots",
      manifest: [
        "{",
        '  ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null},',
        '  "files": {',
        `    ".github/repo-platform-manifest.json": {"class": "starter"}`,
        "  }",
        "}",
        "",
      ].join("\n"),
      stderr: 'expected exactly ["class","hash","commit"]',
    },
    {
      reason: "a files entry spread over several lines (the line stamper never reaches it)",
      manifest: [
        "{",
        '  "files": {',
        `    ".github/repo-platform-manifest.json": {`,
        '      "class": "managed", "hash": null, "commit": null',
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
      stderr: "not on one line",
    },
    {
      reason: "a self entry without a commit slot",
      manifest: manifestText([
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null}`,
      ]),
      stderr: 'expected exactly ["class","hash","commit"]',
    },
    {
      reason: "a self entry whose slots are nested look-alikes",
      manifest: manifestText([
        `    ".github/repo-platform-manifest.json": {"class": "managed", "meta": {"hash": null, "commit": null}}`,
      ]),
      stderr: 'expected exactly ["class","hash","commit"]',
    },
    {
      reason: "escaped-quote keys that spell the tokens before the real slots",
      manifest: manifestText([
        `    ".github/repo-platform-manifest.json": {"class":"managed","foo\\"hash": null,"foo\\"commit": null,"hash":null,"commit":null}`,
      ]),
      stderr: 'expected exactly ["class","hash","commit"]',
    },
    {
      reason: "the right keys spelled compactly (parses, but the stamper would never rewrite it)",
      manifest: manifestText([
        `    ".github/repo-platform-manifest.json": {"class":"managed","hash":null,"commit":null}`,
      ]),
      stderr: "not in the rendered layout",
    },
    {
      reason: "the right keys in another order",
      manifest: manifestText([
        `    ".github/repo-platform-manifest.json": {"hash": null, "class": "managed", "commit": null}`,
      ]),
      stderr: 'expected exactly ["class","hash","commit"]',
    },
    {
      reason: "a decoy line differing from the files entry",
      manifest: [
        "{",
        '  ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": "x"},',
        '  "files": {',
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`,
        "  }",
        "}",
        "",
      ].join("\n"),
      stderr: "not in the rendered layout",
    },
    {
      reason: "a hash value the stamper's token match skips",
      manifest: manifestText([
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": "zz", "commit": null}`,
      ]),
      stderr: "a form the stamper cannot rewrite",
    },
  ])(
    "--commit under $reason fails before touching either file (the pair never disagrees)",
    ({ manifest, stderr }) => {
      const files: Record<string, string> = { ".github/.copier-answers.yml": ANSWERS };
      if (manifest !== null) files[".github/repo-platform-manifest.json"] = manifest;
      const root = tree(files);
      const proc = run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr).toContain(stderr);
      expect(proc.stderr).toContain("nothing was written");
      // The answers file is byte-identical: the abbreviation is still there.
      expect(readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
      if (manifest !== null) {
        expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toBe(
          manifest,
        );
      }
    },
  );

  test.each([
    { reason: "the answers write itself fails half way", target: ".github/.copier-answers.yml" },
    {
      reason: "the manifest write itself fails half way",
      target: ".github/repo-platform-manifest.json",
    },
  ])("$reason: both files read back byte-identical", ({ target }) => {
    // A write that truncates and then fails (fault_write.preload.ts
    // injects EIO after the truncate) is the half-written state; each
    // write is marked attempted BEFORE it starts, so the rollback covers
    // it. Under the old order the truncated file would have been left.
    const manifest = manifestText([SELF]);
    const root = tree({
      ".github/.copier-answers.yml": ANSWERS,
      ".github/repo-platform-manifest.json": manifest,
    });
    const proc = boundedSpawnSync(
      [
        "bun",
        "--preload",
        join(import.meta.dir, "fault_write.preload.ts"),
        hook,
        "--root",
        root,
        "--commit",
        SHA,
        "--answers",
        ".github/.copier-answers.yml",
      ],
      { env: { ...process.env, FAULT_WRITE_PATH: join(root, target) } },
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("EIO: injected write failure");
    expect(readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
    expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toBe(manifest);
  });

  test("a failure AFTER the answers write rolls it back: the pair is never half-written", () => {
    // Validation passes (stampable manifest, one _commit line), the answers
    // file is written, then hashing a managed file the process cannot
    // read throws (EACCES) before the manifest write: both files must read
    // back byte-identical to their pre-run state.
    if (process.getuid?.() === 0) return; // root ignores mode bits
    const manifest = manifestText([SELF, `    "secret.md": {"class": "managed", "hash": null}`]);
    const root = tree({
      ".github/.copier-answers.yml": ANSWERS,
      ".github/repo-platform-manifest.json": manifest,
      "secret.md": "unreadable\n",
    });
    chmodSync(join(root, "secret.md"), 0o000);
    try {
      const proc = run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
      expect(proc.exitCode).not.toBe(0);
      expect(proc.stderr).toContain("EACCES");
      expect(readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
      expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toBe(
        manifest,
      );
    } finally {
      chmodSync(join(root, "secret.md"), 0o600);
    }
  });

  test("what the preflight cannot see, the structural read-back catches and rolls back BOTH files", () => {
    // A canonical decoy line at the top level passes every line check; the
    // real files entry spans lines, so the stamper rewrites only the decoy.
    // The read-back reads files[MANIFEST_NAME] structurally, sees the null
    // commit, throws, and restores the answers file AND the written
    // manifest byte for byte.
    const manifest = [
      "{",
      '  ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null},',
      '  "files": {',
      '    ".github/.copier-answers.yml": {"class": "managed", "hash": null},',
      `    ".github/repo-platform-manifest.json": {`,
      '      "class": "managed", "hash": null, "commit": null',
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const root = tree({
      ".github/.copier-answers.yml": ANSWERS,
      ".github/repo-platform-manifest.json": manifest,
    });
    const proc = run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("provenance disagrees after stamping");
    expect(readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
    expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toBe(manifest);
  });

  test("a decoy hiding a multi-line entry whose commit already matches still fails on the self-hash", () => {
    // The real files entry already records the sha but carries a non-null
    // self-hash (which the stamper resets only on the lines it rewrites).
    // A byte-identical decoy passes the preflight and gets reset; the real
    // entry keeps its hash. The read-back verifies the WHOLE self entry -
    // commit AND a null hash - so this rolls back too.
    const hash = "a".repeat(64);
    const manifest = [
      "{",
      `  ".github/repo-platform-manifest.json": {"class": "managed", "hash": "${hash}", "commit": "${SHA}"},`,
      '  "files": {',
      '    ".github/.copier-answers.yml": {"class": "managed", "hash": null},',
      `    ".github/repo-platform-manifest.json": {`,
      `      "class": "managed", "hash": "${hash}", "commit": "${SHA}"`,
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const root = tree({
      ".github/.copier-answers.yml": ANSWERS,
      ".github/repo-platform-manifest.json": manifest,
    });
    const proc = run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("provenance disagrees after stamping");
    expect(readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
    expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toBe(manifest);
  });

  test("a recorded commit value carrying an escaped quote is replaced whole", () => {
    // The commit token consumes a complete JSON string: a value like
    // "foo\"bar" used to be cut at the escaped quote, leaving invalid JSON.
    const root = tree({
      ".github/.copier-answers.yml": ANSWERS,
      ".github/repo-platform-manifest.json": manifestText([
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": "foo\\"bar"}`,
      ]),
    });
    expect(run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]).exitCode).toBe(
      0,
    );
    const stamped = readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8");
    expect(JSON.parse(stamped).files[".github/repo-platform-manifest.json"].commit).toBe(SHA);
    expect(recordedCommit(root)).toBe(SHA);
  });

  test("a refused render mutates nothing, symlink normalization included", () => {
    // Every check runs before the first mutation: with a manifest-listed
    // link still pointing at its .jinja twin and an answers file with no
    // _commit line, the refusal must leave the link target untouched (a
    // normalization that ran first would have rewritten it).
    const root = tree({
      ".github/.copier-answers.yml": "_src_path: ./tree\n",
      ".github/repo-platform-manifest.json": manifestText([
        SELF,
        `    "AGENTS.md": {"class": "managed", "hash": null}`,
      ]),
    });
    symlinkSync("CLAUDE.md.jinja", join(root, "AGENTS.md"));
    const proc = run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("carries 0 _commit lines");
    expect(readlinkSync(join(root, "AGENTS.md"))).toBe("CLAUDE.md.jinja");
    expect(readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8")).toBe(
      "_src_path: ./tree\n",
    );
  });

  test("the positive control: the same answers with a stampable manifest write both halves", () => {
    const root = tree({
      ".github/.copier-answers.yml": ANSWERS,
      ".github/repo-platform-manifest.json": manifestText([SELF]),
    });
    expect(run(root, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]).exitCode).toBe(
      0,
    );
    expect(recordedCommit(root)).toBe(SHA);
    expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toContain(
      `"commit": "${SHA}"`,
    );
  });

  test.each(UNREACHED_SHAPES)(
    "entries the rewrite cannot reach (%s): the argument-free re-stamp warns and stamps the rest; --commit refuses whole",
    (_reason, unreachable, unreached) => {
      // The argument-free mode is the sync's final re-stamp over a delivered
      // tree, where warn-and-continue leaves the parity check to report the
      // unstamped entries in the PR. Under --commit the same manifest is a
      // preflight refusal: the render's provenance stamp never rides a
      // partial stamp, and nothing is written. Neither diagnostic may echo
      // the sentinel key.
      const manifest = manifestText([
        SELF,
        ...unreachable,
        `    "c.md": {"class": "managed", "hash": null}`,
      ]);
      const files = {
        ".github/.copier-answers.yml": ANSWERS,
        ".github/repo-platform-manifest.json": manifest,
        "SECRET-private/a.md": "a\n",
        "b.md": "b\n",
        "c.md": "c\n",
      };
      const root = tree(files);
      const plain = run(root, []);
      expect(plain.exitCode).toBe(0);
      expect(plain.stderr).toContain(`has ${unreached} files entr`);
      expect(plain.stderr).not.toContain("SECRET");
      expect(readFileSync(join(root, ".github/repo-platform-manifest.json"), "utf-8")).toBe(
        manifestText([
          `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": "31beeca"}`,
          ...unreachable,
          `    "c.md": {"class": "managed", "hash": "${sha256("c\n")}"}`,
        ]),
      );
      const render = tree(files);
      const refused = run(render, ["--commit", SHA, "--answers", ".github/.copier-answers.yml"]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain(`has ${unreached} files entr`);
      expect(refused.stderr).toContain("nothing was written");
      expect(refused.stderr).not.toContain("SECRET");
      expect(readFileSync(join(render, ".github/.copier-answers.yml"), "utf-8")).toBe(ANSWERS);
      expect(readFileSync(join(render, ".github/repo-platform-manifest.json"), "utf-8")).toBe(
        manifest,
      );
    },
  );

  test("a malformed --commit fails the render loudly instead of stamping", () => {
    const root = tree({
      ".github/.copier-answers.yml": "_commit: 31beeca\n",
      ".github/repo-platform-manifest.json": manifestText([
        `    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}`,
      ]),
    });
    const proc = run(root, ["--commit", "31beeca", "--answers", ".github/.copier-answers.yml"]);
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr).toContain("must be a full 40-hex sha");
    expect(recordedCommit(root)).toBe("31beeca");
  });
});

// The two layouts the line-by-line rewrite cannot reach, each valid JSON the
// shared parser accepts: entries joined on one line (the greedy layout reads
// both as one body) and an entry spread over several lines. Keys carry a
// hostile sentinel: manifest keys are target-repo paths, so no diagnostic
// may echo them.
const UNREACHED_SHAPES: [string, string[], number][] = [
  [
    "two entries joined on one line",
    [
      `    "SECRET-private/a.md": {"class": "managed", "hash": null}, "b.md": {"class": "managed", "hash": null}`,
    ],
    2,
  ],
  [
    "an entry spread over several lines",
    [`    "SECRET-private/a.md": {\n      "class": "managed", "hash": null\n    }`],
    1,
  ],
];

describe("stampManifestText", () => {
  const SELF = '".github/repo-platform-manifest.json"';
  const selfLine = (hash: string, commit: string) =>
    `    ${SELF}: {"class": "managed", "hash": ${hash}, "commit": ${commit}}`;

  // The self entry's commit slot follows the answers file; its hash stays
  // null (the manifest's content includes every other hash, so a
  // self-hash would be circular) and the stamp is idempotent either way.
  const commitCases: [string, Record<string, string>, string, string][] = [
    [
      "a recorded _commit is stamped in",
      { ".github/.copier-answers.yml": "_commit: templates/v2.0.0\n_src_path: x\n" },
      "null",
      '"templates/v2.0.0"',
    ],
    ["no readable _commit stamps the provenance null", {}, '"stale"', "null"],
  ];
  test.each(commitCases)(
    "the self entry's provenance commit: %s",
    (_reason, files, inputCommit, expectedCommit) => {
      const root = tree(files);
      const text = manifestText([selfLine("null", inputCommit)]);
      const expected = manifestText([selfLine("null", expectedCommit)]);
      expect(stampManifestText(text, root)).toEqual({
        out: expected,
        problem: null,
        unreachedEntries: 0,
      });
      expect(stampManifestText(expected, root)).toEqual({
        out: expected,
        problem: null,
        unreachedEntries: 0,
      });
    },
  );

  test("stamps managed, split, and symlink entries and leaves the rest", () => {
    const region =
      "<!-- BEGIN REPO-PLATFORM MANAGED -->\nmanaged\n<!-- END REPO-PLATFORM MANAGED -->\n";
    const entries = (hashes: { claude: string; security: string; ci: string; self: string }) =>
      manifestText([
        `    "CLAUDE.md": {"class": "managed", "hash": ${hashes.claude}}`,
        `    "SECURITY.md": {"class": "split", "grammar": "managed-region", "begin": "<!-- BEGIN REPO-PLATFORM MANAGED -->", "end": "<!-- END REPO-PLATFORM MANAGED -->", "hash": ${hashes.security}}`,
        '    "checks.yml": {"class": "starter"}',
        `    "ci.yml": {"class": "managed", "hash": ${hashes.ci}}`,
        `    ${SELF}: {"class": "managed", "hash": ${hashes.self}}`,
      ]);
    // The self entry is seeded with a stale hash AND exists on disk, so
    // the null it comes back with is the exclusion at work, not a
    // missing file.
    const text = entries({
      claude: "null",
      security: "null",
      ci: "null",
      self: `"${"a".repeat(64)}"`,
    });
    const root = tree({
      "ci.yml": "managed content\n",
      "SECURITY.md": `repo preamble\n${region}repo tail\n`,
      ".github/repo-platform-manifest.json": text,
    });
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    // Only the hash tokens move: the starter line and every other byte
    // are in the expected text verbatim.
    expect(stampManifestText(text, root)).toEqual({
      out: entries({
        claude: `"${sha256("AGENTS.md")}"`,
        security: `"${sha256(region)}"`,
        ci: `"${sha256("managed content\n")}"`,
        self: "null",
      }),
      problem: null,
      unreachedEntries: 0,
    });
  });

  test("is idempotent and re-stamps a stale hash", () => {
    const root = tree({ "ci.yml": "new content\n" });
    const entry = (hash: string) =>
      manifestText([`    "ci.yml": {"class": "managed", "hash": "${hash}"}`]);
    const once = entry(sha256("new content\n"));
    expect(stampManifestText(entry("0".repeat(64)), root)).toEqual({
      out: once,
      problem: null,
      unreachedEntries: 0,
    });
    expect(stampManifestText(once, root)).toEqual({
      out: once,
      problem: null,
      unreachedEntries: 0,
    });
  });

  // The withheld marker's lifecycle, one row per entry state. commit_push.ts
  // names the added workflow files it removed before pushing (`named`); a
  // stamp with no set is copier's hook or the sync's final stamp. `before`
  // is the entry as stamped, `after` what one stamp (with the set, then
  // idempotently without) must print. Only kept.yml and old.md exist on
  // disk.
  const MARKER_ROWS: {
    path: string;
    named: boolean;
    before: string;
    after: string;
    why: string;
  }[] = [
    {
      path: ".github/workflows/added.yml",
      named: true,
      before: '{"class": "managed", "hash": null, "withheld": false}',
      after: '{"class": "managed", "hash": null, "withheld": true}',
      why: "a named absent workflow gains the marker; a stale false is replaced, never doubled",
    },
    {
      path: ".github/workflows/kept.yml",
      named: true,
      before: '{"class": "managed", "hash": null}',
      after: `{"class": "managed", "hash": "${sha256("kept\n")}"}`,
      why: "a named path whose file exists was not withheld",
    },
    {
      path: "docs/old.md",
      named: false,
      before: `{"class": "managed", "hash": "${sha256("stale")}", "withheld": true}`,
      after: `{"class": "managed", "hash": "${sha256("delivered\n")}"}`,
      why: "a marker on a delivered file is stale and goes",
    },
    {
      path: ".github/workflows/stray.yml",
      named: false,
      before: '{"class": "managed", "withheld": true, "hash": null}',
      after: '{"class": "managed", "hash": null, "withheld": true}',
      why: "a valid marker on a still-absent workflow survives a set-less stamp, in canonical position",
    },
    {
      path: ".github/workflows/front.yml",
      named: false,
      before: '{"withheld": true, "class": "managed", "hash": null}',
      after: '{"class": "managed", "hash": null, "withheld": true}',
      why: "same, from the front of the object",
    },
    {
      path: "docs/flagged.md",
      named: true,
      before: '{"class": "managed", "hash": null, "withheld": true}',
      after: '{"class": "managed", "hash": null}',
      why: "outside .github/workflows/ no marker is valid, named or not",
    },
    {
      path: ".github/workflows/../../docs/alias.md",
      named: true,
      before: '{"class": "managed", "hash": null, "withheld": true}',
      after: '{"class": "managed", "hash": null}',
      why: "a lexical prefix with a .. segment is not under the directory",
    },
    {
      path: ".github/workflows/./dot.yml",
      named: true,
      before: '{"class": "managed", "hash": null}',
      after: '{"class": "managed", "hash": null}',
      why: "a . segment is not a clean path",
    },
    {
      path: ".github/workflows//empty.yml",
      named: true,
      before: '{"class": "managed", "hash": null}',
      after: '{"class": "managed", "hash": null}',
      why: "an empty segment is not a clean path",
    },
    {
      path: ".github/workflows/split.yml",
      named: true,
      before:
        '{"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": null}',
      after:
        '{"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": null, "withheld": true}',
      why: "a named absent split entry gains the marker like a managed one",
    },
    {
      path: ".github/workflows/nested.yml",
      named: false,
      before: '{"class": "managed", "hash": null, "withheld": {"withheld": true}}',
      after: '{"class": "managed", "hash": null}',
      why: "a nested object is not the marker",
    },
    {
      path: ".github/workflows/laundered.yml",
      named: false,
      before: `{"class": "managed", "hash": "${sha256("was here")}", "withheld": true}`,
      after: '{"class": "managed", "hash": null}',
      why: "a marker decorating a deleted, once-hashed entry does not mature into the valid shape",
    },
    {
      path: ".github/workflows/bespoke.yml",
      named: true,
      before: '{"class": "bespoke", "hash": null}',
      after: '{"class": "bespoke", "hash": null}',
      why: "an unknown class gains no marker even when named",
    },
    {
      path: ".github/workflows/checks.yml",
      named: true,
      before: '{"class": "starter", "withheld": true}',
      after: '{"class": "starter"}',
      why: "a starter has no hash field: never marked, and a stray marker is stripped",
    },
  ];

  test("the withheld marker lifecycle: every MARKER_ROWS row in one manifest", () => {
    // The rows ride one manifest asserted whole, so a row cannot pass by
    // another row's stamp and the failure diff names the row. The self
    // entry (hash field, excluded by path) is named too and stays
    // unmarked.
    const root = tree({ ".github/workflows/kept.yml": "kept\n", "docs/old.md": "delivered\n" });
    const text = (column: "before" | "after") =>
      manifestText([
        selfLine("null", "null"),
        ...MARKER_ROWS.map((row) => `    ${JSON.stringify(row.path)}: ${row[column]}`),
      ]);
    const named = new Set([
      ".github/repo-platform-manifest.json",
      ...MARKER_ROWS.filter((row) => row.named).map((row) => row.path),
    ]);
    expect(stampManifestText(text("before"), root, named)).toEqual({
      out: text("after"),
      problem: null,
      unreachedEntries: 0,
    });
    expect(stampManifestText(text("after"), root, named)).toEqual({
      out: text("after"),
      problem: null,
      unreachedEntries: 0,
    });
    expect(stampManifestText(text("after"), root)).toEqual({
      out: text("after"),
      problem: null,
      unreachedEntries: 0,
    });
    expect(parseManifestFiles(text("after")).problem).toBeNull();
  });

  test("delivery clears the withheld marker: the next set-less stamp hashes the file", () => {
    const root = tree({ ".github/workflows/added.yml": "added\n" });
    const line = (body: string) => manifestText([`    ".github/workflows/added.yml": ${body}`]);
    expect(
      stampManifestText(line('{"class": "managed", "hash": null, "withheld": true}'), root),
    ).toEqual({
      out: line(`{"class": "managed", "hash": "${sha256("added\n")}"}`),
      problem: null,
      unreachedEntries: 0,
    });
  });

  test("a missing file or missing split markers stamps null", () => {
    const root = tree({ "split.md": "no markers here\n" });
    const entries = (gone: string, split: string) =>
      manifestText([
        `    "gone.yml": {"class": "managed", "hash": ${gone}}`,
        `    "split.md": {"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": ${split}}`,
      ]);
    // Both seeded stale, so each null is a rewrite, not a pass-through.
    const text = entries(`"${"a".repeat(64)}"`, `"${"c".repeat(64)}"`);
    expect(stampManifestText(text, root)).toEqual({
      out: entries("null", "null"),
      problem: null,
      unreachedEntries: 0,
    });
  });

  test("resolves update conflict blocks toward the template side, then stamps", () => {
    const root = tree({ "ci.yml": "content\n" });
    const text = [
      "{",
      '  "$comment": "test",',
      '  "files": {',
      "<<<<<<< before updating",
      `    "ci.yml": {"class": "managed", "hash": "${"b".repeat(64)}"},`,
      '    "retired.yml": {"class": "managed", "hash": null}',
      "=======",
      '    "ci.yml": {"class": "managed", "hash": null}',
      ">>>>>>> after updating",
      "  }",
      "}",
      "",
    ].join("\n");
    // The template side alone survives (retired.yml and the markers are
    // gone) and the stamp lands on it.
    expect(stampManifestText(text, root)).toEqual({
      out: manifestText([`    "ci.yml": {"class": "managed", "hash": "${sha256("content\n")}"}`]),
      problem: null,
      unreachedEntries: 0,
    });
  });

  // Rejected text comes back untouched with a value-free problem, so
  // main() warns and exits 0 rather than aborting the render. The exact
  // constants are the leak check: none carries manifest bytes.
  const INVALID_JSON = "does not parse as a manifest (invalid JSON)";
  const NO_FILES = "does not parse as a manifest (no top-level 'files' mapping)";
  const rejected: [string, string, string][] = [
    ["plain non-JSON", "not json", INVALID_JSON],
    // The bare identifier is the leaking form: a raw JSON.parse error
    // quotes it ('Unexpected identifier ...'), and the problem string
    // reaches the target repo's public sync log via main()'s warning.
    ["a bare identifier (the SyntaxError-echo shape)", '{"files": hiddensecret}', INVALID_JSON],
    // An unterminated block is never resolved by guessing, so the marker
    // stays and the parse fails: a problem, never a silent line drop.
    [
      "an unterminated conflict block",
      [
        "{",
        '  "files": {',
        "<<<<<<< before updating",
        '    "ci.yml": {"class": "managed", "hash": null}',
        "  }",
        "}",
      ].join("\n"),
      INVALID_JSON,
    ],
    ["a parseable document without a files mapping", '{"other": 1}', NO_FILES],
    // JSON.parse("null") succeeds, so this shape reaches the mapping
    // check; dereferencing it would throw past the parse catch and turn
    // the warn-and-exit-0 contract into a hard failure.
    ["a top-level JSON null", "null", NO_FILES],
  ];
  test.each(rejected)("%s returns the text unchanged with a problem", (_reason, text, problem) => {
    expect(stampManifestText(text, tree({}))).toEqual({ out: text, problem, unreachedEntries: 0 });
  });

  test("a duplicated entry line for one path is a soft, value-free problem, never a throw", () => {
    // Duplicate JSON keys last-win at parse time, so a duplicate line (a
    // bad conflict resolution) can flip a path's ownership class with no
    // parse error; stamping both lines would launder the flip. But this
    // must stay SOFT: the same code ships as copier's after-hook over the
    // MERGED tree, where a throw would fail the render and deliver no PR -
    // the validator's parity check reports it in a delivered PR instead.
    // The second line here has NO hash token - the starter-shaped flip.
    // And the key is deliberately hostile: manifest keys are target-repo
    // paths, so naming the duplicate would print a PRIVATE repo's path
    // (or inject control bytes) into the public sync log.
    const key = String.raw`"SECRET-private/path\nleak.md"`;
    const root = tree({ "x.md": "content\n" });
    const text = manifestText([
      `    ${key}: {"class": "managed", "hash": null}`,
      `    ${key}: {"class": "starter"}`,
    ]);
    let result: { out: string; problem: string | null; unreachedEntries: number } | undefined;
    expect(() => {
      result = stampManifestText(text, root);
    }).not.toThrow();
    expect(result?.problem).toContain("binds a key more than once");
    expect(result?.problem).not.toContain("SECRET");
    expect(result?.problem).not.toContain("\n");
    // The untouched text is emitted (out === text), so main() warns and
    // exits 0 rather than aborting the render.
    expect(result?.out).toBe(text);
  });
  test.each(UNREACHED_SHAPES)(
    "entries the line rewrite cannot reach ride through unchanged and counted, never a throw: %s",
    (_reason, unreachable, unreachedEntries) => {
      // Both shapes are valid JSON with distinct keys, so the shared parser
      // accepts the text, yet the one-line layout never rewrites them (the
      // joined pair reads as one body no JSON.parse takes). A throw here
      // would abort copier's after-hook; the lines ride through unchanged,
      // every other line stamps, and the count lets main() warn.
      const root = tree({ "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
      const text = manifestText([...unreachable, `    "c.md": {"class": "managed", "hash": null}`]);
      expect(stampManifestText(text, root)).toEqual({
        out: manifestText([
          ...unreachable,
          `    "c.md": {"class": "managed", "hash": "${sha256("c\n")}"}`,
        ]),
        problem: null,
        unreachedEntries,
      });
    },
  );
});

describe("entryHash", () => {
  test("hashes whole content for managed and the region for split", () => {
    const root = tree({ "f.md": "a\n# b\nx\n# e\nz\n" });
    expect(entryHash(root, "f.md", { class: "managed" })).toBe(sha256("a\n# b\nx\n# e\nz\n"));
    expect(entryHash(root, "f.md", { class: "split", begin: "# b", end: "# e" })).toBe(
      sha256("# b\nx\n# e\n"),
    );
  });
  // The strict slicer (cleanManagedRegion) is the stamper's own
  // accept/reject: a file with no honest region has no honest hash, and
  // the validator's parity check reports the unstamped entry.
  const split = (begin: unknown, end: unknown): ManifestEntryShape => ({
    class: "split",
    begin,
    end,
  });
  const unstampable: [string, string, ManifestEntryShape][] = [
    ["duplicated markers", "# b\nx\n# e\n# b\ny\n# e\n", split("# b", "# e")],
    ["reordered markers", "# e\nx\n# b\n", split("# b", "# e")],
    // A mid-line mention counts as a duplicate too (substring rule).
    ["a marker buried mid-line", "see # b here\n# b\nx\n# e\n", split("# b", "# e")],
    // Marker fields are untrusted JSON. This row pins the contract that a
    // non-string marker yields null (never a hash, never a throw); it does
    // NOT prove the typeof check at stamp_manifest.ts:128 - deleting that
    // check changes nothing here, because the strict marker comparison
    // already matches no line against a number. The check is type
    // narrowing, and only replacing its null with a hash turns this red.
    ["metadata that is not strings", "a\n", split(3, "# e")],
  ];
  test.each(unstampable)("%s yields null, never an ambiguous slice", (_reason, content, entry) => {
    expect(entryHash(tree({ "f.md": content }), "f.md", entry)).toBeNull();
  });
});

// The build branch ships symlink targets with the .jinja suffix kept (a
// dangling link anywhere in the downloaded tree kills the runner's uses:
// tarball staging) and copier renders targets verbatim; the hook strips
// the suffix from MANIFEST-LISTED links only, so repo-owned links are
// never rewritten.
describe("normalizeSymlinkTargets", () => {
  const link = (root: string, path: string, target: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  };
  const readTarget = (root: string, path: string) =>
    boundedSpawnSync(["readlink", join(root, path)]).stdout.trim();

  test("strips the template suffix from a manifest-listed link, idempotently", () => {
    const root = temp.dir("normalize-");
    link(root, "CLAUDE.md", "AGENTS.md.jinja");
    const files = { "CLAUDE.md": { class: "managed" } };
    expect(normalizeSymlinkTargets(root, files)).toEqual(["CLAUDE.md"]);
    expect(readTarget(root, "CLAUDE.md")).toBe("AGENTS.md");
    // Idempotent: a second pass (the sync's extra stamp step) rewrites nothing.
    expect(normalizeSymlinkTargets(root, files)).toEqual([]);
  });

  test("never touches a link the manifest does not list, a non-managed class, or a plain target", () => {
    const root = temp.dir("normalize-");
    link(root, "repo-own.md", "notes.md.jinja");
    link(root, "starter-link.md", "starter.md.jinja");
    link(root, "CLAUDE.md", "AGENTS.md");
    writeFileSync(join(root, "plain.md"), "not a link\n");
    expect(
      normalizeSymlinkTargets(root, {
        "CLAUDE.md": { class: "managed" },
        // A starter is repo-owned after the first render: whatever the
        // repo made of it - a .jinja-targeting link included - stays.
        "starter-link.md": { class: "starter" },
        "plain.md": { class: "managed" },
        "missing.md": { class: "managed" },
      }),
    ).toEqual([]);
    expect(readTarget(root, "repo-own.md")).toBe("notes.md.jinja");
    expect(readTarget(root, "starter-link.md")).toBe("starter.md.jinja");
    expect(readTarget(root, "CLAUDE.md")).toBe("AGENTS.md");
  });

  test("a manifest path that escapes the root is never mutated", () => {
    // Manifest text is target-repo content on updates: an absolute or
    // ..-carrying key, or one reaching out through a symlinked ancestor,
    // must not let the hook unlink anything outside the rendered root.
    const outside = temp.dir("normalize-outside-");
    link(outside, "victim.md", "prey.md.jinja");
    const root = temp.dir("normalize-root-");
    symlinkSync(outside, join(root, "escape"));
    const files = {
      [`../${basename(outside)}/victim.md`]: { class: "managed" },
      "escape/victim.md": { class: "managed" },
      "/etc/hosts": { class: "managed" },
    };
    expect(normalizeSymlinkTargets(root, files)).toEqual([]);
    expect(readTarget(outside, "victim.md")).toBe("prey.md.jinja");
  });
});

// The parse boundary owns ALL manifest validation - every consumer
// (normalization and stamping alike) inherits it, so a manifest the
// parser rejects can never mutate a link or stamp a hash.
describe("parseManifestFiles validation", () => {
  const manifestOf = (filesJson: string) => `{\n  "files": {\n${filesJson}\n  }\n}\n`;
  const readTarget = (root: string, path: string) =>
    boundedSpawnSync(["readlink", join(root, path)]).stdout.trim();

  test("a null (or scalar) entry is a soft problem, never a throw", () => {
    // A null entry would throw at entry.class in a consumer, turning the
    // warn-and-continue contract into a hard render failure.
    for (const bad of ["null", "3", '"managed"', "[]"]) {
      const parsed = parseManifestFiles(manifestOf(`    "a.md": ${bad}`));
      expect(parsed.problem).toContain("not an object with a string class");
      expect(parsed.files).toBeNull();
    }
    const stamped = stampManifestText(manifestOf('    "a.md": null'), "/nonexistent");
    expect(stamped.problem).toContain("not an object with a string class");
  });

  test("a path literally named files or $comment is not double-counted against the structural line", () => {
    // The top-level '"files": {' and '"$comment": ...' lines sit at
    // two-space indent; entries at four. A single honest entry for a path
    // NAMED after one of them must not read as a duplicate.
    const text = [
      "{",
      '  "$comment": "test",',
      '  "files": {',
      '    "files": {"class": "managed", "hash": null},',
      '    "$comment": {"class": "starter"}',
      "  }",
      "}",
      "",
    ].join("\n");
    expect(parseManifestFiles(text)).toEqual({
      files: { files: { class: "managed", hash: null }, $comment: { class: "starter" } },
      resolved: text,
      problem: null,
    });
  });

  // Duplicate JSON keys last-win at parse, so a duplicate line can flip a
  // path's class to managed; acting on the parsed value would then
  // rewrite a link the honest manifest never managed. The parse gate must
  // fire before the mutation, leaving the link untouched - and it finds
  // duplicates STRUCTURALLY, wherever and however they appear.
  const duplicated: [string, string][] = [
    [
      "the canonical two-line duplicate",
      manifestOf(
        '    "CLAUDE.md": {"class": "starter"},\n    "CLAUDE.md": {"class": "managed", "hash": null}',
      ),
    ],
    // "x": null on one line plus a valid object on another: JSON.parse
    // last-wins to the valid object (so the shape check passes), and a
    // scan reading only well-formed entry lines would miss it.
    [
      "mixed value shapes at canonical indent",
      manifestOf('    "CLAUDE.md": null,\n    "CLAUDE.md": {"class": "managed", "hash": null}'),
    ],
    // A re-indented merge artifact (two spaces on the null line), which a
    // scan of canonically indented lines alone would miss.
    [
      "a re-indented duplicate line",
      manifestOf('  "CLAUDE.md": null,\n    "CLAUDE.md": {"class": "managed", "hash": null}'),
    ],
    [
      "both keys on ONE line",
      manifestOf('    "CLAUDE.md": null, "CLAUDE.md": {"class": "managed", "hash": null}'),
    ],
    // JSON.parse last-wins on the OUTER key too: two "files" objects would
    // let the second swap the whole entry set while a walk of the first
    // saw nothing wrong. Scopes are tracked per object, so the duplicate
    // root-level binding is caught like any other.
    [
      "a duplicated top-level files mapping",
      '{"files":{"safe.md":{"class":"starter"}},"files":{"CLAUDE.md":{"class":"managed","hash":null}}}',
    ],
  ];
  test.each(duplicated)("%s normalizes NOTHING (rejected before any mutation)", (_reason, text) => {
    const root = temp.dir("normalize-dup-");
    symlinkSync("notes.md.jinja", join(root, "CLAUDE.md"));
    const { rewritten, problem } = normalizeFromText(text, root);
    expect(rewritten).toEqual([]);
    expect(problem).toContain("binds a key more than once");
    // The mutation never happened: the link still carries its suffix.
    expect(readTarget(root, "CLAUDE.md")).toBe("notes.md.jinja");
  });

  test("rewritten paths are JSON-quoted in the log line (no control-byte injection)", () => {
    // Manifest keys are target-controlled: a decoded path carrying a
    // newline could forge workflow commands in the Actions log. The
    // describeRewritten line must keep every escape literal.
    const evil = "evil\n::error::forged.md";
    expect(describeRewritten([evil, "plain.md"])).toBe(
      String.raw`normalized 2 symlink target(s): "evil\n::error::forged.md", "plain.md"`,
    );
  });
});
