// DEPENDENCY-FREE ZONE (see grammar.ts): node builtins and zone-internal imports only.

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
