import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const RUNG = new URL("../../migrations/0004-copilot-files-leave.ts", import.meta.url).pathname;
const LINK = ".github/copilot-instructions.md";
const STARTER = ".github/workflows/copilot-setup-steps.yml";
const OWN_NOTES = "# my own notes\n";
const WORKFLOW = "name: Copilot Setup Steps\n";

function checkout(): string {
  const root = temp.dir("migration-0004-");
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# AGENTS.md\n");
  symlinkSync("../AGENTS.md", join(root, ".github/agents.md"));
  writeFileSync(join(root, ".github/workflows/checks.yml"), "name: checks\n");
  return root;
}

const run = (root: string) => boundedSpawnSync([process.execPath, RUNG, root]);
const stands = (root: string, path: string) =>
  lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined;

describe("0004-copilot-files-leave", () => {
  test("the fleet's link and the starter are deleted and reported; their neighbors stay; a second run changes nothing", () => {
    const root = checkout();
    symlinkSync("../AGENTS.md", join(root, LINK));
    writeFileSync(join(root, STARTER), WORKFLOW);
    // stdout is the runner's contract: the paths deleted, nothing else.
    expect(run(root)).toEqual({ exitCode: 0, stdout: `${LINK}\n${STARTER}\n`, stderr: "" });
    expect(stands(root, LINK)).toBe(false);
    expect(stands(root, STARTER)).toBe(false);
    // The link is unlinked, never followed.
    expect(readFileSync(join(root, "AGENTS.md"), "utf-8")).toBe("# AGENTS.md\n");
    expect(lstatSync(join(root, ".github/agents.md")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, ".github/workflows/checks.yml"))).toBe(true);
    expect(run(root)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("a checkout with neither path is a no-op", () => {
    const root = checkout();
    expect(run(root)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(lstatSync(join(root, ".github/agents.md")).isSymbolicLink()).toBe(true);
  });

  test.each<{ reason: string; place: (path: string) => void; kept: (path: string) => boolean }>([
    {
      reason: "a hand-written file",
      place: (path) => writeFileSync(path, OWN_NOTES),
      kept: (path) => readFileSync(path, "utf-8") === OWN_NOTES,
    },
    {
      reason: "a link to somewhere else",
      place: (path) => symlinkSync("../docs/notes.md", path),
      kept: (path) => lstatSync(path).isSymbolicLink(),
    },
  ])("$reason where the fleet's link was is the repository's own and stays", ({ place, kept }) => {
    const root = checkout();
    place(join(root, LINK));
    expect(run(root)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(kept(join(root, LINK))).toBe(true);
  });

  test("a symbolic link where .github should be fails the rung and deletes nothing through it", () => {
    const root = temp.dir("migration-0004-linked-");
    mkdirSync(join(root, "shared/workflows"), { recursive: true });
    writeFileSync(join(root, "shared/workflows/copilot-setup-steps.yml"), WORKFLOW);
    symlinkSync("shared", join(root, ".github"));
    expect(run(root)).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `${LINK}: its ancestor '.github' is a symbolic link, so the write could leave the checkout\n`,
    });
    expect(existsSync(join(root, "shared/workflows/copilot-setup-steps.yml"))).toBe(true);
  });
});
