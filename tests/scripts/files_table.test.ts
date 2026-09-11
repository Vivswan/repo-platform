// files_table --check is the gate (bun run files:check) and --write the regen
// that restores docs/new-repo.md's table from files.yml byte for byte. Both
// run as subprocesses, the way the check chain and regen run them.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BEGIN, describeWhen, END, filesTable } from "../../scripts/files_table";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const DOC = join(REPO_ROOT, "docs", "new-repo.md");

function run(mode: "--check" | "--write", doc: string) {
  const result = boundedSpawnSync(["bun", "scripts/files_table.ts", mode, doc], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

describe("files_table --check and --write", () => {
  test("the committed docs/new-repo.md table matches files.yml, and --write leaves it byte-identical", () => {
    expect(run("--check", DOC)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    const copy = join(temp.dir("files-table-"), "new-repo.md");
    const text = readFileSync(DOC, "utf-8");
    writeFileSync(copy, text);
    expect(run("--write", copy)).toEqual({
      exitCode: 0,
      stdout: `${copy}: the files table matches files.yml\n`,
      stderr: "",
    });
    expect(readFileSync(copy, "utf-8")).toBe(text);
  });

  test("an edited cell fails as stale until --write restores the committed bytes", () => {
    const text = readFileSync(DOC, "utf-8");
    const row = "| `.github/workflows/ci.yml` | managed | always |";
    expect(text).toContain(row);
    const edited = join(temp.dir("files-table-"), "new-repo.md");
    writeFileSync(edited, text.replace(row, row.replace("managed", "starter")));
    const stale = run("--check", edited);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("the files table is stale");
    expect(run("--write", edited)).toEqual({
      exitCode: 0,
      stdout: `${edited}: files table rewritten\n`,
      stderr: "",
    });
    expect(readFileSync(edited, "utf-8")).toBe(text);
    expect(run("--check", edited)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test.each(["--check", "--write"] as const)(
    "%s on a document without the generated region fails and writes nothing",
    (mode) => {
      const missing = join(temp.dir("files-table-"), "new-repo.md");
      writeFileSync(missing, "# No table here\n");
      const result = run(mode, missing);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("no files-table generated region");
      expect(readFileSync(missing, "utf-8")).toBe("# No table here\n");
    },
  );

  test("a bare file argument is a usage error, and regen invokes the write mode", () => {
    const result = boundedSpawnSync(["bun", "scripts/files_table.ts", "docs/new-repo.md"], {
      cwd: REPO_ROOT,
      timeoutMs: 30_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage:");
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")).scripts;
    expect(scripts.regen).toEndWith("bun scripts/files_table.ts --write docs/new-repo.md");
    expect(scripts["files:check"]).toBe("bun scripts/files_table.ts --check docs/new-repo.md");
  });
});

describe("filesTable", () => {
  test("renders one row per entry with the when condition in words", () => {
    expect(describeWhen(null)).toBe("always");
    expect(describeWhen({ any: ["bun", "uv"], private: false })).toBe("any of `bun`, `uv`; public");
    expect(describeWhen({ modules: ["pages"] })).toBe("modules: `pages`");
    expect(describeWhen({ without: ["custom-license"] })).toBe("without `custom-license`");
    expect(
      filesTable([
        { path: ".yamllint", class: "managed", source: "base/.yamllint", when: null },
        {
          path: ".dvmrc",
          class: "managed",
          source: "deno/.dvmrc",
          when: { modules: ["deno"] },
        },
      ]),
    ).toBe(
      [
        "| File | Class | When |",
        "| --- | --- | --- |",
        "| `.yamllint` | managed | always |",
        "| `.dvmrc` | managed | modules: `deno` |",
      ].join("\n"),
    );
    expect(BEGIN).toContain("files-table");
    expect(END).toContain("files-table");
  });
});
