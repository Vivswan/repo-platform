// parseJson/parseJsonWith exit the process on failure, so their failure modes run behind a subprocess
// entry file. Bun's raw SyntaxError quotes the offending fragment ('Unexpected identifier "..."'), which
// can be target-derived (private repo names, descriptions): malformed JSON must never echo the input.

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  hasDuplicateJsonKeys,
  parseJsonWithThrow,
  parseWith,
} from "../../.github/scripts/shared/json.ts";
import { boundedSpawnSync } from "./bounded_spawn";
import { tempDirs } from "./temp_dir";

const temp = tempDirs();

const jsonPath = join(import.meta.dir, "../../.github/scripts/shared/json.ts");
// The entry lives under the OS temp dir, outside the repo tree: a bare "zod" there would
// auto-install from the global cache and the network.
const zodPath = fileURLToPath(import.meta.resolve("zod"));

const root = temp.dir("json-proc-");
const entry = join(root, "entry.ts");
writeFileSync(
  entry,
  [
    `import { z } from ${JSON.stringify(zodPath)};`,
    `import { parseJsonWith } from ${JSON.stringify(jsonPath)};`,
    "const schema = z.object({ repo: z.string() });",
    'const parsed = parseJsonWith(schema, process.env.PAYLOAD ?? "", "json.test: payload");',
    `console.log(\`repo-name-length=\${parsed.repo.length}\`);`,
    "",
  ].join("\n"),
);

// The bare identifier is the leaking form Bun's raw error would quote.
const LEAK = "hiddenserver";

describe("parseJsonWith", () => {
  test.each([
    [
      "valid JSON of the expected shape parses through",
      `{"repo": "owner/name"}`,
      0,
      "repo-name-length=10\n",
    ],
    [
      "malformed JSON fails with a value-free diagnostic (no SyntaxError echo)",
      `{"repo": ${LEAK}}`,
      1,
      "::error::json.test: payload: not valid JSON\n",
    ],
    [
      "valid JSON of the wrong shape names paths and codes, never the value",
      `{"repo": ["${LEAK}"]}`,
      1,
      "::error::json.test: payload: unexpected shape - repo: invalid_type\n",
    ],
  ])("%s", (_reason, payload, exitCode, stdout) => {
    const proc = boundedSpawnSync(["bun", entry], { env: { ...process.env, PAYLOAD: payload } });
    expect({ exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr }).toEqual({
      exitCode,
      stdout,
      stderr: "",
    });
  });
});

describe("hasDuplicateJsonKeys", () => {
  // JSON.parse keeps the last duplicate silently: the conflict-mangled manifest hazard the module's JSDoc names.
  const cases: [string, string, boolean][] = [
    [
      "a duplicated key in one object is caught (JSON.parse would keep only the last)",
      '{"files": {"AGENTS.md": {"class": "split"}, "AGENTS.md": {"class": "managed"}}}',
      true,
    ],
    [
      "an escape-variant duplicate is caught (decoded keys are what JSON.parse collides)",
      `{"AGENTS.md": 1, ${String.raw`"AGENTS.m\u0064"`}: 2}`,
      true,
    ],
    [
      "the same key in DIFFERENT objects is not a duplicate",
      '{"a": {"class": "split"}, "b": {"class": "managed"}}',
      false,
    ],
    [
      "repeated strings inside an array are values, never keys",
      '{"a": ["x", "x"], "b": {"a": 1}}',
      false,
    ],
    [
      "a duplicate inside a NESTED object is caught",
      '{"files": {"a": {"class": "split", "class": "managed"}}}',
      true,
    ],
    ["objects in one array may share a key", '[{"k": 1}, {"k": 2}]', false],
  ];
  test.each(cases)("%s", (_reason, text, expected) => {
    expect(hasDuplicateJsonKeys(text)).toBe(expected);
  });
});

// The throwing twin runs in-process: it must never exit, so a caller that
// owns its failure containment (a fleet lane) can turn the throw into its
// own failure row while the run continues.
describe("parseJsonWithThrow", () => {
  const schema = z.object({ repo: z.string() });

  test.each([
    [
      "malformed JSON throws value-free, never exits",
      `{"repo": ${LEAK}}`,
      "Error: json.test: payload: not valid JSON",
    ],
    [
      "wrong-shaped JSON throws paths and codes, never the value",
      `{"repo": ["${LEAK}"]}`,
      "Error: json.test: payload: unexpected shape - repo: invalid_type",
    ],
  ])("%s", (_reason, payload, message) => {
    let thrown: unknown;
    try {
      parseJsonWithThrow(schema, payload, "json.test: payload");
    } catch (err) {
      thrown = err;
    }
    // The test process outliving the call is itself the no-exit proof.
    expect(String(thrown)).toBe(message);
  });

  test("an unexpected exception rethrows unchanged from the exiting forms, never as a payload diagnosis", () => {
    // Only JsonShapeError gets the ::error:: + exit treatment; a throwing
    // transform is a code bug whose stack must survive.
    const throwing = z.string().transform((): string => {
      throw new Error("transform blew up");
    });
    expect(() => parseWith(throwing, "x", "json.test: payload")).toThrow("transform blew up");
  });
});
