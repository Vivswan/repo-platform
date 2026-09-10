#!/usr/bin/env bun
// Sweeps the `ci-build-<token>` ref namespaces a SIGKILLed upgrade-path
// harness run (tests/ci/upgrade_path/) leaves in the ref store every linked
// worktree shares; ownership comes
// from the namespace's own annotated `/run` tag, never from its random name.
//
// Usage: bun .github/scripts/ci/sweep_harness_namespaces.ts [--execute] [--force-unowned] [--repo <path>]

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { capture } from "../shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
/** The tag names the harness creates under its namespace
 * (NAMESPACE_TAG_NAMES in tests/ci/upgrade_path/fixture.ts; the test pins
 * the two lists together). */
export const HARNESS_TAG_NAMES = ["run", "old", "new", "split", "probe1", "probe2"] as const;
/** Exactly the harness's shape: `ci-build-` plus mktemp's six-character
 * token, as the branch itself or one of the tags above. A lookalike such as
 * refs/heads/ci-build-release is not a namespace and is never touched. */
const NAMESPACE_REF = new RegExp(
  `^refs/(?:heads/(ci-build-[A-Za-z0-9]{6})|tags/(ci-build-[A-Za-z0-9]{6})/(?:${HARNESS_TAG_NAMES.join("|")}))$`,
);
const USAGE =
  "usage: sweep_harness_namespaces.ts [--dry-run | --execute] [--force-unowned] [--repo <path>]";

export interface Options {
  execute: boolean;
  forceUnowned: boolean;
  repo: string;
}

/** Owner record the harness writes into `<namespace>/run`. */
export interface RunOwner {
  pid: number;
  host: string;
  started: string;
  dir: string;
}

export interface Namespace {
  name: string;
  /** Full ref names, the `/run` tag last so a failed sweep keeps the owner record. */
  refs: string[];
  /** Null when the `/run` tag is missing, lightweight, or unparsable. */
  owner: RunOwner | null;
}

export type Verdict =
  | { kind: "delete"; reason: string }
  | { kind: "keep"; reason: string }
  | { kind: "refuse"; reason: string };

export function parseArgs(argv: string[], defaultRepo: string): Options {
  const options: Options = { execute: false, forceUnowned: false, repo: defaultRepo };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") options.execute = true;
    else if (arg === "--dry-run") options.execute = false;
    else if (arg === "--force-unowned") options.forceUnowned = true;
    else if (arg === "--repo" && argv[i + 1] !== undefined) options.repo = argv[++i];
    else throw new Error(`unknown argument "${arg}"\n${USAGE}`);
  }
  return options;
}

export function parseRunOwner(subject: string): RunOwner | null {
  const match = /^pid=(\d+) host=(\S+) started=(\S+) dir=(.+)$/.exec(subject);
  if (match === null) return null;
  return { pid: Number(match[1]), host: match[2], started: match[3], dir: match[4] };
}

/** Groups `refname<TAB>objecttype<TAB>subject` lines (git for-each-ref) into
 * namespaces, sorted by name. Only an annotated `/run` tag counts as an
 * owner record: a lightweight one would hand back its commit's subject. */
export function groupNamespaces(listing: string): Namespace[] {
  const byName = new Map<string, { others: string[]; run?: string; owner: RunOwner | null }>();
  for (const line of listing.split("\n")) {
    if (line === "") continue;
    const [refname, objecttype, subject] = line.split("\t");
    const match = NAMESPACE_REF.exec(refname);
    if (match === null) continue;
    const name = match[1] ?? match[2];
    const group = byName.get(name) ?? { others: [], owner: null };
    byName.set(name, group);
    if (refname === `refs/tags/${name}/run`) {
      group.run = refname;
      if (objecttype === "tag") group.owner = parseRunOwner(subject);
    } else {
      group.others.push(refname);
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { others, run, owner }]) => ({
      name,
      refs: run === undefined ? others : [...others, run],
      owner,
    }));
}

