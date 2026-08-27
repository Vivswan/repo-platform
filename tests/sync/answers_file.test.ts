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
    const answers = read("_commit: abc1234\nprivate: true\n");
    expect(answers.commit).toBe("abc1234");
    expect(answers.fields.private).toBe(true);
  });

  test("undoes copier's to_nice_yaml quoting of a digit-only short sha", () => {
    expect(read("_commit: '1234567'\n").commit).toBe("1234567");
    expect(read("_commit: 1234567\n").commit).toBe("1234567");
  });

  test("bare short shas that are YAML 1.2 numbers come back verbatim", () => {
    // PyYAML (copier's writer) leaves these bare; the default YAML 1.2
    // schema would read them as numbers ("89012", "1.626e+56", "Infinity",
    // "0") and the sync would resolve or reject a value that appears
    // nowhere in the file.
    for (const sha of ["0089012", "1626e53", "791e558", "0e50454"]) {
      expect(read(`_commit: ${sha}\n`).commit).toBe(sha);
    }
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
    expect(out).toContain("project_name: 1e3\n");
    expect(out).toContain("copyright_holder: no\n");
    expect(out).toContain("auto_merge: on\n");
    expect(out).toContain("tracking_label: 0123\n");
    expect(out).toContain("description: plain text\n");
    expect(out).toContain("private: false\n");
    // Copier's own metadata never reaches a data file.
    expect(out).not.toContain("_commit");
    expect(out).not.toContain("_src_path");
  });

  test("quoting styles survive (a quoted string must stay a string to PyYAML)", () => {
    expect(dataFileYaml("single: '007'\ndouble: \"1e3\"\n", null)).toBe(
      "single: '007'\ndouble: \"1e3\"\n",
    );
  });

  test("live keys drop from the carried document and re-emit exactly once", () => {
    const out = dataFileYaml(
      "description: recorded\nmodules:\n  - agents\nprivate: true\nkeep: me\n",
      { modules: ["uv", "agents"], private: false, description: "live one" },
    );
    expect(out).toContain("keep: me\n");
    expect(out).toContain('modules:\n  - "uv"\n  - "agents"\n');
    expect(out).toContain("private: false\n");
    expect(out).toContain('description: "live one"\n');
    expect(out).not.toContain("recorded");
    expect(out).not.toContain("- agents\n"); // only the quoted live list remains
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

  test("PyYAML-special characters in live values are escaped, not emitted raw", () => {
    // JSON.stringify leaves NEL/LS/PS and DEL raw; YAML 1.1 folds the
    // breaks and rejects the non-printables, so they must leave as \uXXXX.
    const nel = String.fromCharCode(0x85);
    const ls = String.fromCharCode(0x2028);
    const del = String.fromCharCode(0x7f);
    const out = dataFileYaml("keep: x\n", {
      modules: [`a${nel}b`],
      private: false,
      description: `line${nel}break${ls}and${del}del`,
    });
    expect(out).not.toContain(nel);
    expect(out).not.toContain(ls);
    expect(out).not.toContain(del);
    expect(out).toContain("\\u0085");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u007f");
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

  test("non-characters in live values are escaped, not emitted raw", () => {
    const out = dataFileYaml("keep: x\n", {
      modules: [],
      private: false,
      description: `a${String.fromCharCode(0xfffe)}b`,
    });
    expect(out).toContain("\\ufffe");
    expect(out).not.toContain(String.fromCharCode(0xfffe));
  });

  test("quote and backslash in live values stay JSON-escaped", () => {
    const out = dataFileYaml("keep: x\n", {
      modules: [],
      private: false,
      description: 'quote " and \\ back',
    });
    expect(out).toContain('description: "quote \\" and \\\\ back"\n');
  });

  test("a description PyYAML would re-type stays the exact string", () => {
    const out = dataFileYaml("keep: x\n", { modules: [], private: false, description: "no" });
    expect(out).toContain('description: "no"\n');
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
