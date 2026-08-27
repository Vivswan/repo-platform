// Unit tests for render_goldens' sha sentinel normalization. The renderer
// itself runs against real copier output (bun run renders:check gates the
// committed goldens); these pin the substitution's edge cases: only the
// true scratch sha (or a 7-plus-char prefix of it) becomes the sentinel,
// back-to-back occurrences all normalize, a pre-stamped sentinel is
// rejected instead of false-matching the committed goldens, the
// re-stamped manifest hashes every class of normalized content, a lying
// stamp hook fails loudly instead of being healed, and a hash that
// happens to contain a prefix of the scratch sha survives intact.

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
import { stampManifestText } from "../../.github/scripts/sync/stamp_manifest";
import { normalizeRenderedTree, SHA_SENTINEL, shaNormalizer } from "../../scripts/render_goldens";

const SHA = "98026c9abcdef0123456789abcdef0123456789a";
const SHORT = SHA.slice(0, 7);
const normalize = shaNormalizer(SHA);

describe("shaNormalizer", () => {
  test("rejects anything but a full lowercase sha1", () => {
    expect(() => shaNormalizer(SHORT)).toThrow("not a full sha1");
    expect(() => shaNormalizer(SHA.toUpperCase())).toThrow("not a full sha1");
    expect(() => shaNormalizer(`${SHA}ff`)).toThrow("not a full sha1");
  });

  test("rewrites the full sha and the short form copier records", () => {
    expect(normalize("f", SHA)).toBe(SHA_SENTINEL);
    expect(normalize("f", `_commit: ${SHORT}\n`)).toBe(`_commit: ${SHA_SENTINEL}\n`);
    expect(normalize("f", `"commit": "${SHA.slice(0, 12)}"`)).toBe(`"commit": "${SHA_SENTINEL}"`);
  });

  test("leaves a sub-7-char prefix untouched", () => {
    expect(normalize("f", SHA.slice(0, 6))).toBe(SHA.slice(0, 6));
  });

  test("leaves a wrong sha untouched, so a mis-stamped render shows as drift", () => {
    const wrong = `${"f".repeat(7)}${SHA.slice(7)}`;
    expect(normalize("f", `_commit: ${wrong.slice(0, 7)}`)).toBe(`_commit: ${wrong.slice(0, 7)}`);
    expect(normalize("f", wrong)).toBe(wrong);
  });

  test("normalizes back-to-back occurrences, full and short", () => {
    expect(normalize("f", SHA + SHA)).toBe(SHA_SENTINEL + SHA_SENTINEL);
    expect(normalize("f", `${SHA}${SHORT} ${SHORT}`)).toBe(
      `${SHA_SENTINEL}${SHA_SENTINEL} ${SHA_SENTINEL}`,
    );
  });

  test("keeps hex that diverges from the sha, after the short and full forms", () => {
    expect(normalize("f", `${SHORT}ff`)).toBe(`${SHA_SENTINEL}ff`);
    expect(normalize("f", `${SHA}ff`)).toBe(`${SHA_SENTINEL}ff`);
  });

  test("rewrites the longest run that continues the sha, not a fixed width", () => {
    // 12 chars of true sha, then hex that diverges: the 12 are sha, the
    // tail is content.
    expect(normalize("f", `${SHA.slice(0, 12)}00`)).toBe(`${SHA_SENTINEL}00`);
  });

  test("throws on a pre-existing sentinel instead of false-matching the goldens", () => {
    expect(() => normalize("some/file", `x${SHA_SENTINEL}x`)).toThrow(
      `some/file: contains the sentinel "${SHA_SENTINEL}"`,
    );
  });
});

