// Unit tests for the AST extraction module the SSOT rules read TypeScript
// sources through: each helper's positive shape, and the decoy classes
// the AST makes unrepresentable - a look-alike in a comment, a string, or
// a template is not a node, so it can neither satisfy an anchor nor mask
// a lost one.

import { describe, expect, test } from "bun:test";
import {
  argvFlagLeads,
  argvStringAfter,
  constNumberValue,
  constRegexSource,
  constStringValue,
  intersectionCarriesType,
  literalMatches,
  parseTs,
  propertyAssignmentCarries,
  propertyRegexSource,
  rootIdentifier,
  templateCarries,
  unwrapExpression,
  wrappedArgvLabels,
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
    // A slash inside a character class stays part of the body.
    expect(constRegexSource("const RE = /a[/]b/;\n", "RE", anchor)).toBe("a[/]b");
  });

  test("flags and non-regex initializers are lost anchors", () => {
    expect(() => constRegexSource("const RE = /x/i;\n", "RE", anchor)).toThrow("regex flags");
    expect(() => constRegexSource('const RE = new RegExp("x");\n', "RE", anchor)).toThrow(
      "not a regex literal",
    );
  });
});

describe("propertyRegexSource", () => {
  const schema = (pattern: string) =>
    `const s = z.strictObject({\n  answer: z.string().regex(/^[a-z]+$/, "x"),\n  label: z.string().regex(${pattern}, "y"),\n});\n`;

  test("returns the body of the .regex() literal under the named property", () => {
    expect(propertyRegexSource(schema("/^[A-Z]+$/"), "label", anchor)).toBe("^[A-Z]+$");
    // A .regex() call reached through a wrapping chain still belongs to the property.
    expect(
      propertyRegexSource("const s = { k: z.string().min(1).regex(/^a$/).optional() };\n", "k", anchor),
    ).toBe("^a$");
  });

  test.each([
    { reason: "no such property", key: "missing", source: schema("/^x$/") },
    { reason: "the property carries no .regex() call", key: "k", source: "const s = { k: z.string() };\n" },
    {
      reason: "two properties of that name carry one",
      key: "label",
      source: `${schema("/^x$/")}const t = { label: z.string().regex(/^y$/) };\n`,
    },
  ])("$reason is a lost anchor", ({ key, source }) => {
    expect(() => propertyRegexSource(source, key, anchor)).toThrow("whose chain carries a .regex() call");
  });

  test("a non-literal argument, two .regex() calls, or flags are lost anchors", () => {
    expect(() =>
      propertyRegexSource('const s = { k: z.string().regex(new RegExp("x")) };\n', "k", anchor),
    ).toThrow("not a regex literal");
    expect(() =>
      propertyRegexSource("const s = { k: z.string().regex(/a/).regex(/b/) };\n", "k", anchor),
    ).toThrow("carries 2 .regex() calls");
    expect(() => propertyRegexSource(schema("/^x$/i"), "label", anchor)).toThrow("regex flags");
  });

  test("a .regex() nested in an argument is not the property's pin", () => {
    // The chain is z.string().meta(...): the regex inside meta's object is an
    // argument, so the property carries no pin and the anchor is lost.
    const nested =
      "const s = { k: z.string().meta({ nested: z.string().regex(/^[a-z]+$/) }) };\n";
    expect(() => propertyRegexSource(nested, "k", anchor)).toThrow("found 0");
    // With a pin on the chain, the nested one neither adds to nor replaces it.
    const both =
      "const s = { k: z.string().regex(/^x$/).meta({ n: z.string().regex(/^y$/) }) };\n";
    expect(propertyRegexSource(both, "k", anchor)).toBe("^x$");
  });

  test("a decoy in a comment or a string is not a property", () => {
    const source = '// label: z.string().regex(/^decoy$/)\nconst s = { note: "label: .regex(/^d$/)" };\n';
    expect(() => propertyRegexSource(source, "label", anchor)).toThrow("found 0");
  });
});

