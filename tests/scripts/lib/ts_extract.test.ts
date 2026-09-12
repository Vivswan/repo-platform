import { describe, expect, test } from "bun:test";
import {
  callCarriesLiteral,
  constNumberValue,
  constRegexSource,
  constStringValue,
  intersectionCarriesType,
  moduleSpecifiers,
  parseTs,
  propertyAssignmentCarries,
  rootIdentifier,
  templateCarries,
  unwrapExpression,
} from "../../../scripts/lib/ts_extract.ts";

const anchor = { where: "f.ts", what: "the pinned fact" };

describe("constStringValue", () => {
  test("reads the single top-level const's string value, exported or not", () => {
    expect(constStringValue('const BRANCH = "build";\n', "BRANCH", anchor)).toBe("build");
    expect(constStringValue('export const BRANCH = "build";\n', "BRANCH", anchor)).toBe("build");
  });

  test("exported: true refuses an unexported declaration", () => {
    expect(() =>
      constStringValue('const NAME = "x";\n', "NAME", { ...anchor, exported: true }),
    ).toThrow("anchor for the pinned fact not found");
    expect(
      constStringValue('export const NAME = "x";\n', "NAME", { ...anchor, exported: true }),
    ).toBe("x");
  });

  test("comment, string, and template decoys are not declarations", () => {
    expect(() => constStringValue('// const BRANCH = "build";\n', "BRANCH", anchor)).toThrow(
      "found 0",
    );
    expect(() =>
      constStringValue("const doc = 'const BRANCH = \"build\";';\n", "BRANCH", anchor),
    ).toThrow("found 0");
    expect(() =>
      constStringValue('const doc = `\nconst BRANCH = "build";\n`;\n', "BRANCH", anchor),
    ).toThrow("found 0");
  });

  test("a nested (non-top-level) const is not the pinned declaration", () => {
    expect(() =>
      constStringValue('function f() {\n  const BRANCH = "build";\n}\n', "BRANCH", anchor),
    ).toThrow("found 0");
  });

  test("ambient, multi-declarator, and escape-spelled declarations are lost anchors", () => {
    // `declare const` states a type, not the value the pin reads.
    expect(() => constStringValue('export declare const NAME = "x";\n', "NAME", anchor)).toThrow(
      "found 0",
    );
    // A declarator sharing its statement is not the sole pinned home.
    expect(() => constStringValue('const OTHER = "y", NAME = "x";\n', "NAME", anchor)).toThrow(
      "found 0",
    );
    // A unicode escape COOKING to the pinned name is a decoy spelling,
    // not the declaration (names are matched raw).
    expect(() => constStringValue('export const \\u004EAME = "x";\n', "NAME", anchor)).toThrow(
      "found 0",
    );
  });

  test("let/var and non-string-literal initializers are lost anchors", () => {
    expect(() => constStringValue('let BRANCH = "build";\n', "BRANCH", anchor)).toThrow("found 0");
    expect(() => constStringValue('const BRANCH = "bu" + "ild";\n', "BRANCH", anchor)).toThrow(
      "not a plain string literal",
    );
    expect(() => constStringValue("const BRANCH = `build`;\n", "BRANCH", anchor)).toThrow(
      "not a plain string literal",
    );
  });

  test("an escaped quote is just a value to the AST", () => {
    expect(constStringValue('const NAME = "a\\"b";\n', "NAME", anchor)).toBe('a"b');
  });
});

describe("constNumberValue", () => {
  test("reads numeric literals, separator spellings included", () => {
    expect(constNumberValue("const MAX_BODY = 60_000;\n", "MAX_BODY", anchor)).toBe(60000);
    expect(constNumberValue("const N = 42;\n", "N", anchor)).toBe(42);
  });

  test("a computed or non-numeric initializer is a lost anchor", () => {
    expect(() => constNumberValue("const N = 40 + 2;\n", "N", anchor)).toThrow(
      "not a numeric literal",
    );
    expect(() => constNumberValue('const N = "42";\n', "N", anchor)).toThrow(
      "not a numeric literal",
    );
  });
});

describe("constRegexSource", () => {
  test("returns the pattern body between the slashes", () => {
    expect(constRegexSource("const RE = /^[a-z]+$/;\n", "RE", anchor)).toBe("^[a-z]+$");
    expect(constRegexSource("const RE = /a[/]b/;\n", "RE", anchor)).toBe("a[/]b");
  });

  test("flags and non-regex initializers are lost anchors", () => {
    expect(() => constRegexSource("const RE = /x/i;\n", "RE", anchor)).toThrow("regex flags");
    expect(() => constRegexSource('const RE = new RegExp("x");\n', "RE", anchor)).toThrow(
      "not a regex literal",
    );
  });
});

