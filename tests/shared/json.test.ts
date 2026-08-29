// parseJson/parseJsonWith exit the process on failure, so the failure
// modes run behind a subprocess entry file. The load-bearing assertion:
// malformed JSON must never echo the input text - Bun's raw SyntaxError
// quotes the offending fragment ('Unexpected identifier "..."'), which
// can be target-derived (private repo names, descriptions).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  hasDuplicateJsonKeys,
  parseJsonWithThrow,
  parseWith,
} from "../../.github/scripts/shared/json.ts";
import { boundedSpawnSync } from "./bounded_spawn";

const jsonPath = join(import.meta.dir, "../../.github/scripts/shared/json.ts");

const root = mkdtempSync(join(tmpdir(), "json-proc-"));
const entry = join(root, "entry.ts");
writeFileSync(
  entry,
  [
    `import { z } from "zod";`,
    `import { parseJsonWith } from ${JSON.stringify(jsonPath)};`,
    "const schema = z.object({ repo: z.string() });",
    'const parsed = parseJsonWith(schema, process.env.PAYLOAD ?? "", "json.test: payload");',
    `console.log(\`repo-name-length=\${parsed.repo.length}\`);`,
    "",
  ].join("\n"),
);

function run(payload: string) {
  const proc = boundedSpawnSync(["bun", entry], { env: { ...process.env, PAYLOAD: payload } });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    stderr: proc.stderr,
  };
}

describe("parseJsonWith", () => {
  test("valid JSON of the expected shape parses through", () => {
    const r = run('{"repo": "owner/name"}');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("repo-name-length=10");
  });

  test("malformed JSON fails with a value-free diagnostic (no SyntaxError echo)", () => {
    // The bare identifier is the leaking form Bun's raw error would quote.
    const r = run('{"repo": hiddenserver}');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::json.test: payload: not valid JSON");
    expect(r.stdout + r.stderr).not.toContain("hiddenserver");
  });

  test("valid JSON of the wrong shape names paths and codes, never the value", () => {
    const r = run('{"repo": ["hiddenserver"]}');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("::error::json.test: payload: unexpected shape");
    expect(r.stdout + r.stderr).not.toContain("hiddenserver");
  });
});

describe("hasDuplicateJsonKeys", () => {
  test("a duplicated key in one object is caught (JSON.parse would keep only the last)", () => {
    expect(
      hasDuplicateJsonKeys(
        '{"files": {"AGENTS.md": {"class": "split"}, "AGENTS.md": {"class": "managed"}}}',
      ),
    ).toBe(true);
  });

  test("an escape-variant duplicate is caught (decoded keys are what JSON.parse collides)", () => {
    const escaped = String.raw`"AGENTS.m\u0064"`;
    expect(hasDuplicateJsonKeys(`{"AGENTS.md": 1, ${escaped}: 2}`)).toBe(true);
  });

  test("the same key in DIFFERENT objects is not a duplicate", () => {
    expect(hasDuplicateJsonKeys('{"a": {"class": "split"}, "b": {"class": "managed"}}')).toBe(
      false,
    );
    expect(hasDuplicateJsonKeys('{"a": ["x", "x"], "b": {"a": 1}}')).toBe(false);
  });

  test("a duplicate inside a NESTED object is caught", () => {
    expect(hasDuplicateJsonKeys('{"files": {"a": {"class": "split", "class": "managed"}}}')).toBe(
      true,
    );
    expect(hasDuplicateJsonKeys('[{"k": 1}, {"k": 2}]')).toBe(false);
  });
});

// The throwing twin runs in-process: it must never exit, so a caller that
// owns its failure containment (a fleet lane) can turn the throw into its
// own failure row while the run continues.
describe("parseJsonWithThrow", () => {
  const schema = z.object({ repo: z.string() });

  test("valid JSON of the expected shape parses through", () => {
    expect(parseJsonWithThrow(schema, '{"repo": "owner/name"}', "json.test: payload")).toEqual({
      repo: "owner/name",
    });
  });

  test("malformed JSON throws value-free, never exits", () => {
    let thrown: unknown;
    try {
      parseJsonWithThrow(schema, '{"repo": hiddenserver}', "json.test: payload");
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toContain("json.test: payload: not valid JSON");
    expect(String(thrown)).not.toContain("hiddenserver");
  });

  test("wrong-shaped JSON throws paths and codes, never the value", () => {
    let thrown: unknown;
    try {
      parseJsonWithThrow(schema, '{"repo": ["hiddenserver"]}', "json.test: payload");
    } catch (err) {
      thrown = err;
    }
    expect(String(thrown)).toContain("json.test: payload: unexpected shape");
    expect(String(thrown)).not.toContain("hiddenserver");
  });

  test("an unexpected exception rethrows unchanged from the exiting forms, never as a payload diagnosis", () => {
    // Only JsonShapeError gets the ::error:: + exit treatment; a throwing
    // transform is a code bug whose stack must survive. The test process
    // outliving the call is itself the no-exit proof.
    const throwing = z.string().transform((): string => {
      throw new Error("transform blew up");
    });
    expect(() => parseWith(throwing, "x", "json.test: payload")).toThrow("transform blew up");
  });
});
