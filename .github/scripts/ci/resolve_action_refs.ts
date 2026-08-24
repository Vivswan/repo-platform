// Prove every third-party action pin resolves to a real git ref.
//
// actionlint and the ssot action-pins rule keep pins consistent, but
// nothing local can tell that a ref exists upstream: a pin like
// setup-uv@v9 (astral-sh publishes no moving major tags past v7) passes
// every offline gate and then fails at job start, fleet-wide once synced.
// This script asks the GitHub API, so it runs as its own CI job rather
// than inside `bun run check` (which must work offline).
//
// Scanned: workflow YAML, composite action.yml files, and template
// .jinja sources. Skipped: local `./` paths and refs carrying template
// expressions (resolved only at render time).

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capture } from "../shared/proc";

export interface ActionRef {
  /** owner/repo, the resolvable unit. */
  repo: string;
  ref: string;
  /** Files that carry this pin, for the error message. */
  sources: string[];
}

const USES_RE = /(?:^|\s)uses:\s*["']?([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([^\s"']+)/;

export type Resolution =
  | { ok: true }
  | { ok: false; kind: "dangling" | "unverifiable"; detail: string };

/** Resolvable = the ref names a commit (tag, branch, or SHA). HTTP 404/422
 * mean the ref (or repo) does not exist; any other failure is an
 * operational problem (rate limit, auth, outage) reported as such so the
 * error never advises repinning a ref that may be fine. */
export function resolve(repo: string, ref: string): Resolution {
  const result = capture(["gh", "api", `repos/${repo}/commits/${encodeURIComponent(ref)}`]);
  if (result.exitCode === 0) return { ok: true };
  if (/HTTP 404|HTTP 422/.test(result.stderr))
    return { ok: false, kind: "dangling", detail: result.stderr.trim() };
  return { ok: false, kind: "unverifiable", detail: result.stderr.trim() };
}

/** Collect unique owner/repo@ref pins from the given file contents. */
export function collectRefs(files: Array<{ path: string; text: string }>): ActionRef[] {
  const byPin = new Map<string, ActionRef>();
  for (const { path, text } of files) {
    for (const line of text.split("\n")) {
      const match = USES_RE.exec(line);
      if (!match) continue;
      const [, target, ref] = match;
      if (target.startsWith("./") || target.includes("{{") || ref.includes("{{")) continue;
      const repo = target.split("/").slice(0, 2).join("/");
      const key = `${repo}@${ref}`;
      const entry = byPin.get(key) ?? { repo, ref, sources: [] };
      if (!entry.sources.includes(path)) entry.sources.push(path);
      byPin.set(key, entry);
    }
  }
  return [...byPin.values()].sort(
    (a, b) => a.repo.localeCompare(b.repo) || a.ref.localeCompare(b.ref),
  );
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    // lstat: a dangling symlink (bun leaves them in node_modules/.bin,
    // and templates/agents/ ships symlinks on purpose) must not throw.
    const entry = lstatSync(path);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && /\.(ya?ml|jinja)$/.test(name)) yield path;
  }
}

if (import.meta.main) {
  const files = [".github/workflows", "actions", "templates"]
    .flatMap((root) => [...walk(root)])
    .map((path) => ({ path, text: readFileSync(path, "utf-8") }));
  const refs = collectRefs(files);
  let failures = 0;
  for (const pin of refs) {
    const result = resolve(pin.repo, pin.ref);
    if (result.ok) continue;
    failures += 1;
    if (result.kind === "dangling") {
      console.error(
        `::error::action-refs: ${pin.repo}@${pin.ref} does not resolve to any ` +
          `commit, tag, or branch upstream (pinned in ${pin.sources.join(", ")}). ` +
          "Check the repository's published tags and pin one that exists.",
      );
    } else {
      console.error(
        `::error::action-refs: could not verify ${pin.repo}@${pin.ref} ` +
          `(${result.detail}). This is an API problem (rate limit, auth, ` +
          "outage), not evidence the pin is wrong - re-run the job.",
      );
    }
  }
  if (failures > 0) process.exit(1);
  console.log(`action-refs: all ${refs.length} pinned refs resolve`);
}
