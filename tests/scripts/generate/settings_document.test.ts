// The one-byte edit is the drift check's negative control.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { capture } from "../../../.github/scripts/shared/proc.ts";
import { RENDERED_HEADER } from "../../../.github/scripts/sync/writer/settings_entry.ts";
import { renderOwnSettings } from "../../../scripts/generate/settings_document";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT = "scripts/generate/settings_document.ts";
const RENDERED = ".github/settings.yml";
const OVERLAY = ".github/settings.local.yml";

/** Every input the generator reads, copied so a test can break one. */
function scratchRoot(): string {
  const root = temp.dir("settings-document-");
  for (const rel of ["files.yml", "files", ".repo-platform.yml", OVERLAY, RENDERED]) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
  }
  return root;
}

function run(root: string, ...args: string[]) {
  const result = capture(["bun", SCRIPT, "--root", root, ...args], { cwd: REPO_ROOT });
  return { exitCode: result.exitCode, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

const names = (list: unknown) => (list as { name: string }[]).map((entry) => entry.name);

describe("renderOwnSettings", () => {
  test("the committed file is the render: header, the overlay's identity and ruleset beside the fleet's, the registration's tracking label", () => {
    const own = renderOwnSettings(REPO_ROOT);
    expect([own.path, own.overlayPath]).toEqual([RENDERED, OVERLAY]);
    expect(readFileSync(join(REPO_ROOT, RENDERED), "utf-8")).toBe(own.content);
    const lines = own.content.split("\n");
    expect(lines[0]).toBe(RENDERED_HEADER);
    expect(lines[2]).toBe("# Applied by Vivswan/repo-platform's settings run.");
    const doc = parseYaml(own.content) as Record<string, unknown>;
    const overlay = parseYaml(readFileSync(join(REPO_ROOT, OVERLAY), "utf-8")) as {
      repository: Record<string, unknown>;
      rulesets: { name: string }[];
    };
    // The override's merge policy lands above the overlay's identity keys.
    expect(doc.repository).toMatchObject({
      ...overlay.repository,
      allow_merge_commit: false,
      squash_merge_commit_title: "PR_TITLE",
    });
    // The baseline roster, the bun module's dependabot label, the docs-site tracking label.
    expect(names(doc.labels)).toEqual([
      "dependencies",
      "github_actions",
      "bug",
      "enhancement",
      "fix-lint",
      "merge-when-green",
      "security-nightly",
      "javascript",
      "docs-link-rot",
    ]);
    // The baseline's pr-title (activated by the module), the override's two, the overlay's own.
    expect(names(doc.rulesets).sort()).toEqual(
      ["pr-title", "main", "non-bypassable", ...names(overlay.rulesets)].sort(),
    );
    const check = capture(["bun", SCRIPT, "--check"], { cwd: REPO_ROOT });
    expect([check.exitCode, check.stdout.trim()]).toEqual([
      0,
      `${RENDERED} matches the settings layers, the registration, and ${OVERLAY}`,
    ]);
  });

  test("--check is red after a one-byte edit of the rendered file and green once bun run settings rewrites it", () => {
    const root = scratchRoot();
    const original = readFileSync(join(root, RENDERED), "utf-8");
    expect(run(root, "--check").exitCode).toBe(0);
    writeFileSync(join(root, RENDERED), original.replace("has_wiki: false", "has_wiki: true"));
    expect(run(root, "--check")).toEqual({
      exitCode: 1,
      stdout: `${RENDERED} is stale: it is not the render of the settings layers, the registration, and ${OVERLAY}; run bun run settings to rewrite it`,
      stderr: "",
    });
    expect(run(root)).toEqual({ exitCode: 0, stdout: `rewrote ${RENDERED}`, stderr: "" });
    expect(readFileSync(join(root, RENDERED), "utf-8")).toBe(original);
    expect(run(root, "--check").exitCode).toBe(0);
  });

  test.each([
    {
      name: "a missing overlay",
      mutate: (root: string) => rmSync(join(root, OVERLAY)),
      message: `${OVERLAY} is missing - the render reads this repository's overlay from it`,
    },
    {
      name: "an overlay declaring no visibility",
      mutate: (root: string) => {
        const path = join(root, OVERLAY);
        writeFileSync(path, readFileSync(path, "utf-8").replace("  private: false\n", ""));
      },
      message: `${OVERLAY} must declare repository.private - the visibility layer is selected by it`,
    },
    {
      name: "a registration naming a module files.yml lacks",
      mutate: (root: string) => {
        const path = join(root, ".repo-platform.yml");
        writeFileSync(
          path,
          readFileSync(path, "utf-8").replace("  - bun\n", "  - bun\n  - bunny\n"),
        );
      },
      message: ".repo-platform.yml selects module(s) files.yml does not know: bunny",
    },
    {
      name: "a registration whose tracking label reuses a fleet label",
      mutate: (root: string) => {
        const path = join(root, ".repo-platform.yml");
        writeFileSync(
          path,
          readFileSync(path, "utf-8").replace("docs_site: docs-link-rot", "docs_site: Bug"),
        );
      },
      message: `${RENDERED} cannot be rendered: tracking label "Bug" (docs_site) is a label the platform already manages; a green night would close whatever issues carry it and every settings apply would fight over it`,
    },
  ])("refuses $name by name and writes nothing", ({ mutate, message }) => {
    const root = scratchRoot();
    const before = readFileSync(join(root, RENDERED), "utf-8");
    mutate(root);
    expect(() => renderOwnSettings(root)).toThrow(message);
    expect(run(root)).toEqual({ exitCode: 1, stdout: "", stderr: `error: ${message}` });
    expect(readFileSync(join(root, RENDERED), "utf-8")).toBe(before);
  });
});
