// Unit tests for render_goldens' provenance normalization. The renderer
// itself runs against real copier output (bun run renders:check gates the
// committed goldens); these pin the contract's edges: only the `_commit`
// answer recording the true scratch sha (or a 7-plus-char prefix of it)
// becomes the sentinel, every other byte survives verbatim (7-hex-char
// runs occur in English prose), a pre-stamped sentinel is rejected
// instead of false-matching the committed goldens, the re-stamped
// manifest carries the sentinel provenance and the normalized answers
// hash, and a lying stamp hook fails loudly instead of being healed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampManifestText } from "../../actions/shared/stamp_manifest";
import {
  normalizeAnswers,
  normalizeRenderedTree,
  SHA_SENTINEL,
} from "../../scripts/render_goldens";

const SHA = "98026c9abcdef0123456789abcdef0123456789a";
const SHORT = SHA.slice(0, 7);

describe("normalizeAnswers", () => {
  test("rejects anything but a full lowercase sha1", () => {
    expect(() => normalizeAnswers("_commit: x\n", SHORT)).toThrow("not a full sha1");
    expect(() => normalizeAnswers("_commit: x\n", SHA.toUpperCase())).toThrow("not a full sha1");
    expect(() => normalizeAnswers("_commit: x\n", `${SHA}ff`)).toThrow("not a full sha1");
  });

  const SENTINEL_LINE = `_commit: ${SHA_SENTINEL}\n`;
  test.each([
    {
      reason: "the short form copier records",
      text: `_commit: ${SHORT}\n`,
      sha: SHA,
      expected: SENTINEL_LINE,
    },
    { reason: "the full sha", text: `_commit: ${SHA}\n`, sha: SHA, expected: SENTINEL_LINE },
    {
      reason: "a prefix between short and full",
      text: `_commit: ${SHA.slice(0, 12)}\n`,
      sha: SHA,
      expected: SENTINEL_LINE,
    },
    {
      reason: "nothing but the _commit value (other keys verbatim)",
      text: `_commit: ${SHORT}\n_src_path: ./tree\nproject_name: Golden Render\n`,
      sha: SHA,
      expected: `_commit: ${SHA_SENTINEL}\n_src_path: ./tree\nproject_name: Golden Render\n`,
    },
    {
      reason: "a sub-7-char value: untouched",
      text: `_commit: ${SHA.slice(0, 6)}\n`,
      sha: SHA,
      expected: `_commit: ${SHA.slice(0, 6)}\n`,
    },
    {
      reason: "a wrong short sha: untouched, so a mis-stamped render shows as drift",
      text: `_commit: ${"f".repeat(7)}\n`,
      sha: SHA,
      expected: `_commit: ${"f".repeat(7)}\n`,
    },
    {
      reason: "a value continuing past the prefix wrongly: untouched",
      text: `_commit: ${SHORT}ff\n`,
      sha: SHA,
      expected: `_commit: ${SHORT}ff\n`,
    },
    {
      reason: "no _commit key at all: untouched",
      text: "_src_path: ./tree\n",
      sha: SHA,
      expected: "_src_path: ./tree\n",
    },
    {
      // A hex sentinel ("0000000") would make the already-sentinel guard
      // reject this genuine commit; the sentinel being non-hex keeps the
      // two disjoint.
      reason: "an honest sha of seven zeros: the non-hex sentinel cannot collide",
      text: "_commit: 0000000\n",
      sha: `0000000${"a".repeat(33)}`,
      expected: SENTINEL_LINE,
    },
    {
      // ~4% of commits have an all-decimal 7-char prefix, which copier
      // quotes to keep it a string; before the unwrap, exactly those
      // renders drifted while every other commit passed.
      reason: "a single-quoted all-decimal short sha: unwrapped",
      text: "_commit: '2753404'\n",
      sha: `2753404${"a".repeat(33)}`,
      expected: SENTINEL_LINE,
    },
    {
      reason: "a double-quoted all-decimal short sha: unwrapped",
      text: '_commit: "2753404"\n',
      sha: `2753404${"a".repeat(33)}`,
      expected: SENTINEL_LINE,
    },
    {
      reason: "a quoted WRONG sha: untouched",
      text: "_commit: '9999999'\n",
      sha: SHA,
      expected: "_commit: '9999999'\n",
    },
  ])("$reason", ({ text, sha, expected }) => {
    expect(normalizeAnswers(text, sha)).toBe(expected);
  });

  test("throws on a value already reading as the sentinel, quoted or not", () => {
    expect(() => normalizeAnswers(`_commit: ${SHA_SENTINEL}\n`, SHA)).toThrow(
      `already reads as the sentinel "${SHA_SENTINEL}"`,
    );
    expect(() => normalizeAnswers(`_commit: '${SHA_SENTINEL}'\n`, SHA)).toThrow(
      `already reads as the sentinel "${SHA_SENTINEL}"`,
    );
  });
});

