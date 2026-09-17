#!/usr/bin/env bun
// The overlay starter seeded `homepage: ""` fleet-wide, and the apply clears a declared empty field, so a homepage set
// on GitHub was wiped by every apply; the platform stopped managing the homepage, and this rung deletes the seeded key
// from the overlays that already have it. The repository's own GitHub address is the same nothing spelled out; the
// repository is read from the checkout's `origin`, which every sync checkout carries.
// stdout is the runner's (sync/migrate.ts): the overlay's path when it was written, nothing otherwise.
//
// Usage: bun migrations/0002-homepage-unmanaged.ts <checkout>

import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Document, isMap, isNode, isScalar, parseDocument } from "yaml";
import { capture } from "../.github/scripts/shared/proc.ts";

const OVERLAY = ".github/settings.local.yml";
const RUNG = "0002-homepage-unmanaged";

export type Judgment =
  | { verdict: "absent" }
  | { verdict: "removed"; text: string }
  | { verdict: "kept" }
  | { verdict: "refused"; reason: string };

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `owner/repo` from origin's URL in the forms git accepts for GitHub: https (with userinfo or a port), ssh and
 *  git+ssh (with a port, `ssh.github.com` for SSH over 443), and the scp-like `git@github.com:owner/repo`; null
 *  for anything else. */
export function repositoryOf(originUrl: string): string | null {
  const match =
    /^(?:(?:git\+)?(?:https?|ssh):\/\/(?:[^@/]+@)?(?:ssh\.)?github\.com(?::\d+)?\/|[^@/:]+@(?:ssh\.)?github\.com:)([^/:]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      originUrl.trim(),
    );
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** GitHub resolves the address case-insensitively, with or without a trailing slash or `.git`. */
export function isOwnAddress(value: string, repository: string): boolean {
  const [owner, repo] = repository.split("/", 2);
  return new RegExp(
    `^https://github\\.com/${escaped(owner)}/${escaped(repo)}(?:\\.git|/)?$`,
    "i",
  ).test(value.trim());
}

type Overlay = { repository?: { homepage?: unknown } | null };

/** A copy with no shared references: an alias of a whole block resolves to the SAME object, and deleting the homepage
 *  from a shared one would delete it from every alias too. Not a JSON round trip, which reads `.nan` as null and
 *  would hide a change between the two. A cycle, or a value that is not a plain object or array (a `!!set`, a
 *  `!!omap`, a `!!binary`), throws: the comparison below cannot see inside it. */
function plain(value: unknown, ancestors: unknown[] = []): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.includes(value)) throw new RangeError("cyclic document");
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw new TypeError("not a plain document");
  }
  const inner = [...ancestors, value];
  if (Array.isArray(value)) return value.map((item) => plain(item, inner));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      plain(item, inner),
    ]),
  );
}

/** Null when the text does not read as one plain document: a syntax error, an alias its anchor no longer precedes
 *  (which the parser reports only when the value is read), or a cyclic alias. An empty or comments-only file reads
 *  as `{}`, as the settings loader reads it. */
function readOverlay(text: string): { doc: Document; js: Overlay } | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  try {
    return { doc, js: (plain(doc.toJS()) ?? {}) as Overlay };
  } catch {
    return null;
  }
}

/** The value is judged resolved (an alias reads as what it names), and the repository is consulted only for a value
 *  that could be its address. YAML has more ways to spell a pair than a line cut can honour (flow separators,
 *  explicit keys, anchors, merge keys), so the edited text must read as the original minus that one key or the edit
 *  is refused. */
export function judgeOverlay(text: string, repository: () => string | null): Judgment {
  const read = readOverlay(text);
  if (read === null) return { verdict: "absent" };
  const { doc, js: before } = read;
  const value = before.repository?.homepage;
  if (value === undefined) return { verdict: "absent" };
  const empty = value === null || (typeof value === "string" && value.trim() === "");
  if (!empty) {
    if (typeof value !== "string") return { verdict: "kept" };
    const own = repository();
    if (own === null) {
      return {
        verdict: "refused",
        reason: "the checkout's origin does not name a GitHub repository",
      };
    }
    if (!isOwnAddress(value, own)) return { verdict: "kept" };
  }
  const repositoryMap = doc.get("repository", true);
  const pair = isMap(repositoryMap)
    ? repositoryMap.items.find((item) => isScalar(item.key) && item.key.value === "homepage")
    : undefined;
  const keyRange = pair !== undefined && isScalar(pair.key) ? pair.key.range : null;
  if (pair === undefined || keyRange == null) {
    return { verdict: "refused", reason: "its homepage key is not written as a plain line" };
  }
  const node = isNode(pair.value) ? pair.value : null;
  const valueEnd = node?.range != null ? node.range[1] : keyRange[1];
  const lineStart = text.lastIndexOf("\n", keyRange[0] - 1) + 1;
  const newline = text.indexOf("\n", Math.max(valueEnd - 1, lineStart));
  const lineEnd = newline === -1 ? text.length : newline + 1;
  const alone =
    text.indexOf("\n", lineStart) === newline &&
    text.slice(lineStart, keyRange[0]).trim() === "" &&
    /^[ \t]*(?:#.*)?\r?\n?$/.test(text.slice(valueEnd, lineEnd));
  if (!alone) return { verdict: "refused", reason: "its homepage line holds other content too" };
  const edited = text.slice(0, lineStart) + text.slice(lineEnd);
  const expected = plain(before) as Overlay;
  delete expected.repository?.homepage;
  const after = readOverlay(edited);
  if (after === null || !Bun.deepEquals(after.js, expected, true)) {
    return {
      verdict: "refused",
      reason: "removing its homepage line would change more than the homepage",
    };
  }
  return { verdict: "removed", text: edited };
}

function standing(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function main(checkout: string | undefined): number {
  if (checkout === undefined) {
    console.error("usage: bun migrations/0002-homepage-unmanaged.ts <checkout>");
    return 2;
  }
  // File APIs follow symbolic links, so a linked ancestor would carry the write outside the checkout (the writer's
  // insideTarget rule); a link at the overlay itself is left for the writer to refuse.
  for (let dir = dirname(OVERLAY); dir !== "."; dir = dirname(dir)) {
    if (standing(join(checkout, dir))?.isSymbolicLink()) {
      console.error(
        `${OVERLAY}: its ancestor '${dir}' is a symbolic link, so the write could leave the checkout`,
      );
      return 1;
    }
  }
  const path = join(checkout, OVERLAY);
  if (standing(path)?.isFile() !== true) return 0;
  const judged = judgeOverlay(readFileSync(path, "utf-8"), () => {
    const origin = capture(["git", "-C", checkout, "remote", "get-url", "origin"]);
    return origin.exitCode === 0 ? repositoryOf(origin.stdout) : null;
  });
  if (judged.verdict === "refused") {
    console.error(`${RUNG}: ${OVERLAY}: ${judged.reason}; settle the homepage line by hand`);
    return 1;
  }
  if (judged.verdict !== "removed") return 0;
  writeFileSync(path, judged.text);
  console.log(OVERLAY);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv[2]));