describe("normalizeRenderedTree", () => {
  const sha256 = (text: string) => createHash("sha256").update(text, "latin1").digest("hex");
  const MANIFEST = ".github/repo-platform-manifest.json";

  /** A minimal rendered tree in the stamp hook's own manifest dialect (one
   *  entry per line), with the sha in every hash class the hook covers: a
   *  managed file, a split file's managed half, and a symlink target. */
  const writeFixture = (root: string) => {
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".copier-answers.yml"), `_commit: ${SHORT}\n_src_path: ./tree\n`);
    writeFileSync(join(root, "notes.md"), `sha ${SHORT}\n<!-- m -->\nrepo half\n`);
    symlinkSync(`see-${SHORT}`, join(root, "link"));
    writeFileSync(
      join(root, MANIFEST),
      [
        "{",
        '  "files": {',
        `    ".copier-answers.yml": {"class": "managed", "hash": null},`,
        `    "${MANIFEST}": {"class": "managed", "hash": null, "commit": null},`,
        `    "notes.md": {"class": "split", "marker": "<!-- m -->", "managed": "above", "hash": null},`,
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

  test("normalizes every hash class and re-stamps the manifest against the result", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      writeFixture(root);
      stampFixture(root);
      normalizeRenderedTree(root, normalize);
      const answers = readFileSync(join(root, ".copier-answers.yml"), "utf-8");
      expect(answers).toBe(`_commit: ${SHA_SENTINEL}\n_src_path: ./tree\n`);
      expect(readlinkSync(join(root, "link"))).toBe(`see-${SHA_SENTINEL}`);
      const manifest = readFileSync(join(root, MANIFEST), "utf-8");
      // The managed file hashes whole normalized content, the split entry
      // its managed half (through the marker line), the symlink its target
      // - each recomputed AFTER normalization, so no hash is a function of
      // the scratch sha; the commit slot re-reads the sentinel answers.
      expect(manifest).toContain(
        `".copier-answers.yml": {"class": "managed", "hash": "${sha256(answers)}"}`,
      );
      expect(manifest).toContain(`"hash": "${sha256(`sha ${SHA_SENTINEL}\n<!-- m -->\n`)}"`);
      expect(manifest).toContain(
        `"link": {"class": "managed", "hash": "${sha256(`see-${SHA_SENTINEL}`)}"}`,
      );
      expect(manifest).toContain(
        `"${MANIFEST}": {"class": "managed", "hash": null, "commit": "${SHA_SENTINEL}"}`,
      );
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
      expect(() => normalizeRenderedTree(root, normalize)).toThrow("not honestly stamped");
      // A hook bug that stamps a wrong hash.
      writeFileSync(
        path,
        honest.replace(`"hash": "${sha256(`see-${SHORT}`)}"`, `"hash": "${"a".repeat(64)}"`),
      );
      expect(() => normalizeRenderedTree(root, normalize)).toThrow("not honestly stamped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never mangles a manifest hash that contains a prefix of the scratch sha", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      // Pick the scratch sha FROM the fixture file's hash, so the honestly
      // stamped manifest carries a 64-char hash whose first 8 chars run
      // with the sha. Substituting the manifest bytes on disk would
      // shorten that hash into a token the stamper no longer recognizes;
      // the stamper being the manifest's only writer keeps it intact.
      const notes = "just notes\n";
      const notesHash = sha256(notes);
      const sha = `${notesHash.slice(0, 8)}${"e".repeat(32)}`;
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(join(root, ".copier-answers.yml"), `_commit: ${sha.slice(0, 7)}\n`);
      writeFileSync(join(root, "notes.md"), notes);
      writeFileSync(
        join(root, MANIFEST),
        [
          "{",
          '  "files": {',
          `    ".copier-answers.yml": {"class": "managed", "hash": null},`,
          `    "${MANIFEST}": {"class": "managed", "hash": null, "commit": null},`,
          `    "notes.md": {"class": "managed", "hash": null}`,
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      stampFixture(root);
      normalizeRenderedTree(root, shaNormalizer(sha));
      const manifest = readFileSync(join(root, MANIFEST), "utf-8");
      expect(manifest).toContain(`"notes.md": {"class": "managed", "hash": "${notesHash}"}`);
      expect(manifest).toContain(`"commit": "${SHA_SENTINEL}"`);
      expect(readFileSync(join(root, ".copier-answers.yml"), "utf-8")).toBe(
        `_commit: ${SHA_SENTINEL}\n`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throws on a manifest the stamp hook reports as corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      mkdirSync(join(root, ".github"), { recursive: true });
      writeFileSync(join(root, MANIFEST), "not json");
      expect(() => normalizeRenderedTree(root, normalize)).toThrow("does not parse");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("leaves a tree without a manifest alone (nothing to re-stamp)", () => {
    const root = mkdtempSync(join(tmpdir(), "render-goldens-test-"));
    try {
      writeFileSync(join(root, "plain.txt"), "plain content\n");
      normalizeRenderedTree(root, normalize);
      expect(readFileSync(join(root, "plain.txt"), "utf-8")).toBe("plain content\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