describe("templateCarries", () => {
  test("finds the needle in string and template literals only - comments are not references", () => {
    const needle = "contents/${path}?ref=${ref}";
    const active = "const url = `repos/${repo}/contents/${path}?ref=${ref}`;\n";
    expect(templateCarries(active, needle)).toBe(true);
    expect(templateCarries(`// ${active}`, needle)).toBe(false);
    expect(templateCarries("const url = fetchUrl(path, ref);\n", needle)).toBe(false);
  });

  test("cooked-escape decoys never match - the raw spelling is the pin", () => {
    const needle = "contents/${path}?ref=${ref}";
    // \u0024{path} COOKS to a $-brace sequence but interpolates nothing:
    // the raw token text carries the escape, so the needle cannot match.
    expect(
      templateCarries("const t = `repos/x/contents/\\u0024{path}?ref=\\u0024{ref}`;\n", needle),
    ).toBe(false);
    expect(
      templateCarries(
        "const t = `repos/${repo}/contents/\\u0024{path}?ref=\\u0024{ref}`;\n",
        needle,
      ),
    ).toBe(false);
    // An escape-spelled INTERPOLATION cooks to the pinned identifier but
    // is a different raw spelling - not the wiring the needle names.
    expect(templateCarries("const t = `x/contents/${\\u0070ath}?ref=${ref}`;\n", needle)).toBe(
      false,
    );
    expect(templateCarries("const t = `x/contents/${path}?ref=${ref}`;\n", needle)).toBe(true);
  });

  test("non-identifier interpolations cannot smuggle the needle", () => {
    const needle = "contents/${path}?ref=${ref}";
    // A plain STRING inside an interpolation carries the needle's
    // characters in its raw text; only identifier interpolations may
    // contribute to the canonical, so it never matches.
    expect(templateCarries('const doc = `${"contents/${path}?ref=${ref}"}`;\n', needle)).toBe(
      false,
    );
    expect(templateCarries("const t = `x/contents/${a.path}?ref=${ref}`;\n", needle)).toBe(false);
    // A NESTED template inside a discarded interpolation is that
    // interpolation's code, not standalone wiring.
    expect(templateCarries("const x = `${void `x/contents/${path}?ref=${ref}`}`;\n", needle)).toBe(
      false,
    );
  });
});

describe("parseTs refuses recovered trees", () => {
  test("a source with syntax errors throws at the shared parse entry, for every extractor", () => {
    const broken = 'const BRANCH = "build;\n';
    expect(() => parseTs(broken)).toThrow("unauditable");
    expect(() => constStringValue(broken, "BRANCH", anchor)).toThrow("unauditable");
    expect(() => templateCarries(broken, "x")).toThrow("unauditable");
    expect(() => moduleSpecifiers(broken)).toThrow("unauditable");
  });
});

describe("intersectionCarriesType and propertyAssignmentCarries", () => {
  test("finds the intersection member and the exact property wiring", () => {
    const source = [
      "export type Target = { repo: string } & RedactionState;",
      "const t = { hide_details: row.hide_details };",
    ].join("\n");
    expect(intersectionCarriesType(source, "RedactionState")).toBe(true);
    expect(propertyAssignmentCarries(source, "hide_details", "row.hide_details")).toBe(true);
  });

  test("comment and string decoys, and drifted wiring, do not count", () => {
    const decoys = [
      "// type T = { a: 1 } & RedactionState;",
      'const doc = "hide_details: row.hide_details";',
      "const t = { hide_details: false };",
    ].join("\n");
    expect(intersectionCarriesType(decoys, "RedactionState")).toBe(false);
    expect(propertyAssignmentCarries(decoys, "hide_details", "row.hide_details")).toBe(false);
  });
});

describe("callCarriesLiteral", () => {
  test("finds the call by callee and literal first argument; comments, strings, and other literals do not count", () => {
    const source = [
      '// setOutput("release-cut", "true");',
      "const doc = 'setOutput(\"release-cut\", x)';",
      'setOutput("other", "true");',
      'other("release-cut", "true");',
      '(setOutput)("release-cut", pr === undefined ? "false" : "true");',
    ].join("\n");
    expect(callCarriesLiteral(source, "setOutput", "release-cut")).toBe(true);
    expect(
      callCarriesLiteral(source.split("\n").slice(0, 4).join("\n"), "setOutput", "release-cut"),
    ).toBe(false);
  });
});

describe("unwrapExpression and rootIdentifier", () => {
  test("wrappers unwrap and chains bottom out on their root identifier", () => {
    const sf = parseTs("const x = ((Bun))!.spawnSync(cmd).stdout;\n");
    const initializer = sf.getVariableDeclarations()[0].getInitializer();
    if (initializer === undefined) throw new Error("fixture lost its initializer");
    expect(rootIdentifier(initializer)).toBe("Bun");
    expect(unwrapExpression(initializer).getKindName()).toBe("PropertyAccessExpression");
  });

  test("a chain rooted elsewhere is not the receiver", () => {
    const sf = parseTs("const x = fakeBun.spawnSync(cmd);\n");
    const initializer = sf.getVariableDeclarations()[0].getInitializer();
    if (initializer === undefined) throw new Error("fixture lost its initializer");
    expect(rootIdentifier(initializer)).toBe("fakeBun");
  });
});