describe("templateCarries and literalMatches", () => {
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
    // The same decoy inside a template WITH real interpolations rides a
    // middle token's raw text and still cannot match.
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
    // A property access is not the pinned identifier shape either.
    expect(templateCarries("const t = `x/contents/${a.path}?ref=${ref}`;\n", needle)).toBe(false);
    // A NESTED template inside a discarded interpolation is that
    // interpolation's code, not standalone wiring.
    expect(templateCarries("const x = `${void `x/contents/${path}?ref=${ref}`}`;\n", needle)).toBe(
      false,
    );
  });

  test("literalMatches skips interpolation code - comments there are not references, and an inner string matches once as itself", () => {
    const source = [
      "const a = `${dir /* hidden-comment-decoy.log */}/hidden-real.log`;",
      'const b = `${"hidden-inner.log"}`;',
    ].join("\n");
    expect(literalMatches(source, /hidden-[A-Za-z0-9-]+\.log/g)).toEqual([
      "hidden-real.log",
      "hidden-inner.log",
    ]);
  });

  test("literalMatches collects pattern hits from literals in source order, never from comments", () => {
    const source = [
      "// mentions hidden-decoy.log in prose",
      'const a = join(dir, "hidden-first.log");',
      "const b = `${dir}/hidden-second.log`;",
    ].join("\n");
    expect(literalMatches(source, /hidden-[A-Za-z0-9-]+\.log/g)).toEqual([
      "hidden-first.log",
      "hidden-second.log",
    ]);
  });
});

describe("argvStringAfter", () => {
  const source = [
    "must([",
    '  "copier",',
    '  "copy",',
    '  "--vcs-ref",',
    '  "HEAD",',
    '  "--defaults",',
    '  "--trust",',
    '  "-d",',
    '  "project_name=Smoke Test",',
    "]);",
  ].join("\n");

  test("returns the element after the anchor when the trailing run matches", () => {
    expect(argvStringAfter(source, "--vcs-ref", ["--defaults", "--trust"], anchor)).toBe("HEAD");
  });

  test("a broken trailing run or a commented copy is a lost anchor", () => {
    expect(() => argvStringAfter(source, "--vcs-ref", ["--trust", "--defaults"], anchor)).toThrow(
      "anchor for the pinned fact not found",
    );
    const commented = source
      .split("\n")
      .map((line) => `// ${line}`)
      .join("\n");
    expect(() =>
      argvStringAfter(commented, "--vcs-ref", ["--defaults", "--trust"], anchor),
    ).toThrow("anchor for the pinned fact not found");
  });
});

describe("parseTs refuses recovered trees", () => {
  test("a source with syntax errors throws at the shared parse entry, for every extractor", () => {
    const broken = 'const BRANCH = "build;\n';
    expect(() => parseTs(broken)).toThrow("unauditable");
    expect(() => constStringValue(broken, "BRANCH", anchor)).toThrow("unauditable");
    expect(() => templateCarries(broken, "x")).toThrow("unauditable");
    expect(() => argvFlagLeads(broken, "-d")).toThrow("unauditable");
    expect(() => literalMatches(broken, /x/g)).toThrow("unauditable");
  });
});

describe("argvFlagLeads", () => {
  test("collects string values and template heads after each flag", () => {
    const source = [
      "must([",
      '  "-d",',
      '  "project_name=X",',
      '  "-d",',
      "  `modules=${modules}`,",
      '  "-d",',
      "  dynamic,",
      "]);",
    ].join("\n");
    expect(argvFlagLeads(source, "-d")).toEqual(["project_name=X", "modules="]);
  });

  test("a commented or string-quoted flag pair yields nothing", () => {
    expect(argvFlagLeads('// must(["-d", "project_name=X"]);\n', "-d")).toEqual([]);
    expect(argvFlagLeads('const doc = \'["-d", "project_name=X"]\';\n', "-d")).toEqual([]);
  });
});

describe("wrappedArgvLabels", () => {
  test("reads the label between the wrapper call and the -- separator", () => {
    const source = [
      "const ok = passthrough([",
      '  "bun",',
      '  join(import.meta.dir, "run_hidden.ts"),',
      '  "template validation",',
      '  "--",',
      '  "bun",',
      '  "validator.ts",',
      "]);",
    ].join("\n");
    expect(wrappedArgvLabels(source, "run_hidden.ts")).toEqual(["template validation"]);
  });

  test("a missing -- separator, a different script, or a comment copy yields nothing", () => {
    expect(
      wrappedArgvLabels('f([join(d, "run_hidden.ts"), "label", "bun"]);\n', "run_hidden.ts"),
    ).toEqual([]);
    expect(
      wrappedArgvLabels('f([join(d, "other.ts"), "label", "--"]);\n', "run_hidden.ts"),
    ).toEqual([]);
    expect(
      wrappedArgvLabels('// f([join(d, "run_hidden.ts"), "label", "--"]);\n', "run_hidden.ts"),
    ).toEqual([]);
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
