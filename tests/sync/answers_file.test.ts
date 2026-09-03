import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  AnswersFileError,
  dataFileYaml,
  readAnswersFile,
} from "../../.github/scripts/sync/answers_file.ts";

function read(content: string) {
  const path = join(mkdtempSync(join(tmpdir(), "answers-file-")), "answers.yml");
  writeFileSync(path, content);
  return readAnswersFile(path);
}

describe("readAnswersFile", () => {
  test("parses commit and keeps every field for other consumers", () => {
    expect(read("_commit: abc1234\nprivate: true\n")).toEqual({
      commit: "abc1234",
      fields: { _commit: "abc1234", private: true },
    });
  });

  // PyYAML (copier's writer) leaves short shas bare unless to_nice_yaml
  // quoted a digit-only one; the default YAML 1.2 schema would read the
  // bare ones as numbers ("89012", "1.626e+56", "Infinity", "0") and the
  // sync would resolve or reject a value that appears nowhere in the file.
  test.each([
    { text: "'1234567'", sha: "1234567", reason: "to_nice_yaml's quoting of a digit-only sha" },
    { text: "1234567", sha: "1234567", reason: "bare digit-only sha reads as an int" },
    { text: "0089012", sha: "0089012", reason: "an int read drops the leading zeros" },
    { text: "1626e53", sha: "1626e53", reason: "float-looking: 1.626e+56 under YAML 1.2" },
    { text: "791e558", sha: "791e558", reason: "float-looking: overflows to Infinity" },
    { text: "0e50454", sha: "0e50454", reason: "float-looking: collapses to 0" },
  ])("_commit $text comes back as the verbatim sha ($reason)", ({ text, sha }) => {
    expect(read(`_commit: ${text}\n`).commit).toBe(sha);
  });

  test("an absent or non-scalar _commit is empty (the caller fails it loudly)", () => {
    expect(read("private: true\n").commit).toBe("");
    expect(read("_commit: [a, b]\n").commit).toBe("");
  });

  test("a non-mapping top level throws AnswersFileError", () => {
    expect(() => read("- just\n- a\n- list\n")).toThrow(AnswersFileError);
    expect(() => read("")).toThrow("top level must be a mapping");
  });

  test("unparseable YAML throws AnswersFileError naming the parse failure", () => {
    expect(() => read("a: [\n")).toThrow(AnswersFileError);
    expect(() => read("a: [\n")).toThrow("cannot read as YAML");
  });
});

