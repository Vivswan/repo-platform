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
    `^https://github\\.com/${escaped(owner)}/${escaped(repo)}(?:\\.git)?/?$`,
    "i",
  ).test(value.trim());
}

type Overlay = { repository?: { homepage?: unknown } | null };

/** Null when the text does not read as one document: a syntax error, or an alias its anchor no longer precedes,
 *  which the parser reports only when the value is read. An empty or comments-only file reads as `{}`, as the
 *  settings loader reads it. */
function readOverlay(text: string): { doc: Document; js: Overlay } | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return null;
  try {
    return { doc, js: (doc.toJS() ?? {}) as Overlay };
  } catch {
    return null;
  }
}

/** Strict structural equality over what the yaml library resolves (`!!omap` a Map, `!!set` a Set, `!!binary` a
 *  Uint8Array, a timestamp a Date), entries in insertion order: Bun.deepEquals matches Set members and Map keys
 *  loosely, so two members differing only in a deleted homepage both matched one expected member. A pair once
 *  entered is taken as equal thereafter, which closes cycles and keeps a shared subtree at one comparison; a false
 *  ends the whole comparison, so no memo is ever consulted after one. */
export function sameDocument(
  a: unknown,
  b: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const partners = seen.get(a) ?? new WeakSet();
  if (partners.has(b)) return true;
  partners.add(b);
  seen.set(a, partners);
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return b instanceof Date && Object.is(a.getTime(), b.getTime());
  const pairs = (x: object): [unknown, unknown][] | null => {
    if (x instanceof Map) return [...x.entries()];
    if (x instanceof Set) return [...x].map((member) => [member, null]);
    if (x instanceof Uint8Array || Array.isArray(x)) return [...x.entries()];
    const proto = Object.getPrototypeOf(x);
    return proto === Object.prototype || proto === null ? Object.entries(x) : null;
  };
  const left = pairs(a);
  const right = pairs(b);
  if (left === null || right === null) return false;
  return (
    left.length === right.length &&
    left.every(
      ([key, value], index) =>
        sameDocument(key, right[index][0], seen) && sameDocument(value, right[index][1], seen),
    )
  );
}

/** The value is judged resolved (an alias reads as what it names). Every non-empty string value asks the checkout
 *  which repository this is, so a real website in a checkout without a GitHub origin is refused, not kept. One judge
 *  decides whether the cut took exactly the pair: the edited text must read as the original minus that one key. */
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
  const edited = text.slice(0, lineStart) + text.slice(lineEnd);
  const expected = { ...before, repository: { ...before.repository } };
  delete expected.repository.homepage;
  const after = readOverlay(edited);
  if (after === null || !sameDocument(after.js, expected)) {
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
