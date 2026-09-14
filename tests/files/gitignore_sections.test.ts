// The platform-authored gitignore sections, judged by git itself: only paths a fleet step creates inside every
// checked-out workspace are listed, root-anchored so a nested source folder of the same name is not swallowed, and the
// fuzz failure directory rides the fuzzer module alone because only its starter produces it.

import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "../../.github/scripts/shared/proc.ts";
import {
  type FileEntry,
  parseFilesConfig,
  type UpstreamRef,
} from "../../actions/plan/files_config.ts";
import { tempDirs } from "../shared/temp_dir";

const temp = tempDirs();
const REPO_ROOT = join(import.meta.dir, "../..");
const FILES = join(REPO_ROOT, "files");
const BASE = readFileSync(join(FILES, "base/.gitignore"), "utf-8");
const FUZZER = readFileSync(join(FILES, "fuzzer/.block.fuzzer.gitignore"), "utf-8");

test("every repository takes the three github/gitignore OS templates, in this order, before any module block", () => {
  const config = parseFilesConfig(readFileSync(join(REPO_ROOT, "files.yml"), "utf-8"));
  const gitignore = config.files.find((entry) => entry.path === ".gitignore") as Extract<
    FileEntry,
    { source: string | UpstreamRef }
  >;
  const ref = (path: string) => ({ repository: "github/gitignore", path });
  expect(gitignore.upstream).toMatchObject({
    always: ["Windows", "macOS", "Linux"],
    refs: {
      Windows: ref("Global/Windows.gitignore"),
      macOS: ref("Global/macOS.gitignore"),
      Linux: ref("Global/Linux.gitignore"),
    },
  });
});

test("the base and fuzzer sections are the bytes the fleet carries", () => {
  expect(BASE).toEndWith("## CI workspace paths (repo-platform)\n/results.sarif\n\n");
  expect(FUZZER).toBe("## Fuzzer workspace paths (repo-platform fuzzer)\n/.fuzz-failures/\n\n");
});

function ignoredByGit(section: string, rel: string, kind: "dir" | "file"): boolean {
  const repo = temp.dir("gitignore-sections-");
  expect(capture(["git", "-C", repo, "init", "-q"], {}).exitCode).toBe(0);
  writeFileSync(join(repo, ".gitignore"), section);
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  if (kind === "dir") mkdirSync(abs);
  else writeFileSync(abs, "");
  const probe = capture(
    ["git", "-C", repo, "-c", "core.excludesFile=/dev/null", "check-ignore", "-q", rel],
    {},
  );
  // 0 ignored, 1 not ignored; anything else is a broken probe, never a verdict.
  expect([0, 1]).toContain(probe.exitCode);
  return probe.exitCode === 0;
}

test.each<[string, string, "dir" | "file", boolean]>([
  ["base", "results.sarif", "file", true],
  ["base", ".fuzz-failures", "dir", false],
  ["base", "assets/logo.png", "file", false],
  ["base", "scan/results.sarif", "file", false],
  ["base", ".claude/worktrees/x", "dir", true],
  ["fuzzer", ".fuzz-failures", "dir", true],
  ["fuzzer", ".fuzz-failures", "file", false],
  ["fuzzer", "crate/.fuzz-failures", "dir", false],
])("%s section: %s (%s) ignored: %p", (section, rel, kind, ignored) => {
  expect(ignoredByGit(section === "base" ? BASE : FUZZER, rel, kind)).toBe(ignored);
});
