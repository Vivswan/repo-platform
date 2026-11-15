import { expect, test } from "bun:test";
import { extractUsesPins } from "./uses_pins";

// YAML's own reading of a step, which a line pattern misses: a flow mapping ends the ref at its comma and holds the
// version comment on the step, and a `uses:` inside a script's text is no step. A wrong ref here reads as a second
// sha for the action in the one-sha census.
test("a pin is read as YAML reads the step: flow style, quoted, and a commented example count; script text does not", () => {
  const source = [
    "steps:",
    "  # - uses: oven-sh/setup-bun@1111111 # v2.2.0",
    "  - { uses: actions/cache@2222222, with: {} } # v4.0.0",
    '  - uses: "actions/checkout@3333333" # v7.0.1',
    "  - uses: actions/upload-artifact/merge@4444444",
    "  - uses: ./.github/actions/local",
    "  - run: |",
    '      echo "uses: in/script@5555555"',
    "",
  ].join("\n");
  expect(extractUsesPins(source, "f.yml")).toEqual([
    { file: "f.yml", action: "actions/cache", ref: "2222222", version: "v4.0.0" },
    { file: "f.yml", action: "actions/checkout", ref: "3333333", version: "v7.0.1" },
    { file: "f.yml", action: "actions/upload-artifact", ref: "4444444", version: null },
    { file: "f.yml", action: "oven-sh/setup-bun", ref: "1111111", version: "v2.2.0" },
  ]);
});
