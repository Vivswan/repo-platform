#!/usr/bin/env bun
// Sweeps the `ci-build-<token>` ref namespaces a SIGKILLed
// upgrade_path_test.sh run leaves behind (its EXIT trap never fires).
// Linked worktrees share one ref store and the tokens are random, so
// ownership comes from the namespace's own annotated `/run` tag (pid,
// host, start time, fixture dir), never from the name.
//
// Usage: bun .github/scripts/ci/sweep_harness_namespaces.ts [--execute] [--force-unowned] [--repo <path>]

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { capture } from "../shared/proc.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const NAMESPACE_REF = /^refs\/(?:tags|heads)\/(ci-build-[^/]+)(?:\/|$)/;
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
    const name = match[1];
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

/** `kill -0` semantics: alive when the signal is deliverable, and also when
 * it is refused (EPERM), which only a live process of another user does. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface Judge {
  host: string;
  alive: (pid: number) => boolean;
  dirPresent: (dir: string) => boolean;
  forceUnowned: boolean;
}

export function judge(namespace: Namespace, by: Judge): Verdict {
  const { owner, refs } = namespace;
  const count = `${refs.length} ref${refs.length === 1 ? "" : "s"}`;
  if (owner === null) {
    return by.forceUnowned
      ? { kind: "delete", reason: `no owner record (--force-unowned); ${count}` }
      : {
          kind: "keep",
          reason: `no owner record (killed before writing its /run tag, or a pre-owner leftover); ${count}, --force-unowned deletes`,
        };
  }
  const who = `pid ${owner.pid}, started ${owner.started}`;
  if (owner.host !== by.host) {
    return { kind: "keep", reason: `owned on host ${owner.host} (${who}); sweep it from there` };
  }
  if (by.alive(owner.pid))
    return { kind: "refuse", reason: `owner alive (${who}, dir ${owner.dir})` };
  const dir = by.dirPresent(owner.dir)
    ? `dir ${owner.dir} still present: rm -rf it, then git worktree prune`
    : `dir ${owner.dir} gone`;
  return { kind: "delete", reason: `owner dead (${who}); ${count}; ${dir}` };
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
    alive: processAlive,
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
