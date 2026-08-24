// parseJson/parseJsonWith exit the process on failure, so the failure
// modes run behind a subprocess entry file. The load-bearing assertion:
// malformed JSON must never echo the input text - Bun's raw SyntaxError
// quotes the offending fragment ('Unexpected identifier "..."'), which
// can be target-derived (private repo names, descriptions).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const proc = Bun.spawnSync(["bun", entry], { env: { ...process.env, PAYLOAD: payload } });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
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
