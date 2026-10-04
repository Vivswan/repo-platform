// This file is managed by {{github_username}}/repo-platform.
// Local edits are replaced on the next sync.
//
// Every tracked deno.lock, nested ones included, audited from its own directory. The two
// flags are the fleet's audit policy:
//   --frozen      -> a lockfile out of date with its manifest fails loudly
//   --level high  -> a low or moderate advisory is a Dependabot bump, not a red run
//
// node: modules rather than Deno.Command, so the platform's bun test runs the same file; under
// deno, node:child_process builds the child's environment from the parent's, hence --allow-env
// beside --allow-run=git,deno in deno-audit.yml.

import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";

// A git pathspec whose '*' crosses '/'.
const LOCKFILE_PATHSPECS = ["deno.lock", "*/deno.lock"];
const AUDIT = ["audit", "--frozen", "--level", "high"];

/** A signal death has no status; it is a failure like any other. */
function exitCode(status: number | null): number {
  return status ?? 1;
}

function main(): number {
  const listing = spawnSync("git", ["ls-files", "-z", "--", ...LOCKFILE_PATHSPECS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (listing.status !== 0) return exitCode(listing.status);
  const lockfiles = listing.stdout.split("\0").filter((path) => path !== "");
  if (lockfiles.length === 0) {
    console.log("::error::no deno.lock tracked, so nothing was audited; commit the lockfile");
    return 1;
  }
  for (const lockfile of lockfiles) {
    console.log(`auditing ${lockfile}`);
    const audit = spawnSync("deno", AUDIT, { cwd: dirname(lockfile), stdio: "inherit" });
    if (audit.status !== 0) return exitCode(audit.status);
  }
  return 0;
}

process.exit(main());
