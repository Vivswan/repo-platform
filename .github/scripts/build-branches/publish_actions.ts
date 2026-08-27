#!/usr/bin/env bun
// Copies actions/ onto the generated `template` build branch, so a fleet
// repository can pin `<owner>/repo-platform/actions/<name>@template`.
//
// Why the template branch and not main: build-branches only advances that
// ref from a main commit whose CI run succeeded, and publish.ts re-verifies
// the conclusion through the API rather than trusting the trigger. Pinning
// action code there means the fleet runs only green action code, where
// @main is whatever landed most recently. It also means a fix reaches every
// repository as soon as main goes green, with no sync PR.
//
// Copier never sees these files. copier.yml sets `_subdirectory: template`,
// so only that subtree is rendered; the root holds copier.yml and whatever
// else we put beside it, which stamp_manifest.ts has relied on all along.
//
// What ships is SOURCE plus the dependency manifests. node_modules is
// excluded deliberately: each action installs at its own action_path when
// it runs, so shipping a tree here would be dead weight that also goes
// stale against the lockfile.

import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Directories never published: build output and installed dependencies,
 *  both reproducible from what is published. */
export const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo"]);

/** Copies every action directory to `<dest>/actions`, returning the number
 *  of files written. Throws when the source has no actions at all, because
 *  the rendered workflows reference them by path: publishing a branch
 *  without them would 404 every fleet CI run rather than fail here. */
export function copyActions(repoRoot: string, dest: string): number {
  const source = join(repoRoot, "actions");
  if (!existsSync(source)) {
    throw new Error(
      `no actions/ directory at ${repoRoot} - the rendered workflows call ` +
        "actions by path, so a template branch without them breaks every " +
        "fleet CI run; check the checkout before publishing",
    );
  }
  const names = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`actions/ at ${repoRoot} holds no action directories`);
  }
  let files = 0;
  for (const name of names) {
    cpSync(join(source, name), join(dest, "actions", name), {
      recursive: true,
      filter: (src) => {
        const segments = src.split("/");
        return !segments.some((segment) => EXCLUDED_DIRS.has(segment));
      },
    });
    files += countFiles(join(dest, "actions", name));
  }
  return files;
}

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    total += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return total;
}
