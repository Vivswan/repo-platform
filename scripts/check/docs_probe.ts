#!/usr/bin/env bun
// The docs probe is the docs-discipline skill's script, run from a checkout of the skills repository at one pinned
// commit: the same way ci.yml runs that repository's actions, and runnable locally, so CI's invariants job and
// `bun run check` judge the pages the same way. Arguments pass through to the probe, and so does its exit code.
//   0  every page clean      1  findings, one per line      2  usage, or a page the probe cannot read
// A clone or checkout failure is exit 2 too: a probe that never ran is no verdict.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passthrough } from "../../.github/scripts/shared/proc.ts";

/** The commit of Vivswan/skills the probe runs from: the sha ci.yml pins that repository's actions at. */
export const SKILLS_SHA = "2031d7d7cf0d57af6cbe60947bf81a904b8d7e50";
const SKILLS_REPOSITORY = "https://github.com/Vivswan/skills";
const PROBE = "skills/docs-discipline/scripts/docs-probe.mts";

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function main(args: string[]): number {
  // Under bun's default disposition a signal ends this process before the finally runs and the checkout stays behind;
  // a no-op handler lets the child return (it gets the same signal) so the directory is removed on that path too.
  for (const signal of FORWARDED_SIGNALS) process.on(signal, () => {});
  const dir = mkdtempSync(join(tmpdir(), "docs-probe-skills-"));
  try {
    // A blobless clone, then the pinned commit's one file: the probe is one file of one commit.
    const fetched =
      passthrough([
        "git",
        "clone",
        "--quiet",
        "--filter=blob:none",
        "--no-checkout",
        SKILLS_REPOSITORY,
        dir,
      ]) === 0 &&
      passthrough(["git", "fetch", "--quiet", "--depth", "1", "origin", SKILLS_SHA], {
        cwd: dir,
      }) === 0 &&
      passthrough(["git", "checkout", "--quiet", SKILLS_SHA, "--", PROBE], { cwd: dir }) === 0;
    if (!fetched) {
      console.error(`docs-probe: could not check out ${SKILLS_REPOSITORY} at ${SKILLS_SHA}`);
      return 2;
    }
    return passthrough(["bun", join(dir, PROBE), ...args]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
