#!/usr/bin/env bun
// Judges a repository against what this tree's writer writes: the repository is copied to scratch, the writer runs over
// the copy, and every path whose bytes then differ is a finding, the manifest's own line included, as is every reason
// the writer would hold the sync PR for. Byte to byte on purpose: a pending registration change reads as red until the
// sync that carries it lands.
//
// Usage: bun actions/validate-managed-files/check.ts --target <checkout> --repository <owner/name> --private <true|false> --build <full sha> [--upstream <raw-content host>]
//   exit 0  the repository is what this tree writes
//   exit 1  findings: the writer's hold reasons, then one line per path with a unified diff under each
//   exit 2  the writer refused; its message is the output

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstatOrNull } from "../../.github/scripts/shared/fs_probe.ts";
import { fail } from "../../.github/scripts/shared/gha.ts";
import { capture } from "../../.github/scripts/shared/proc.ts";
import { parseFlags } from "../../.github/scripts/sync/writer/flags.ts";
import { MirrorFailure } from "../../.github/scripts/sync/writer/mirrors.ts";
import { type SyncReport, unifiedDiff } from "../../.github/scripts/sync/writer/report.ts";
import { runSync } from "../../.github/scripts/sync/writer/sync.ts";
import { RAW_HOST } from "../../.github/scripts/sync/writer/upstream.ts";
import { PLATFORM_NAME } from "../shared/platform.ts";

const PLATFORM_ROOT = resolve(import.meta.dir, "../..");

/** A regular file's bytes or a symbolic link's target, never read through the link. */
type Entry = { kind: "file"; bytes: Buffer } | { kind: "link"; target: Buffer };
type Tree = Map<string, Entry>;

/** What git sees when the target is a checkout's root (tracked, plus untracked and not ignored), else every path but
 *  .git: the writer must run over what a sync's clone holds, and an ignored file is not in it. A plain tree inside some
 *  other checkout answers git too, with that checkout's index, so only the root's own is read. */
function listPaths(root: string): string[] {
  const top = capture(["git", "rev-parse", "--show-toplevel"], { cwd: root });
  if (top.exitCode !== 0 || realpathSync(top.stdout.trimEnd()) !== realpathSync(root)) {
    return walk(root);
  }
  const listed = capture(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
  });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed in the target: ${listed.stderr}`);
  return listed.stdout.split("\0").filter((path) => path !== "");
}

function walk(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((dirent) => {
    const rel = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
    if (rel === ".git") return [];
    return dirent.isDirectory() ? walk(root, rel) : [rel];
  });
}

/** A path under a symbolic link inside the root is left out: the link itself is copied, and a copy of its descendants
 *  would write through the scratch's link to wherever it points (the writer refuses such paths too). */
function underLink(root: string, path: string, links: Map<string, boolean>): boolean {
  for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
    let linked = links.get(dir);
    if (linked === undefined) {
      linked = lstatOrNull(join(root, dir))?.isSymbolicLink() === true;
      links.set(dir, linked);
    }
    if (linked) return true;
  }
  return false;
}

function treeOf(root: string, paths: string[]): Tree {
  const tree: Tree = new Map();
  const links = new Map<string, boolean>();
  for (const path of paths) {
    if (underLink(root, path, links)) continue;
    const abs = join(root, path);
    const stat = lstatOrNull(abs);
    if (stat?.isSymbolicLink()) {
      tree.set(path, { kind: "link", target: readlinkSync(abs, { encoding: "buffer" }) });
    } else if (stat?.isFile()) {
      tree.set(path, { kind: "file", bytes: readFileSync(abs) });
    }
  }
  return tree;
}

function copy(tree: Tree, from: string, to: string): void {
  for (const [path, entry] of tree) {
    const dest = join(to, path);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.kind === "link") symlinkSync(entry.target, dest);
    else copyFileSync(join(from, path), dest);
  }
}

/** Bytes, never decoded text: an invalid sequence and U+FFFD decode alike. */
function same(a: Entry, b: Entry): boolean {
  if (a.kind === "file" && b.kind === "file") return a.bytes.equals(b.bytes);
  if (a.kind === "link" && b.kind === "link") return a.target.equals(b.target);
  return false;
}

/** What the diff shows for an entry: a file's text, a link as one `-> target` line, nothing for an absent path. */
function shown(entry: Entry | undefined): string {
  if (entry === undefined) return "";
  return entry.kind === "file"
    ? entry.bytes.toString("utf-8")
    : `-> ${entry.target.toString("utf-8")}`;
}

/** `before` is the repository, `after` the writer's copy; the diff's + lines are what the writer writes. */
function finding(
  path: string,
  before: Entry | undefined,
  after: Entry | undefined,
  build: string,
): string[] {
  if (before !== undefined && after !== undefined && same(before, after)) return [];
  const verdict =
    before === undefined
      ? `${build} would create it`
      : after === undefined
        ? `${build} would remove it`
        : `differs from what ${build} writes`;
  const was = shown(before);
  const is = shown(after);
  // Equal text under an unequal verdict is a byte-only edit when both sides are of one kind; a presence or kind change
  // (an empty file created or removed) has nothing more to show than its verdict line.
  if (was === is) {
    const bytesOnly = before !== undefined && after !== undefined && before.kind === after.kind;
    return bytesOnly
      ? [`${path}: ${verdict}`, "(the bytes differ where the decoded text does not)"]
      : [`${path}: ${verdict}`];
  }
  return [`${path}: ${verdict}`, unifiedDiff(path, was, is)];
}

async function main(argv: string[]): Promise<number> {
  const flags = parseFlags(
    argv,
    ["--target", "--repository", "--private", "--build"] as const,
    ["--upstream"] as const,
  );
  if (flags["--private"] !== "true" && flags["--private"] !== "false") {
    fail("--private must be true or false");
  }
  if (!/^[0-9a-f]{40}$/.test(flags["--build"])) {
    fail("--build must be the platform commit's full sha (40 lowercase hex characters)");
  }
  const target = resolve(flags["--target"]);
  const short = flags["--build"].slice(0, 12);
  const scratch = mkdtempSync(join(tmpdir(), `${PLATFORM_NAME}-check-`));
  try {
    const before = treeOf(target, listPaths(target));
    copy(before, target, scratch);
    let report: SyncReport;
    try {
      report = await runSync({
        files: join(PLATFORM_ROOT, "files.yml"),
        tree: join(PLATFORM_ROOT, "files"),
        target: scratch,
        build: flags["--build"],
        repository: flags["--repository"],
        private: flags["--private"] === "true",
        upstream: flags["--upstream"] ?? RAW_HOST,
      });
    } catch (error) {
      const lines =
        error instanceof MirrorFailure
          ? error.lines
          : [error instanceof Error ? error.message : String(error)];
      console.log(lines.join("\n"));
      return 2;
    }
    const after = treeOf(scratch, walk(scratch));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    // A hold leaves the path as it stands, so the bytes alone would read it as clean.
    const findings = [
      ...report.holdReasons,
      ...paths.flatMap((path) => finding(path, before.get(path), after.get(path), short)),
    ];
    console.log(
      findings.length === 0 ? `the repository is what ${short} writes` : findings.join("\n"),
    );
    return findings.length === 0 ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
