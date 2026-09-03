// Unit tests for the manifest stamper: in-place hash substitution on the
// rendered one-entry-per-line layout, the split-region and symlink hashing
// rules, the self-entry exclusion, conflict-block resolution toward the
// template side, and the warn-don't-fail contract on unparseable input.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isMarkerLine, splitManagedRegion } from "../../actions/shared/grammar";
import { parseManifestFiles, resolveConflictsTowardAfter } from "../../actions/shared/manifest";
import {
  describeRewritten,
  entryHash,
  normalizeFromText,
  normalizeSymlinkTargets,
  recordedCommit,
  stampManifestText,
} from "../../actions/shared/stamp_manifest";
import { boundedSpawnSync } from "../shared/bounded_spawn";

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

describe("splitManagedRegion", () => {
  const markers = { begin: "# b", end: "# e" };
  const content = "above\n# b\nmanaged\n# e\nbelow\n";
  test("slices above, region (markers included), and below", () => {
    expect(splitManagedRegion(content, markers)).toEqual({
      above: "above\n",
      region: "# b\nmanaged\n# e\n",
      below: "below\n",
    });
  });
  test("an indented marker line matches by trimmed content", () => {
    expect(splitManagedRegion("a\n  # b\nx\n# e\nz\n", markers)?.region).toBe("  # b\nx\n# e\n");
  });
  test("an END at end of file without a trailing newline stays in bounds", () => {
    expect(splitManagedRegion("# b\nx\n# e", markers)).toEqual({
      above: "",
      region: "# b\nx\n# e",
      below: "",
    });
  });
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

describe("stampManifestText", () => {
  test("stamps the self entry's provenance commit from the answers file", () => {
    const root = tree({
      ".github/.copier-answers.yml": "_commit: templates/v2.0.0\n_src_path: x\n",
    });
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
      "SECURITY.md":
        "repo preamble\n<!-- BEGIN REPO-PLATFORM MANAGED -->\nmanaged\n<!-- END REPO-PLATFORM MANAGED -->\nrepo tail\n",
    });
    symlinkSync("AGENTS.md", join(root, "CLAUDE.md"));
    const text = manifestText([
      '    "CLAUDE.md": {"class": "managed", "hash": null}',
      '    "SECURITY.md": {"class": "split", "grammar": "managed-region", "begin": "<!-- BEGIN REPO-PLATFORM MANAGED -->", "end": "<!-- END REPO-PLATFORM MANAGED -->", "hash": null}',
      '    "checks.yml": {"class": "starter"}',
      '    "ci.yml": {"class": "managed", "hash": null}',
      '    ".github/repo-platform-manifest.json": {"class": "managed", "hash": null}',
    ]);
    const { out, problem } = stampManifestText(text, root);
    expect(problem).toBeNull();
    const files = (JSON.parse(out) as { files: Record<string, { hash?: string | null }> }).files;
    expect(files["ci.yml"].hash).toBe(sha256("managed content\n"));
    expect(files["SECURITY.md"].hash).toBe(
      sha256("<!-- BEGIN REPO-PLATFORM MANAGED -->\nmanaged\n<!-- END REPO-PLATFORM MANAGED -->\n"),
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

  test("a missing file or missing split markers stamps null", () => {
    const root = tree({ "split.md": "no markers here\n" });
    const text = manifestText([
      `    "gone.yml": {"class": "managed", "hash": "${"a".repeat(64)}"}`,
      '    "split.md": {"class": "split", "grammar": "managed-region", "begin": "# b", "end": "# e", "hash": null}',
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
    expect(result?.problem).toContain("binds a key more than once");
    // The untouched text is emitted (out === text), so main() warns and
    // exits 0 rather than aborting the render.
    expect(result?.out).toBe(text);
  });

  test("a duplicated key never reaches the problem string (value-free, no log leak)", () => {
    // The merged manifest is target-controlled and manifest keys are
    // target-repo paths: naming the duplicated key would print a PRIVATE
    // repo's path (or inject control bytes) into the public sync log, so
    // the problem states only that a duplicate exists.
    const key = String.raw`"SECRET-private/path\nleak.md"`;
    const root = tree({ "x.md": "content\n" });
    const text = manifestText([
      `    ${key}: {"class": "managed", "hash": null}`,
      `    ${key}: {"class": "starter"}`,
    ]);
    const result = stampManifestText(text, root);
    expect(result.problem).toContain("binds a key more than once");
    expect(result.problem).not.toContain("SECRET");
    expect(result.problem).not.toContain("\n");
    expect(result.out).toBe(text);
  });
});

describe("entryHash", () => {
  test("hashes whole content for managed and the region for split", () => {
    const root = tree({ "f.md": "a\n# b\nx\n# e\nz\n" });
    expect(entryHash(root, "f.md", { class: "managed" })).toBe(sha256("a\n# b\nx\n# e\nz\n"));
    expect(entryHash(root, "f.md", { class: "split", begin: "# b", end: "# e" })).toBe(
      sha256("# b\nx\n# e\n"),
    );
  });
  test("malformed split metadata yields null rather than a wrong hash", () => {
    const root = tree({ "f.md": "a\n" });
    expect(entryHash(root, "f.md", { class: "split", begin: 3, end: "# e" })).toBeNull();
  });
  test("duplicated or reordered markers stamp null, never an ambiguous first slice", () => {
    // The strict slicer (cleanManagedRegion) is the stamper's own
    // accept/reject: an ambiguous region has no honest hash, and the
    // validator's parity check reports the unstamped entry.
    const dup = tree({ "f.md": "# b\nx\n# e\n# b\ny\n# e\n" });
    expect(entryHash(dup, "f.md", { class: "split", begin: "# b", end: "# e" })).toBeNull();
    const reordered = tree({ "f.md": "# e\nx\n# b\n" });
    expect(entryHash(reordered, "f.md", { class: "split", begin: "# b", end: "# e" })).toBeNull();
    // A mid-line mention counts as a duplicate too (substring rule).
    const buried = tree({ "f.md": "see # b here\n# b\nx\n# e\n" });
    expect(entryHash(buried, "f.md", { class: "split", begin: "# b", end: "# e" })).toBeNull();
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
    const root = mkdtempSync(join(tmpdir(), "normalize-"));
    link(root, "CLAUDE.md", "AGENTS.md.jinja");
    const files = { "CLAUDE.md": { class: "managed" } };
    expect(normalizeSymlinkTargets(root, files)).toEqual(["CLAUDE.md"]);
    expect(readTarget(root, "CLAUDE.md")).toBe("AGENTS.md");
    // Idempotent: a second pass (the sync's extra stamp step) rewrites nothing.
    expect(normalizeSymlinkTargets(root, files)).toEqual([]);
  });

  test("never touches a link the manifest does not list, a non-managed class, or a plain target", () => {
    const root = mkdtempSync(join(tmpdir(), "normalize-"));
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
    const outside = mkdtempSync(join(tmpdir(), "normalize-outside-"));
    link(outside, "victim.md", "prey.md.jinja");
    const root = mkdtempSync(join(tmpdir(), "normalize-root-"));
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

  test("a duplicated manifest normalizes NOTHING (rejected before any mutation)", () => {
    // Duplicate JSON keys last-win at parse, so a duplicate line can flip
    // a path's class to managed; acting on the parsed value would then
    // rewrite a link the honest manifest never managed. The parse gate
    // must fire before the mutation, leaving the link untouched.
    const root = mkdtempSync(join(tmpdir(), "normalize-dup-"));
    symlinkSync("notes.md.jinja", join(root, "CLAUDE.md"));
    const text = manifestOf(
      '    "CLAUDE.md": {"class": "starter"},\n    "CLAUDE.md": {"class": "managed", "hash": null}',
    );
    const { rewritten, problem } = normalizeFromText(text, root);
    expect(rewritten).toEqual([]);
    expect(problem).toContain("more than once");
    // The mutation never happened: the link still carries its suffix.
    expect(readTarget(root, "CLAUDE.md")).toBe("notes.md.jinja");
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
    const parsed = parseManifestFiles(text);
    expect(parsed.problem).toBeNull();
    expect(Object.keys(parsed.files ?? {}).sort()).toEqual(["$comment", "files"]);
  });

  test("duplicates are found STRUCTURALLY: mixed value shapes and re-indented lines all count", () => {
    // "x": null on one line plus a valid object on another: JSON.parse
    // last-wins to the valid object (so the shape check passes), and a
    // scan reading only well-formed entry lines - or only canonically
    // indented ones - would miss it. The structural walk counts the files
    // object's direct child keys wherever and however they appear.
    const root = mkdtempSync(join(tmpdir(), "normalize-dup-mixed-"));
    symlinkSync("notes.md.jinja", join(root, "CLAUDE.md"));
    for (const filesBody of [
      // Mixed shapes at canonical indent.
      '    "CLAUDE.md": null,\n    "CLAUDE.md": {"class": "managed", "hash": null}',
      // A re-indented merge artifact (two spaces on the null line).
      '  "CLAUDE.md": null,\n    "CLAUDE.md": {"class": "managed", "hash": null}',
      // Both keys on ONE line.
      '    "CLAUDE.md": null, "CLAUDE.md": {"class": "managed", "hash": null}',
    ]) {
      const { rewritten, problem } = normalizeFromText(manifestOf(filesBody), root);
      expect(rewritten).toEqual([]);
      expect(problem).toContain("more than once");
      expect(readTarget(root, "CLAUDE.md")).toBe("notes.md.jinja");
    }
  });

  test("a duplicated top-level files mapping is the same corruption one level up", () => {
    // JSON.parse last-wins on the OUTER key too: two "files" objects would
    // let the second swap the whole entry set while a walk of the first
    // saw nothing wrong. Scopes are tracked per object, so the duplicate
    // root-level binding is caught like any other - and nothing is mutated.
    const root = mkdtempSync(join(tmpdir(), "normalize-dup-outer-"));
    symlinkSync("notes.md.jinja", join(root, "CLAUDE.md"));
    const text =
      '{"files":{"safe.md":{"class":"starter"}},"files":{"CLAUDE.md":{"class":"managed","hash":null}}}';
    const { rewritten, problem } = normalizeFromText(text, root);
    expect(rewritten).toEqual([]);
    expect(problem).toContain("binds a key more than once");
    expect(readTarget(root, "CLAUDE.md")).toBe("notes.md.jinja");
  });

  test("rewritten paths are JSON-quoted in the log line (no control-byte injection)", () => {
    // Manifest keys are target-controlled: a decoded path carrying a
    // newline could forge workflow commands in the Actions log. The
    // describeRewritten line must keep every escape literal.
    const evil = "evil\n::error::forged.md";
    const line = describeRewritten([evil, "plain.md"]);
    expect(line).not.toContain("\n");
    expect(line).toContain(String.raw`"evil\n::error::forged.md"`);
    expect(line).toContain('"plain.md"');
  });
});
