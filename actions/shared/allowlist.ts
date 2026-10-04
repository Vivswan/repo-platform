// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One repo-owned allow-list grammar for every check that exempts by path: `path # reason` per line, blank lines
 *  and `#` comment lines skipped, the reason mandatory. A check names its own file and the reasons a reader accepts. */
export interface AllowEntry {
  path: string;
  reason: string;
  /** 1-based, in the allow-list file. */
  line: number;
}

export interface Allowlist {
  entries: AllowEntry[];
  /** Entries without a reason, each a message naming the file, line, and the check's reason rule. */
  failures: string[];
}

export interface LoadedAllowlist extends Allowlist {
  /** The exempted paths. */
  allowed: ReadonlySet<string>;
}

export function parseAllowlist(text: string, file: string, reasonRule: string): Allowlist {
  const entries: AllowEntry[] = [];
  const failures: string[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const hash = line.indexOf("#");
    const path = (hash === -1 ? line : line.slice(0, hash)).trim();
    const reason = hash === -1 ? "" : line.slice(hash + 1).trim();
    if (reason === "") {
      failures.push(`${file}:${index + 1}: '${path}' has no '# reason'; ${reasonRule}`);
      return;
    }
    entries.push({ path, reason, line: index + 1 });
  });
  return { entries, failures };
}

/** The check's allow-list at the checkout root; an absent file exempts nothing. */
export function loadAllowlist(root: string, file: string, reasonRule: string): LoadedAllowlist {
  const path = join(root, file);
  const allow = existsSync(path)
    ? parseAllowlist(readFileSync(path, "utf-8"), file, reasonRule)
    : { entries: [], failures: [] };
  return { ...allow, allowed: new Set(allow.entries.map((entry) => entry.path)) };
}

/** An entry whose path had no finding this run is stale and fails the check; `because` names what that means for
 *  the check (under every cap, no refused construct). */
export function staleEntries(
  allow: Allowlist,
  found: ReadonlySet<string>,
  file: string,
  because: string,
): string[] {
  return allow.entries
    .filter((entry) => !found.has(entry.path))
    .map(
      (entry) =>
        `${file}:${entry.line}: '${entry.path}' is stale (${because}, or not a tracked file); remove the entry`,
    );
}
