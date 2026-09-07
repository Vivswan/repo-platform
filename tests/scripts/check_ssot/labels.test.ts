// The label rules' pure helpers (scripts/check/ssot/labels.ts).

import { describe, expect, test } from "bun:test";
import { zToDollar } from "../../../scripts/check/ssot/labels.ts";

describe("zToDollar", () => {
  test("normalizes a python \\Z end anchor to $", () => {
    expect(zToDollar("^a{0,49}\\Z")).toBe("^a{0,49}$");
    expect(zToDollar("^a$")).toBe("^a$");
  });
});
