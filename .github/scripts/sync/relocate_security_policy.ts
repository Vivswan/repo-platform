#!/usr/bin/env bun
// One-shot fleet transition: SECURITY.md leaves the repository root for
// .github/SECURITY.md, where the template now renders it. The file is a
// split (repository-owned content outside the managed region), so it is
// moved with `git mv` and committed BEFORE copier runs: the split-file
// rebuild then finds the previous copy at the new path (HEAD's manifest
// does not declare it yet - the ownership-flip fallback), while a plain
// rename would have retired-file cleanup delete the tail. CODE_OF_CONDUCT.md
// is not moved here: it has no repository-owned half, and moving it ahead
// of copier would strand the copy on a public->private flip, where the new
// render carries it at neither path.
//
// Single owner of the file's location: BOTH paths or a non-file fails
// loudly; NEITHER is fine (the update renders it fresh). Self-retiring once
// the fleet has crossed. Invoked by reusable-template-sync.yml right after
// the registration check and replayed by rehearse.ts in the same slot.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { env, error, notice, requireEnv } from "../shared/gha.ts";
import { declarationSource, readMirrors } from "./materialize_mirrors.ts";
import { commitRelocation, type Location, relocateFile } from "./relocate.ts";
import { SECURITY_MOVE_NAME } from "./section_files.ts";

/** The security policy's canonical landed path. */
export const SECURITY_PATH = ".github/SECURITY.md";

/** The retired pre-move path (the policy at the repository root). */
export const LEGACY_SECURITY_PATH = "SECURITY.md";

/** Where the target keeps its security policy, moving a legacy-path file
 * to SECURITY_PATH (bytes untouched - `git mv` renames the blob) and
 * committing the move so copier sees a clean tree. Pure probe otherwise. */
export function relocateSecurityPolicy(targetDir: string): Location {
  const location = relocateFile(targetDir, LEGACY_SECURITY_PATH, SECURITY_PATH);
  if (location === "moved") {
    commitRelocation(targetDir, `chore: move the security policy to ${SECURITY_PATH}`, [
      LEGACY_SECURITY_PATH,
      SECURITY_PATH,
    ]);
  }
  return location;
}

/** Whether the target's own `mirrors` declaration names the retired path
 * as a source: the materialize step refuses it after the move (a source
 * must be a rendered path), so the note tells the human the replacement.
 * A declaration that cannot be read counts as not declaring it - the
 * mirrors step reports its own refusal. */
export function declaresLegacyMirrorSource(targetDir: string): boolean {
  const { text } = declarationSource(targetDir);
  if (text === null) return false;
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return false;
  }
  return readMirrors(data).mirrors.some((mirror) => mirror.source === LEGACY_SECURITY_PATH);
}

const MOVE_NOTE = [
  "> [!NOTE]",
  `> SECURITY POLICY MOVE: this update moves \`${LEGACY_SECURITY_PATH}\` to`,
  `> \`${SECURITY_PATH}\`, byte-for-byte - the repository's own content outside`,
  "> the managed region rides the move verbatim, and GitHub reads the policy",
  "> from `.github/` exactly as it did from the root. One-time transition:",
  "> the repository root keeps only repo content plus `.repo-platform.yml`;",
  "> community health files live under `.github/`.",
];

const MIRROR_ADVICE = [
  `> This repository's \`.repo-platform.yml\` declares a \`mirrors\` source at the`,
  `> retired path: change \`source: ${LEGACY_SECURITY_PATH}\` to`,
  `> \`source: ${SECURITY_PATH}\`. Until then the mirror step refuses that entry`,
  "> and holds the PR.",
];

/** The PR-body note: the move (when one happened) and the stale-mirror
 * advice (whenever the declaration still names the retired path, moved or
 * not - the refusal repeats every sync until the human repoints it); ""
 * when neither applies. */
export function securityMoveNote(location: Location, legacyMirrorSource: boolean): string {
  const moved = location === "moved";
  if (!moved && !legacyMirrorSource) return "";
  const lines = moved ? [...MOVE_NOTE] : ["> [!NOTE]"];
  if (legacyMirrorSource) lines.push(...(moved ? [">"] : []), ...MIRROR_ADVICE);
  lines.push("");
  return lines.join("\n");
}

function main(): number {
  const targetDir = env("TARGET_DIR", "target");
  const display = env("TARGET_DISPLAY");
  const location = relocateSecurityPolicy(targetDir);
  const legacyMirrorSource = declaresLegacyMirrorSource(targetDir);
  writeFileSync(
    join(requireEnv("RUNNER_TEMP"), SECURITY_MOVE_NAME),
    securityMoveNote(location, legacyMirrorSource),
    "utf-8",
  );
  switch (location) {
    case "in-place":
      console.log(`security policy already at ${SECURITY_PATH}; nothing to move`);
      return 0;
    case "missing":
      console.log(`no security policy at either path; the update renders ${SECURITY_PATH} fresh`);
      return 0;
    case "moved":
      notice(
        `${display}: moved ${LEGACY_SECURITY_PATH} to ${SECURITY_PATH} (bytes unchanged; ` +
          "one-time transition, committed onto the update branch) - the PR body carries the note.",
      );
      return 0;
    case "both":
      error(
        `${display} carries a security policy at BOTH ${SECURITY_PATH} and the retired root ` +
          `path ${LEGACY_SECURITY_PATH}. The template renders only ${SECURITY_PATH}; merge any ` +
          "repository-specific content into it and delete the root copy on the default branch, " +
          "then re-run the sync.",
      );
      return 1;
    case "not-a-file":
      error(
        `${display} carries something other than a regular file at ${SECURITY_PATH} or ` +
          `${LEGACY_SECURITY_PATH} (a directory or a symlink). The sync refuses to guess: fix ` +
          "the default branch by hand, then re-run the sync.",
      );
      return 1;
    case "unsafe-parent":
      error(
        `${display}'s ${dirname(SECURITY_PATH)} is not a real directory (a symlink or a file), so ` +
          `${LEGACY_SECURITY_PATH} cannot be moved beneath it. The sync refuses to write through ` +
          "it: fix the default branch by hand, then re-run the sync.",
      );
      return 1;
  }
}

if (import.meta.main) {
  process.exit(main());
}
