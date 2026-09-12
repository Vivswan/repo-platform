import { describe, expect, test } from "bun:test";
import {
  LABEL_RE_COPIES,
  LABEL_RE_HOME,
  labelRegexCopyMismatches,
} from "../../../scripts/check/ssot/labels.ts";

describe("labelRegexCopyMismatches", () => {
  const LABEL_RE = "^[A-Za-z0-9._][A-Za-z0-9._: -]{0,49}$";
  const source = (copy: (typeof LABEL_RE_COPIES)[number], pattern: string) =>
    `export const ${copy.name} = /${pattern}/;\n`;
  const reader = (drifted?: string) => (rel: string) => {
    const copy = LABEL_RE_COPIES.find((entry) => entry.file === rel);
    if (copy === undefined) throw new Error(`unexpected read ${rel}`);
    return source(copy, rel === drifted ? "^[a-z]+$" : LABEL_RE);
  };

  test("every copy spelling the home's pattern yields nothing (the control)", () => {
    expect(labelRegexCopyMismatches(LABEL_RE, reader())).toEqual([]);
  });

  test.each(LABEL_RE_COPIES.map((copy) => ({ copy })))(
    "a drifted $copy.file names that copy alone",
    ({ copy }) => {
      expect(labelRegexCopyMismatches(LABEL_RE, reader(copy.file))).toEqual([
        {
          file: `${copy.file} ${copy.name}`,
          expected: `${LABEL_RE} (${LABEL_RE_HOME} LABEL_RE)`,
          got: "^[a-z]+$",
        },
      ]);
    },
  );

  test("a copy that lost its declaration is a lost anchor, not a pass", () => {
    const missing = (rel: string) =>
      rel === "actions/release-health/release-health.ts"
        ? "export const OTHER = /x/;\n"
        : reader()(rel);
    expect(() => labelRegexCopyMismatches(LABEL_RE, missing)).toThrow(
      "actions/release-health/release-health.ts: anchor for the LABEL_RE label regex not found",
    );
  });
});
