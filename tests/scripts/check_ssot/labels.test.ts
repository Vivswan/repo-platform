// The label rules' pure helpers (scripts/check/ssot/labels.ts).

import { describe, expect, test } from "bun:test";
import {
  LABEL_RE_COPIES,
  labelRegexCopyMismatches,
  zToDollar,
} from "../../../scripts/check/ssot/labels.ts";

describe("zToDollar", () => {
  test("normalizes a python \\Z end anchor to $", () => {
    expect(zToDollar("^a{0,49}\\Z")).toBe("^a{0,49}$");
    expect(zToDollar("^a$")).toBe("^a$");
  });
});

describe("labelRegexCopyMismatches", () => {
  const LABEL_RE = "^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$";
  // One fixture source per copy shape, the pattern spelled by the caller.
  const source = (copy: (typeof LABEL_RE_COPIES)[number], pattern: string) =>
    copy.shape === "const"
      ? `export const ${copy.name} = /${pattern}/;\n`
      : `const s = z.strictObject({ ${copy.name}: z.string().regex(/${pattern}/, "m") });\n`;
  const reader = (drifted?: string) => (rel: string) => {
    const copy = LABEL_RE_COPIES.find((entry) => entry.file === rel);
    if (copy === undefined) throw new Error(`unexpected read ${rel}`);
    return source(copy, rel === drifted ? "^[a-z]+$" : LABEL_RE);
  };

  test("every copy spelling the action's pattern yields nothing (the control)", () => {
    expect(labelRegexCopyMismatches(LABEL_RE, reader())).toEqual([]);
  });

  test.each(LABEL_RE_COPIES.map((copy) => ({ copy })))(
    "a drifted $copy.file names that copy alone",
    ({ copy }) => {
      expect(labelRegexCopyMismatches(LABEL_RE, reader(copy.file))).toEqual([
        {
          file: `${copy.file} ${copy.name}`,
          expected: `${LABEL_RE} (actions/fuzz-issue/fuzz-issue.ts LABEL_RE)`,
          got: "^[a-z]+$",
        },
      ]);
    },
  );

  test("a copy that lost its declaration is a lost anchor, not a pass", () => {
    const missing = (rel: string) =>
      rel === "actions/plan/registration.ts" ? "export const OTHER = /x/;\n" : reader()(rel);
    expect(() => labelRegexCopyMismatches(LABEL_RE, missing)).toThrow(
      "actions/plan/registration.ts: anchor for the LABEL_RE label regex not found",
    );
  });
});
