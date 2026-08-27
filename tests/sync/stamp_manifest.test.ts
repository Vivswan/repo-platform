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
  isMarkerLine,
  managedHalf,
  normalizeSymlinkTargets,
  recordedCommit,
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

describe("recordedCommit", () => {
  test("reads the plain, double-quoted, and single-quoted forms", () => {
    expect(recordedCommit(tree({ ".copier-answers.yml": "_commit: templates/v1.2.3\n" }))).toBe(
      "templates/v1.2.3",
    );
    expect(recordedCommit(tree({ ".copier-answers.yml": '_commit: "abc1234"\n' }))).toBe("abc1234");
    expect(recordedCommit(tree({ ".copier-answers.yml": "_commit: 'abc1234'\n" }))).toBe("abc1234");
  });
  test("a missing file or key yields null", () => {
    expect(recordedCommit(tree({}))).toBeNull();
    expect(recordedCommit(tree({ ".copier-answers.yml": "_src_path: x\n" }))).toBeNull();
  });
});

describe("stampManifestText", () => {
  test("stamps the self entry's provenance commit from the answers file", () => {
    const root = tree({ ".copier-answers.yml": "_commit: templates/v2.0.0\n_src_path: x\n" });
    const text = manifestText([
      '    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": null}',
    ]);
    const { out, problem } = stampManifestText(text, root);
    expect(problem).toBeNull();
    expect(out).toContain('"commit": "templates/v2.0.0"');
    // Hash stays null (self-hash is circular) and the stamp is idempotent.
    expect(out).toContain('"hash": null');
    expect(stampManifestText(out, root).out).toBe(out);
  });

  test("no readable _commit stamps the provenance null", () => {
    const root = tree({});
    const text = manifestText([
      '    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null, "commit": "stale"}',
    ]);
    expect(stampManifestText(text, root).out).toContain('"commit": null');
  });

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
      '    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null}',
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
    expect(files[".github/repo-platform-manifest.json"].hash).toBeNull();
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

  test("invalid JSON reports a value-free problem (no SyntaxError echo)", () => {
    // The bare identifier is the leaking form: a raw JSON.parse error
    // quotes it ('Unexpected identifier ...'), and the problem string
    // reaches the target repo's public sync log via main()'s warning.
    const text = '{"files": hiddensecret}';
    const { out, problem } = stampManifestText(text, tree({}));
    expect(out).toBe(text);
    expect(problem).toContain("invalid JSON");
    expect(problem).not.toContain("hiddensecret");
  });

  test("a parseable document without a files mapping names that shape problem", () => {
    const { out, problem } = stampManifestText('{"other": 1}', tree({}));
    expect(out).toBe('{"other": 1}');
    expect(problem).toContain("no top-level 'files' mapping");
  });

  test("a top-level JSON null stays a fail-open problem, never a crash", () => {
    // JSON.parse("null") succeeds, so this shape reaches the mapping
    // check; dereferencing it would throw past the parse catch and turn
    // the warn-and-exit-0 contract into a hard failure.
    const { out, problem } = stampManifestText("null", tree({}));
    expect(out).toBe("null");
    expect(problem).toContain("no top-level 'files' mapping");
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

  test("a duplicated entry line for one path is a soft problem, never a throw", () => {
    // Duplicate JSON keys last-win at parse time, so a duplicate line (a
    // bad conflict resolution) can flip a path's ownership class with no
    // parse error; stamping both lines would launder the flip. But this
    // must stay SOFT: the same code ships as copier's after-hook over the
    // MERGED tree, where a throw would fail the render and deliver no PR -
    // the validator's parity check reports it in a delivered PR instead.
    // The second line here has NO hash token - the starter-shaped flip.
    const root = tree({ "CLAUDE.md": "content\n" });
    const text = manifestText([
      '    "CLAUDE.md": {"class": "managed", "hash": null}',
      '    "CLAUDE.md": {"class": "starter"}',
    ]);
    let result: { out: string; problem: string | null } | undefined;
    expect(() => {
      result = stampManifestText(text, root);
    }).not.toThrow();
    expect(result?.problem).toContain('more than one entry line for "CLAUDE.md"');
    // The untouched text is emitted (out === text), so main() warns and
    // exits 0 rather than aborting the render.
    expect(result?.out).toBe(text);
  });

  test("a duplicated key with control characters stays escaped in the problem (no log injection)", () => {
    // The merged manifest is target-controlled; a decoded key carrying a
    // real newline would inject it into the public log. The raw quoted
    // form (match[2]) keeps the backslash-escape literal.
    const key = String.raw`"a\nb"`;
    const root = tree({ "x.md": "content\n" });
    const text = manifestText([
      `    ${key}: {"class": "managed", "hash": null}`,
      `    ${key}: {"class": "starter"}`,
    ]);
    const result = stampManifestText(text, root);
    expect(result.problem).toContain(String.raw`"a\nb"`);
    expect(result.problem).not.toContain("\n"); // the escape stayed literal
    expect(result.out).toBe(text);
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
    Bun.spawnSync(["readlink", join(root, path)])
      .stdout.toString()
      .trim();

  test("strips the template suffix from a manifest-listed link, idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "normalize-"));
    link(root, "CLAUDE.md", "AGENTS.md.jinja");
    const files = { "CLAUDE.md": { class: "managed" } };
    expect(normalizeSymlinkTargets(root, files)).toEqual(["CLAUDE.md"]);
    expect(readTarget(root, "CLAUDE.md")).toBe("AGENTS.md");
    // Idempotent: a second pass (the sync's extra stamp step) rewrites nothing.
    expect(normalizeSymlinkTargets(root, files)).toEqual([]);
  });

  test("never touches a link the manifest does not list, or a plain target", () => {
    const root = mkdtempSync(join(tmpdir(), "normalize-"));
    link(root, "repo-own.md", "notes.md.jinja");
    link(root, "CLAUDE.md", "AGENTS.md");
    writeFileSync(join(root, "plain.md"), "not a link\n");
    expect(
      normalizeSymlinkTargets(root, {
        "CLAUDE.md": { class: "managed" },
        "plain.md": { class: "managed" },
        "missing.md": { class: "managed" },
      }),
    ).toEqual([]);
    expect(readTarget(root, "repo-own.md")).toBe("notes.md.jinja");
    expect(readTarget(root, "CLAUDE.md")).toBe("AGENTS.md");
  });
});