describe("normalizeRenderedTree", () => {
  const sha256 = (text: string) => createHash("sha256").update(text, "latin1").digest("hex");
  const MANIFEST = ".github/repo-platform-manifest.json";

  /** A minimal rendered tree in the stamp hook's own manifest dialect (one
   *  entry per line): the answers file plus content files whose bytes must
   *  survive normalization verbatim (a split file and a symlink, covering
   *  the other hash classes the re-stamp recomputes). */
  const writeFixture = (root: string) => {
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(
      join(root, ".github/.copier-answers.yml"),
      `_commit: ${SHORT}\n_src_path: ./tree\n`,
    );
    writeFileSync(join(root, "notes.md"), "<!-- b -->\nnotes\n<!-- e -->\nrepo half\n");
    symlinkSync("AGENTS.md", join(root, "link"));
    writeFileSync(
      join(root, MANIFEST),
      [
        "{",
        '  "files": {',
        `    ".github/.copier-answers.yml": {"class": "managed", "hash": null},`,
        `    "${MANIFEST}": {"class": "managed", "hash": null, "commit": null},`,
        `    "notes.md": {"class": "split", "grammar": "managed-region", "begin": "<!-- b -->", "end": "<!-- e -->", "hash": null},`,
        `    "link": {"class": "managed", "hash": null}`,
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  };

  /** What the render's own hook does inside copier: stamp the manifest
   *  honestly against the tree as rendered. The honesty gate requires it. */
  const stampFixture = (root: string) => {
    const path = join(root, MANIFEST);
    const { out, problem } = stampManifestText(readFileSync(path, "utf-8"), root);
    if (problem !== null) throw new Error(problem);
    writeFileSync(path, out);
  };

  test("rewrites only the provenance fields and re-stamps the manifest against them", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      writeFixture(root);
      stampFixture(root);
      normalizeRenderedTree(root, SHA);
      const answers = readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8");
      expect(answers).toBe(`_commit: ${SHA_SENTINEL}\n_src_path: ./tree\n`);
      // Content files and symlink targets are not provenance: verbatim.
      expect(readFileSync(join(root, "notes.md"), "utf-8")).toBe(
        "<!-- b -->\nnotes\n<!-- e -->\nrepo half\n",
      );
      expect(readlinkSync(join(root, "link"))).toBe("AGENTS.md");
      const manifest = readFileSync(join(root, MANIFEST), "utf-8");
      // The answers hash covers the normalized file, the commit slot
      // re-reads the sentinel, and the untouched files' hashes (split
      // half, symlink target) re-stamp to their unchanged values.
      expect(manifest).toContain(
        `".github/.copier-answers.yml": {"class": "managed", "hash": "${sha256(answers)}"}`,
      );
      expect(manifest).toContain(
        `"${MANIFEST}": {"class": "managed", "hash": null, "commit": "${SHA_SENTINEL}"}`,
      );
      expect(manifest).toContain(`"hash": "${sha256("<!-- b -->\nnotes\n<!-- e -->\n")}"`);
      expect(manifest).toContain(`"link": {"class": "managed", "hash": "${sha256("AGENTS.md")}"}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves prose containing a 7-hex word matching the sha's prefix byte-identical", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      // "feedbac" is valid hex: a scratch sha starting with it would have
      // let a tree-wide substitution corrupt "feedback" in rendered prose.
      const sha = `feedbac${"0123456789abcdef0123456789abcdef0"}`;
      const prose = "We welcome feedback; a feedback-driven process feeds back.\n";
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(join(root, ".github/.copier-answers.yml"), `_commit: ${sha.slice(0, 7)}\n`);
      writeFileSync(join(root, "CODE_OF_CONDUCT.md"), prose);
      writeFileSync(
        join(root, MANIFEST),
        [
          "{",
          '  "files": {',
          `    ".github/.copier-answers.yml": {"class": "managed", "hash": null},`,
          `    "${MANIFEST}": {"class": "managed", "hash": null, "commit": null},`,
          `    "CODE_OF_CONDUCT.md": {"class": "managed", "hash": null}`,
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      stampFixture(root);
      normalizeRenderedTree(root, sha);
      expect(readFileSync(join(root, "CODE_OF_CONDUCT.md"), "utf-8")).toBe(prose);
      expect(readFileSync(join(root, ".github/.copier-answers.yml"), "utf-8")).toBe(
        `_commit: ${SHA_SENTINEL}\n`,
      );
      const manifest = readFileSync(join(root, MANIFEST), "utf-8");
      expect(manifest).toContain(
        `"CODE_OF_CONDUCT.md": {"class": "managed", "hash": "${sha256(prose)}"}`,
      );
      expect(manifest).toContain(`"commit": "${SHA_SENTINEL}"`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on a dishonest stamp instead of healing it to the sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      writeFixture(root);
      stampFixture(root);
      const path = join(root, MANIFEST);
      const honest = readFileSync(path, "utf-8");
      // A hook bug that stamps a wrong provenance into the manifest only
      // (the answers file still carries the true sha).
      writeFileSync(path, honest.replace(`"commit": "${SHORT}"`, '"commit": "abcdef1"'));
      expect(() => normalizeRenderedTree(root, SHA)).toThrow("not honestly stamped");
      // A hook bug that stamps a wrong hash.
      writeFileSync(
        path,
        honest.replace(`"hash": "${sha256("AGENTS.md")}"`, `"hash": "${"a".repeat(64)}"`),
      );
      expect(() => normalizeRenderedTree(root, SHA)).toThrow("not honestly stamped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on a manifest the stamp hook reports as corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(join(root, MANIFEST), "not json");
      expect(() => normalizeRenderedTree(root, SHA)).toThrow("does not parse");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves a tree without a manifest or answers file alone", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      writeFileSync(join(root, "plain.txt"), "plain content\n");
      normalizeRenderedTree(root, SHA);
      expect(readFileSync(join(root, "plain.txt"), "utf-8")).toBe("plain content\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