describe("dataFileYaml", () => {
  const LIVE = { modules: ["uv"], private: true, description: "live" } as const;
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const DEL = String.fromCharCode(0x7f);

  // The hazard this passthrough exists for, proven on the real parser the
  // old code used: the yaml package's default YAML 1.2 schema re-types
  // scalars PyYAML (copier's reader AND the data-file's eventual parser)
  // keeps as strings - a value-level round trip through it hands copier
  // different data than `copier update` computed from the same answers.
  test("the default-schema divergence is real (the re-dump hazard)", () => {
    expect(parse("project_name: 1e3").project_name).toBe(1000);
    expect(parse("_commit: 1626e53")._commit).toBe(1.626e56);
  });

  test("scalars ride through verbatim: 1e3, bare shas, YAML 1.1 booleans, leading zeros", () => {
    const out = dataFileYaml(
      [
        "_commit: 1626e53",
        "_src_path: gh:Vivswan/repo-platform.git",
        "project_name: 1e3",
        "copyright_holder: no",
        "auto_merge: on",
        "tracking_label: 0123",
        "description: plain text",
        "private: false",
      ]
        .map((line) => `${line}\n`)
        .join(""),
      null,
    );
    // Plain stays plain: PyYAML must parse each value exactly as it parses
    // the answers file itself (1e3 a string, no/on the 1.1 booleans, 0123
    // the 1.1 octal) - quoting any of them would change copier's parse.
    // Copier's own metadata (_commit, _src_path) never reaches a data file.
    expect(out).toBe(
      "project_name: 1e3\ncopyright_holder: no\nauto_merge: on\ntracking_label: 0123\ndescription: plain text\nprivate: false\n",
    );
  });

  test("quoting styles survive (a quoted string must stay a string to PyYAML)", () => {
    expect(dataFileYaml("single: '007'\ndouble: \"1e3\"\n", null)).toBe(
      "single: '007'\ndouble: \"1e3\"\n",
    );
  });

  test("live keys drop from the carried document and re-emit exactly once", () => {
    // The recorded description, list, and flag are gone; the carried key
    // stays first; the live values follow in one pass, quoted.
    expect(
      dataFileYaml("description: recorded\nmodules:\n  - agents\nprivate: true\nkeep: me\n", {
        modules: ["uv", "agents"],
        private: false,
        description: "live one",
      }),
    ).toBe('keep: me\nmodules:\n  - "uv"\n  - "agents"\nprivate: false\ndescription: "live one"\n');
  });

  test("metadata-only answers yield an explicit empty mapping, never a null document", () => {
    // PyYAML loads an empty file as None and copier crashes iterating it.
    expect(dataFileYaml("_commit: abc\n", null)).toBe("{}\n");
  });

  test("live values append cleanly when nothing is carried", () => {
    expect(dataFileYaml("_commit: abc\n", { modules: [], private: true, description: "" })).toBe(
      'modules: []\nprivate: true\ndescription: ""\n',
    );
  });

  test("a document-end marker cannot strand the appended live keys", () => {
    // `...` survives doc.toString(), so naive concatenation would place
    // the live keys after the document end; the postcondition refuses.
    expect(() => dataFileYaml("keep: x\n...\n", LIVE)).toThrow(AnswersFileError);
    expect(() => dataFileYaml("keep: x\n...\n", LIVE)).toThrow(/cannot be carried/);
    // Without live keys nothing is appended, so the shape is fine as-is.
    expect(dataFileYaml("keep: x\n...\n", null)).toBe("keep: x\n...\n");
  });

  test("an alias whose anchor was filtered fails typed and value-free", () => {
    // The emitter's own error names the target-controlled anchor; the
    // typed wrapper must not echo it.
    const text = "_meta: &secretanchor v\nkeep: *secretanchor\n";
    expect(() => dataFileYaml(text, null)).toThrow(AnswersFileError);
    try {
      dataFileYaml(text, null);
    } catch (err) {
      expect((err as Error).message).not.toContain("secretanchor");
    }
  });

  // Live values leave as JSON-escaped double-quoted scalars. JSON.stringify
  // leaves NEL/LS/PS, DEL, and the non-characters raw, and YAML 1.1 folds
  // the breaks and rejects the non-printables, so those must leave as
  // \uXXXX; PyYAML would re-type a bare `no`, so the quotes must stay.
  // Whole-document equality also proves the raw characters are absent.
  test.each([
    {
      reason: "NEL, LS, and DEL are escaped, not emitted raw",
      modules: [`a${NEL}b`],
      description: `line${NEL}break${LS}and${DEL}del`,
      emitted:
        'modules:\n  - "a\\u0085b"\nprivate: false\ndescription: "line\\u0085break\\u2028and\\u007fdel"\n',
    },
    {
      reason: "the non-character U+FFFE is escaped",
      modules: [],
      description: `a${String.fromCharCode(0xfffe)}b`,
      emitted: 'modules: []\nprivate: false\ndescription: "a\\ufffeb"\n',
    },
    {
      reason: "quote and backslash stay JSON-escaped",
      modules: [],
      description: 'quote " and \\ back',
      emitted: 'modules: []\nprivate: false\ndescription: "quote \\" and \\\\ back"\n',
    },
    {
      reason: "a description PyYAML would re-type stays the exact string",
      modules: [],
      description: "no",
      emitted: 'modules: []\nprivate: false\ndescription: "no"\n',
    },
  ])("live values are emitted escaped: $reason", ({ modules, description, emitted }) => {
    expect(dataFileYaml("keep: x\n", { modules, private: false, description })).toBe(
      `keep: x\n${emitted}`,
    );
  });

  test("a carried scalar PyYAML wrote escaped refuses rather than re-emitting raw", () => {
    // The npm emitter targets YAML 1.2 and re-emits the decoded DEL/NEL
    // RAW, which PyYAML then rejects (DEL) or folds (NEL) - so the
    // assembly must fail closed instead of delivering a diverging file.
    expect(() => dataFileYaml('desc: "a\\x7Fb"\n', null)).toThrow(AnswersFileError);
    expect(() => dataFileYaml('desc: "a\\x7Fb"\n', null)).toThrow(/cannot ride a data file/);
    expect(() => dataFileYaml('desc: "a\\u0085b"\n', null)).toThrow(/cannot ride a data file/);
  });

  test("an escape-hidden lone surrogate is refused on the DECODED value", () => {
    // JSON.stringify and the yaml emitter both keep a lone surrogate as a
    // plain-ASCII backslash-u escape, so a serialized-text scan alone
    // fails open - PyYAML decodes the escape into a value Python cannot
    // encode to UTF-8 and copier crashes mid-render.
    const carried = 'desc: "a\\ud800b"\n';
    expect(() => dataFileYaml(carried, null)).toThrow(AnswersFileError);
    expect(() => dataFileYaml(carried, null)).toThrow(/lone surrogate/);
    // A live value carrying an ACTUAL lone surrogate is refused the same
    // way (its JSON escape decodes right back).
    expect(() =>
      dataFileYaml("keep: x\n", {
        modules: [],
        private: false,
        description: `a${String.fromCharCode(0xd800)}b`,
      }),
    ).toThrow(/lone surrogate/);
  });

  test("literal backslash-u text as CONTENT is not a surrogate (no false positive)", () => {
    // Single quotes make the seven characters backslash-u-d-8-0-0 literal
    // content; decoded they stay ASCII and must ride through verbatim.
    const literal = "desc: 'a\\ud800b'\n";
    expect(dataFileYaml(literal, null)).toBe(literal);
  });

  test("a carried LS/PS escape is NOT refused (PyYAML preserves the raw character)", () => {
    // Verified against PyYAML 6.0.3: raw U+2028/U+2029 in a double-quoted
    // scalar parse identically to their escapes, so re-emitting them raw
    // does not diverge and refusing would false-reject.
    const out = dataFileYaml('desc: "a\\u2028b"\n', null);
    expect(out).toContain(String.fromCharCode(0x2028));
  });

  test("astral characters in carried and live values are not false positives", () => {
    // Surrogate PAIRS are fine to PyYAML; only LONE surrogates and the
    // non-characters are refused.
    const emoji = "\u{1f680}";
    expect(dataFileYaml(`desc: "rocket ${emoji}"\n`, null)).toContain(emoji);
    const out = dataFileYaml("keep: x\n", {
      modules: [],
      private: false,
      description: `go ${emoji}`,
    });
    expect(out).toContain(emoji);
  });

  test("a non-mapping top level throws AnswersFileError", () => {
    expect(() => dataFileYaml("- a\n- list\n", null)).toThrow(AnswersFileError);
    expect(() => dataFileYaml("", null)).toThrow("top level must be a mapping");
  });

  test("unparseable YAML throws AnswersFileError", () => {
    expect(() => dataFileYaml("a: [\n", null)).toThrow("cannot read as YAML");
  });

  test("a collection key is refused, never guessed at", () => {
    expect(() => dataFileYaml("[a, b]: value\n", null)).toThrow(
      "top-level keys must be plain scalars",
    );
  });
});
