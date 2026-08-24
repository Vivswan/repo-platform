// Unit tests for the manifest stamper: in-place hash substitution on the
// rendered one-entry-per-line layout, the split-half and symlink hashing
// rules, the self-entry exclusion, conflict-block resolution toward the
// template side, and the warn-don't-fail contract on unparseable input.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  entryHash,
  managedHalf,
  resolveConflictsTowardAfter,
  stampManifestText,
} from "../../.github/scripts/sync/stamp_manifest";

function sha256(data: string): string {
  return new Bun.CryptoHasher("sha256").update(Buffer.from(data, "latin1")).digest("hex");
}

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "stamp-manifest-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

function manifestText(entries: string[]): string {
  return `{\n  "$comment": "test",\n  "files": {\n${entries.join(",\n")}\n  }\n}\n`;
}

describe("managedHalf", () => {
  const content = "top\n# repo-platform:local-section\ntail\n";
  test("above covers through the marker line's newline", () => {
    expect(managedHalf(content, "# repo-platform:local-section", "above")).toBe(
      "top\n# repo-platform:local-section\n",
    );
  });
  test("below covers from the marker line to end of file", () => {
    expect(managedHalf(content, "# repo-platform:local-section", "below")).toBe(
      "# repo-platform:local-section\ntail\n",
    );
  });
  test("an indented marker line matches by trimmed content", () => {
    expect(managedHalf("a\n  # m\nb", "# m", "above")).toBe("a\n  # m\n");
  });
  test("a marker at end of file without a trailing newline stays in bounds", () => {
    expect(managedHalf("a\n# m", "# m", "above")).toBe("a\n# m");
  });
  test("a missing marker returns null", () => {
    expect(managedHalf(content, "# other", "above")).toBeNull();
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
  test("passes marker-free text through unchanged", () => {
    expect(resolveConflictsTowardAfter("a\nb\n")).toBe("a\nb\n");
  });
  test("a bare ======= outside a block is ordinary content", () => {
    expect(resolveConflictsTowardAfter("a\n=======\nb")).toBe("a\n=======\nb");
  });
  test("malformed blocks return the text unchanged instead of guessing", () => {
    // Unterminated block (no separator, no end).
    const unterminated = "a\n<<<<<<< before updating\nlocal\nb";
    expect(resolveConflictsTowardAfter(unterminated)).toBe(unterminated);
    // Separator never arrives before the end marker.
    const noSeparator = ["<<<<<<< before updating", "local", ">>>>>>> after updating"].join("\n");
    expect(resolveConflictsTowardAfter(noSeparator)).toBe(noSeparator);
    // An end marker outside any block.
    const strayEnd = "a\n>>>>>>> after updating\nb";
    expect(resolveConflictsTowardAfter(strayEnd)).toBe(strayEnd);
    // A nested start inside a block.
    const nested = [
      "<<<<<<< before updating",
      "<<<<<<< before updating",
      "=======",
      "x",
      ">>>>>>> after updating",
    ].join("\n");
    expect(resolveConflictsTowardAfter(nested)).toBe(nested);
    // A second separator inside the template side.
    const doubleSep = [
      "<<<<<<< before updating",
      "local",
      "=======",
      "x",
      "=======",
      "y",
      ">>>>>>> after updating",
    ].join("\n");
    expect(resolveConflictsTowardAfter(doubleSep)).toBe(doubleSep);
  });
  test("non-copier conflict labels are not treated as markers", () => {
    const gitStyle = ["<<<<<<< HEAD", "local", "=======", "theirs", ">>>>>>> main"].join("\n");
    expect(resolveConflictsTowardAfter(gitStyle)).toBe(gitStyle);
  });
});

describe("stampManifestText", () => {
  test("stamps managed, split, and symlink entries and leaves the rest", () => {
    const root = tree({
      "ci.yml": "managed content\n",
      "SECURITY.md": "managed top\n<!-- repo-platform:local-section -->\nrepo tail\n",
    });
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    const text = manifestText([
      '    "CLAUDE.md": {"class": "managed", "hash": null}',
      '    "SECURITY.md": {"class": "split", "marker": "<!-- repo-platform:local-section -->", "managed": "above", "hash": null}',
      '    "checks.yml": {"class": "starter"}',
      '    "ci.yml": {"class": "managed", "hash": null}',
      '    ".repo-platform-manifest.json": {"class": "managed", "hash": null}',
    ]);
    const { out, problem } = stampManifestText(text, root);
    expect(problem).toBeNull();
    const files = (JSON.parse(out) as { files: Record<string, { hash?: string | null }> }).files;
    expect(files["ci.yml"].hash).toBe(sha256("managed content\n"));
    expect(files["SECURITY.md"].hash).toBe(
      sha256("managed top\n<!-- repo-platform:local-section -->\n"),
    );
    expect(files["CLAUDE.md"].hash).toBe(sha256("AGENTS.md"));
    expect(files["checks.yml"].hash).toBeUndefined();
    // The self entry stays null: the manifest's content includes every
    // other hash, so a self-hash would be circular.
    expect(files[".repo-platform-manifest.json"].hash).toBeNull();
    // Only hash tokens change: nulling them back restores the input.
    expect(out.replace(/"hash": "[0-9a-f]{64}"/g, '"hash": null')).toBe(text);
  });

  test("is idempotent and re-stamps a stale hash", () => {
    const root = tree({ "ci.yml": "new content\n" });
    const stale = manifestText([`    "ci.yml": {"class": "managed", "hash": "${"0".repeat(64)}"}`]);
    const once = stampManifestText(stale, root).out;
    expect(once).toContain(`"hash": "${sha256("new content\n")}"`);
    expect(stampManifestText(once, root).out).toBe(once);
  });

  test("a missing file or missing split marker stamps null", () => {
    const root = tree({ "split.md": "no marker here\n" });
    const text = manifestText([
      `    "gone.yml": {"class": "managed", "hash": "${"a".repeat(64)}"}`,
      '    "split.md": {"class": "split", "marker": "# repo-platform:local-section", "managed": "above", "hash": null}',
    ]);
    const files = (
      JSON.parse(stampManifestText(text, root).out) as {
        files: Record<string, { hash?: string | null }>;
      }
    ).files;
    expect(files["gone.yml"].hash).toBeNull();
    expect(files["split.md"].hash).toBeNull();
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
    const { out, problem } = stampManifestText(text, root);
    expect(problem).toBeNull();
    const files = (JSON.parse(out) as { files: Record<string, unknown> }).files;
    expect(Object.keys(files)).toEqual(["ci.yml"]);
    expect(out).toContain(`"hash": "${sha256("content\n")}"`);
  });

  test("unparseable input returns the text unchanged with a problem", () => {
    const { out, problem } = stampManifestText("not json", tree({}));
    expect(out).toBe("not json");
    expect(problem).toMatch(/does not parse/);
  });

  test("a malformed conflict block is a problem, never a silent line drop", () => {
    const root = tree({ "ci.yml": "content\n" });
    const text = [
      "{",
      '  "files": {',
      "<<<<<<< before updating",
      '    "ci.yml": {"class": "managed", "hash": null}',
      "  }",
      "}",
    ].join("\n");
    const { out, problem } = stampManifestText(text, root);
    expect(out).toBe(text);
    expect(problem).toMatch(/does not parse/);
  });
});

describe("entryHash", () => {
  test("hashes whole content for managed and the half for split", () => {
    const root = tree({ "f.md": "a\n# m\nb\n" });
    expect(entryHash(root, "f.md", { class: "managed" })).toBe(sha256("a\n# m\nb\n"));
    expect(entryHash(root, "f.md", { class: "split", marker: "# m", managed: "below" })).toBe(
      sha256("# m\nb\n"),
    );
  });
  test("malformed split metadata yields null rather than a wrong hash", () => {
    const root = tree({ "f.md": "a\n" });
    expect(entryHash(root, "f.md", { class: "split", marker: 3, managed: "above" })).toBeNull();
  });
});
