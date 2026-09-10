// Moves a root SECURITY.md to .github/SECURITY.md with `git mv` ahead of
// copier, so the split-file rebuild finds the repository-owned tail at the
// new path. Self-contained: node builtins only (docs/migrations.md).

import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface Target {
  readonly dir: string;
  readonly oldSha: string | null;
  readonly newSha: string;
}

type Outcome =
  | {
      readonly kind: "verdict";
      readonly verdict: {
        readonly kind: "in-place" | "moved" | "missing";
        readonly note: { readonly text: string; readonly review: boolean } | null;
      };
    }
  | { readonly kind: "error"; readonly message: string };

const CURRENT = ".github/SECURITY.md";
const ROOT_COPY = "SECURITY.md";

const MOVE_NOTE = [
  "> [!NOTE]",
  `> SECURITY POLICY MOVE: this update moves \`${ROOT_COPY}\` to`,
  `> \`${CURRENT}\`, byte-for-byte - the repository's own content outside`,
  "> the managed region rides the move verbatim, and GitHub reads the policy",
  "> from `.github/` exactly as it did from the root. One-time transition:",
  "> the repository root keeps only repo content plus `.repo-platform.yml`;",
  "> community health files live under `.github/`.",
];

const MIRROR_ADVICE = [
  "> This repository's `.repo-platform.yml` declares a `mirrors` source at the",
  `> retired path \`${ROOT_COPY}\`, and this template renders no security policy`,
  "> at any path: remove that mirror declaration, or point its `source` at a",
  "> file this template still renders. Until then the mirror step refuses that",
  "> entry and holds the PR.",
];

/** lstat, so a symlink never reads as the file it points at. ENOENT is
 * absence; ENOTDIR means a parent segment is a file, the same broken shape
 * as a non-file entry; anything else (EACCES, EIO) throws. */
function entryKind(path: string): "file" | "dir" | "absent" | "other" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return "absent";
    if (code === "ENOTDIR") return "other";
    throw err;
  }
  if (stat.isFile()) return "file";
  if (stat.isDirectory() && !stat.isSymbolicLink()) return "dir";
  return "other";
}

function git(dir: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** The last non-empty line of a git stderr, or "no output". */
function lastLine(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines.length === 0 ? "no output" : lines[lines.length - 1].trim();
}

/** Whether HEAD's `.repo-platform.yml` names the retired path as a
 * `mirrors` source; the mirror step refuses that entry after the move, so
 * the note tells the human what clears it. Advisory only: the mirror
 * step's stricter reader is the authority on the declaration, and a
 * declaration this probe cannot read counts as not declaring it. */
function declaresRootMirrorSource(dir: string): boolean {
  const shown = git(dir, "show", "HEAD:.repo-platform.yml");
  if (shown.exitCode !== 0) return false;
  let data: unknown;
  try {
    data = Bun.YAML.parse(shown.stdout);
  } catch {
    return false;
  }
  const mirrors = (data as { mirrors?: unknown } | null)?.mirrors;
  if (!Array.isArray(mirrors)) return false;
  return mirrors.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { source?: unknown }).source === ROOT_COPY,
  );
}

export default {
  id: "m0001_security_policy_to_github",

  apply(target: Target): Outcome {
    // The destination's parent is target-controlled: `git mv` into a
    // symlinked .github exits 0 and writes wherever the link points, so
    // the parent is judged before either path is probed through it.
    const parent = entryKind(join(target.dir, ".github"));
    if (parent === "file" || parent === "other") {
      return {
        kind: "error",
        message:
          `.github is not a real directory (a symlink or a file), so ${ROOT_COPY} cannot be ` +
          "moved beneath it. The sync refuses to write through it: fix the default branch by " +
          "hand, then re-run the sync.",
      };
    }
    const rootKind = entryKind(join(target.dir, ROOT_COPY));
    const currentKind = parent === "absent" ? "absent" : entryKind(join(target.dir, CURRENT));
    if (
      rootKind === "dir" ||
      rootKind === "other" ||
      currentKind === "dir" ||
      currentKind === "other"
    ) {
      return {
        kind: "error",
        message:
          `carries something other than a regular file at ${CURRENT} or ${ROOT_COPY} (a ` +
          "directory or a symlink). The sync refuses to guess: fix the default branch by hand, " +
          "then re-run the sync.",
      };
    }
    if (rootKind === "file" && currentKind === "file") {
      return {
        kind: "error",
        message:
          `carries a security policy at BOTH ${CURRENT} and the retired root path ${ROOT_COPY}. ` +
          `The template renders only ${CURRENT}; merge any repository-specific content into it ` +
          "and delete the root copy on the default branch, then re-run the sync.",
      };
    }
    let kind: "in-place" | "moved" | "missing";
    if (currentKind === "file") kind = "in-place";
    else if (rootKind === "absent") kind = "missing";
    else {
      mkdirSync(join(target.dir, ".github"), { recursive: true });
      const moved = git(target.dir, "mv", ROOT_COPY, CURRENT);
      if (moved.exitCode !== 0) {
        return {
          kind: "error",
          message: `git mv ${ROOT_COPY} ${CURRENT} failed (exit ${moved.exitCode}: ${lastLine(moved.stderr)})`,
        };
      }
      kind = "moved";
    }
    const staleMirror = declaresRootMirrorSource(target.dir);
    if (kind !== "moved" && !staleMirror) return { kind: "verdict", verdict: { kind, note: null } };
    const lines = kind === "moved" ? [...MOVE_NOTE] : ["> [!NOTE]"];
    if (staleMirror) lines.push(...(kind === "moved" ? [">"] : []), ...MIRROR_ADVICE);
    return { kind: "verdict", verdict: { kind, note: { text: lines.join("\n"), review: false } } };
  },
};
