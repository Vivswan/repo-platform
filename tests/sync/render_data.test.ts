// render_data.ts: the copier --data-file builder for the sync's clean
// renders. The invariant under test is BYTE-level: copier re-parses the
// data files with PyYAML, so every recorded scalar must reach them as the
// exact bytes the answers file held (see answers_file.ts's dataFileYaml,
// which owns the assembly and has its own unit suite); these tests pin the
// script-level plumbing - flags, file outputs, loud failures.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";

const script = join(import.meta.dir, "../../.github/scripts/sync/render_data.ts");

function runScript(
  answersText: string,
  modules: string,
  privateFlag: string,
  description: string,
): { exitCode: number; stdout: string; old: string; new: string } {
  const dir = mkdtempSync(join(tmpdir(), "render-data-"));
  const answersPath = join(dir, "answers-old.yml");
  writeFileSync(answersPath, answersText);
  const outOld = join(dir, "data-old.yml");
  const outNew = join(dir, "data-new.yml");
  const proc = boundedSpawnSync([
    "bun",
    script,
    "--answers-old",
    answersPath,
    "--out-old",
    outOld,
    "--out-new",
    outNew,
    "--modules",
    modules,
    "--private",
    privateFlag,
    "--description",
    description,
  ]);
  const slurp = (path: string) => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return "";
    }
  };
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout,
    old: slurp(outOld),
    new: slurp(outNew),
  };
}

const ANSWERS = [
  "_commit: 1626e53",
  "_src_path: gh:Vivswan/repo-platform.git",
  "project_name: 1e3",
  "copyright_holder: no",
  "auto_merge: on",
  "tracking_label: 0123",
  "description: recorded description",
  "private: false",
  "modules:",
  "  - agents",
]
  .map((line) => `${line}\n`)
  .join("");

describe("render_data script", () => {
  test("data-old replays the recorded answers verbatim, metadata dropped", () => {
    const result = runScript(ANSWERS, '["uv"]', "true", "live description");
    expect(result.exitCode).toBe(0);
    // Byte-verbatim scalars: PyYAML must read 1e3 / no / on / 0123 exactly
    // as it read them from the answers file (string, bool, bool, octal).
    expect(result.old).toContain("project_name: 1e3\n");
    expect(result.old).toContain("copyright_holder: no\n");
    expect(result.old).toContain("auto_merge: on\n");
    expect(result.old).toContain("tracking_label: 0123\n");
    expect(result.old).toContain("description: recorded description\n");
    expect(result.old).toContain("private: false\n");
    expect(result.old).toContain("modules:\n  - agents\n");
    expect(result.old).not.toContain("_commit");
    expect(result.old).not.toContain("_src_path");
  });

  test("data-new overrides the live keys once and carries the rest verbatim", () => {
    const result = runScript(ANSWERS, '["uv", "agents"]', "true", "live description");
    expect(result.exitCode).toBe(0);
    expect(result.new).toContain("project_name: 1e3\n");
    expect(result.new).toContain('modules:\n  - "uv"\n  - "agents"\n');
    expect(result.new).toContain("private: true\n");
    expect(result.new).toContain('description: "live description"\n');
    // The recorded values of the overridden keys must be GONE, not merely
    // shadowed by a later duplicate key (PyYAML takes the last duplicate,
    // but a duplicate-key data file is a parse warning waiting to differ).
    expect(result.new).not.toContain("recorded description");
    expect(result.new).not.toContain("private: false");
    expect(result.new).not.toContain("- agents\n"); // only the quoted live list remains
  });

  test("an empty selection writes an explicit empty list", () => {
    const result = runScript(ANSWERS, "[]", "false", "");
    expect(result.exitCode).toBe(0);
    expect(result.new).toContain("modules: []\n");
    expect(result.new).toContain('description: ""\n');
  });

  test("a malformed answers file fails loudly", () => {
    const result = runScript("- a\n- list\n", '["uv"]', "false", "x");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("::error::");
  });

  test("a malformed modules list fails loudly", () => {
    const result = runScript(ANSWERS, "not-json", "false", "x");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("--modules must be a JSON list of strings");
  });
});
