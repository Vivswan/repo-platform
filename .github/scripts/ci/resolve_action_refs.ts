// Prove every action pin resolves to a real git ref, and that a sha pin's
// trailing version comment names the release that sha is.
//
// actionlint and the ssot action-pins rule keep pins consistent and
// sha-shaped, but nothing local can tell that a ref exists upstream or
// that `# v7.0.1` really is the commit pinned beside it: a dangling ref
// passes every offline gate and then fails at job start, fleet-wide once
// synced, and a lying comment misleads every reviewer and Dependabot.
// This script asks the GitHub API, so it runs as its own CI job rather
// than inside `bun run check` (which must work offline).
//
// Scanned: workflow YAML, composite action manifests, template .jinja
// sources, and the sync writer's files/ sources (its workflow block files
// are plain .yml). Skipped: local `./` paths and refs carrying template
// expressions (resolved only at render time). A comment naming a branch
// (`# master`) is not judged: branch heads move by design.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../shared/proc";

export interface ActionRef {
  /** owner/repo, the resolvable unit. */
  repo: string;
  ref: string;
  /** The release tag a trailing `# vX.Y.Z` comment claims the ref is;
   *  null for no comment or a branch comment. */
  version: string | null;
  /** Files that carry this pin, for the error message. */
  sources: string[];
}

const USES_RE =
  /(?:^|\s)uses:\s*["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s"']+)["']?(?:[ \t]+#[ \t]*(v\d+\.\d+\.\d+)(?=\s|$))?/;

/** A failed lookup names the ref that failed: the pinned sha or the tag
 * its comment claims, which the message must tell apart. */
export type Resolution =
  | { ok: true }
  | { ok: false; kind: "dangling" | "unverifiable"; ref: string; detail: string }
  | { ok: false; kind: "stale-comment"; detail: string };

/** The commit a ref names, or why it could not be read: HTTP 404/422 mean
 * the ref (or repo) does not exist; any other failure is an operational
 * problem (rate limit, auth, outage) reported as such so the error never
 * advises repinning a ref that may be fine. */
function commitOf(
  repo: string,
  ref: string,
):
  | { ok: true; sha: string }
  | { ok: false; kind: "dangling" | "unverifiable"; ref: string; detail: string } {
  const result = capture([
    "gh",
    "api",
    `repos/${repo}/commits/${encodeURIComponent(ref)}`,
    "--jq",
    ".sha",
  ]);
  if (result.exitCode === 0) return { ok: true, sha: result.stdout.trim() };
  if (/HTTP 404|HTTP 422/.test(result.stderr))
    return { ok: false, kind: "dangling", ref, detail: result.stderr.trim() };
  return { ok: false, kind: "unverifiable", ref, detail: result.stderr.trim() };
}

/** Resolvable = the ref names a commit (tag, branch, or SHA) and, when a
 * version comment rides beside it, that tag's commit IS the pinned ref. */
export function resolve(repo: string, ref: string, version: string | null = null): Resolution {
  const pinned = commitOf(repo, ref);
  if (!pinned.ok) return pinned;
  if (version === null) return { ok: true };
  const claimed = commitOf(repo, version);
  if (!claimed.ok) return claimed;
  if (claimed.sha === pinned.sha) return { ok: true };
  return {
    ok: false,
    kind: "stale-comment",
    detail: `${version} is commit ${claimed.sha}, not ${pinned.sha}`,
  };
}

/** Collect unique owner/repo@ref pins from the given file contents, keyed
 * by ref AND version comment so one sha claiming two releases stays two
 * entries (the ssot rule reds that split; here each claim is verified). */
export function collectRefs(files: Array<{ path: string; text: string }>): ActionRef[] {
  const byPin = new Map<string, ActionRef>();
  for (const { path, text } of files) {
    for (const line of text.split("\n")) {
      const match = USES_RE.exec(line);
      if (!match) continue;
      const [, target, ref, version] = match;
      if (target.startsWith("./") || target.includes("{{") || ref.includes("{{")) continue;
      const repo = target.split("/").slice(0, 2).join("/");
      const key = `${repo}@${ref} # ${version ?? ""}`;
      const entry = byPin.get(key) ?? { repo, ref, version: version ?? null, sources: [] };
      if (!entry.sources.includes(path)) entry.sources.push(path);
      byPin.set(key, entry);
    }
  }
  return [...byPin.values()].sort(
    (a, b) =>
      a.repo.localeCompare(b.repo) ||
      a.ref.localeCompare(b.ref) ||
      (a.version ?? "").localeCompare(b.version ?? ""),
  );
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    // lstat: a dangling symlink (bun leaves them in node_modules/.bin,
    // and templates/base/ ships the agent-file symlinks on purpose) must not throw.
    const entry = lstatSync(path);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && /\.(ya?ml|jinja)$/.test(name)) yield path;
  }
}

if (import.meta.main) {
  const files = [".github/workflows", "actions", "templates", "files"]
    .flatMap((root) => [...walk(root)])
    .map((path) => ({ path, text: readFileSync(path, "utf-8") }));
  const refs = collectRefs(files);
  let failures = 0;
  for (const pin of refs) {
    const result = resolve(pin.repo, pin.ref, pin.version);
    if (result.ok) continue;
    failures += 1;
    if (result.kind === "dangling") {
      const claimed = result.ref !== pin.ref;
      console.error(
        `::error::action-refs: ${pin.repo}@${result.ref}${claimed ? ` (the comment beside ${pin.ref})` : ""} ` +
          "does not resolve to any commit, tag, or branch upstream " +
          `(pinned in ${pin.sources.join(", ")}). ` +
          (claimed
            ? "Name the release the pinned sha is."
            : "Check the repository's published tags and pin one that exists."),
      );
    } else if (result.kind === "stale-comment") {
      console.error(
        `::error::action-refs: ${pin.repo}@${pin.ref} # ${pin.version}: ${result.detail} ` +
          `(pinned in ${pin.sources.join(", ")}). Re-pin the sha the comment names, or ` +
          "fix the comment.",
      );
    } else {
      console.error(
        `::error::action-refs: could not verify ${pin.repo}@${result.ref} ` +
          `(${result.detail}). This is an API problem (rate limit, auth, ` +
          "outage), not evidence the pin is wrong - re-run the job.",
      );
    }
  }
  if (failures > 0) process.exit(1);
  console.log(`action-refs: all ${refs.length} pinned refs resolve`);
}
