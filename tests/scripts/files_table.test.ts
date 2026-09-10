// files_table --check is the gate that keeps docs/new-repo.md's table equal
// to files.yml (bun run files:check): the committed document passes, an
// edited cell fails, a document without the region fails. Run as a
// subprocess, the way the check chain runs it.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BEGIN, describeWhen, END, filesTable } from "../../scripts/files_table";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const DOC = join(REPO_ROOT, "docs", "new-repo.md");

function check(doc: string) {
  const result = boundedSpawnSync(["bun", "scripts/files_table.ts", "--check", doc], {
    cwd: REPO_ROOT,
    timeoutMs: 30_000,
  });
  return { exitCode: result.exitCode, stderr: result.stderr };
}

describe("files_table --check", () => {
  test("the committed docs/new-repo.md table matches files.yml", () => {
    expect(check(DOC)).toEqual({ exitCode: 0, stderr: "" });
  });

  test("an edited cell fails as stale", () => {
    const text = readFileSync(DOC, "utf-8");
    const row = "| `.github/workflows/ci.yml` | managed | always |";
    expect(text).toContain(row);
    const edited = join(temp.dir("files-table-"), "new-repo.md");
    writeFileSync(edited, text.replace(row, row.replace("managed", "starter")));
    const result = check(edited);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("the files table is stale");
  });

  test("a document without the generated region fails", () => {
    const missing = join(temp.dir("files-table-"), "new-repo.md");
    writeFileSync(missing, "# No table here\n");
    const result = check(missing);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no files-table generated region");
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