/** "dead" only on ESRCH: EPERM is a live process of another user, and any
 * other outcome (a pid outside 1..2^31-1, which kill(0) would read as a
 * process group or reject) leaves the owner unknown, never dead. */
export type Liveness = "alive" | "dead" | "unknown";

export function processLiveness(pid: number): Liveness {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0x7fffffff) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "dead" : code === "EPERM" ? "alive" : "unknown";
  }
}

export interface Judge {
  host: string;
  liveness: (pid: number) => Liveness;
  dirPresent: (dir: string) => boolean;
  forceUnowned: boolean;
}

/** `started` is informational only: liveness is the pid alone, so a recycled
 * pid (an unrelated live process with that number) refuses the sweep even
 * under --force-unowned, by design; the fixture dir names the run to check. */
export function judge(namespace: Namespace, by: Judge): Verdict {
  const { owner, refs } = namespace;
  const count = `${refs.length} ref${refs.length === 1 ? "" : "s"}`;
  const unowned = (why: string, detail: string): Verdict =>
    by.forceUnowned
      ? { kind: "delete", reason: `${why} (--force-unowned); ${count}` }
      : { kind: "keep", reason: `${why} (${detail}); ${count}, --force-unowned deletes` };
  if (owner === null) {
    return unowned(
      "no owner record",
      "a pre-owner leftover, or a /run tag that is not an annotated record",
    );
  }
  const who = `pid ${owner.pid}, started ${owner.started}`;
  if (owner.host !== by.host) {
    return { kind: "keep", reason: `owned on host ${owner.host} (${who}); sweep it from there` };
  }
  const liveness = by.liveness(owner.pid);
  switch (liveness) {
    case "alive":
      return { kind: "refuse", reason: `owner alive (${who}, dir ${owner.dir})` };
    case "unknown":
      return unowned("owner liveness unknown", `${who}, dir ${owner.dir}`);
    case "dead": {
      const dir = by.dirPresent(owner.dir)
        ? `dir ${owner.dir} still present: rm -rf it, then git worktree prune`
        : `dir ${owner.dir} gone`;
      return { kind: "delete", reason: `owner dead (${who}); ${count}; ${dir}` };
    }
    default: {
      // A new Liveness member must be judged here, never fall through to delete.
      const unhandled: never = liveness;
      throw new Error(`unhandled liveness ${String(unhandled)}`);
    }
  }
}

function git(repo: string, args: string[]): string {
  const result = capture(["git", "-C", repo, ...args], { timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    console.error(result.stderr.trimEnd());
    console.error(`git ${args.join(" ")} failed in ${repo}`);
    process.exit(1);
  }
  return result.stdout;
}

function main(argv: string[]): number {
  let options: Options;
  try {
    options = parseArgs(argv, REPO_ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const listing = git(options.repo, [
    "for-each-ref",
    "--format=%(refname)%09%(objecttype)%09%(contents:subject)",
    "refs/tags/",
    "refs/heads/",
  ]);
  const namespaces = groupNamespaces(listing);
  if (namespaces.length === 0) {
    console.log(`no ci-build-* namespaces in ${options.repo}`);
    return 0;
  }
  const by: Judge = {
    host: hostname(),
    liveness: processLiveness,
    dirPresent: existsSync,
    forceUnowned: options.forceUnowned,
  };
  const mode = options.execute ? "execute" : "dry run";
  console.log(`${namespaces.length} ci-build-* namespace(s) in ${options.repo} (${mode})`);
  let deleted = 0;
  for (const namespace of namespaces) {
    const verdict = judge(namespace, by);
    console.log(`  ${verdict.kind.padEnd(7)} ${namespace.name}: ${verdict.reason}`);
    if (verdict.kind !== "delete" || !options.execute) continue;
    for (const ref of namespace.refs) git(options.repo, ["update-ref", "-d", ref]);
    deleted += namespace.refs.length;
  }
  console.log(
    options.execute
      ? `deleted ${deleted} ref${deleted === 1 ? "" : "s"}`
      : "dry run: nothing deleted; pass --execute to act",
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
