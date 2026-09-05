import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Context } from "../context.ts";
import { error, type Finding } from "../findings.ts";
import { hasConflictMarker } from "../readers.ts";

const TEXT_SUFFIXES = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".yml",
  ".yaml",
  ".json",
  ".jinja",
  ".md",
  ".html",
  ".css",
  ".toml",
  ".cfg",
  ".ini",
  ".txt",
  ".sh",
  ".astro",
  ".template",
]);

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** No unresolved merge-conflict markers in text files (suffix-listed or
 *  extensionless; binary content, detected as invalid UTF-8, is skipped). */
export function checkConflictMarkers(ctx: Context): Finding[] {
  const findings: Finding[] = [];
  for (const rel of ctx.files) {
    const suffix = extname(rel);
    if (!TEXT_SUFFIXES.has(suffix) && suffix !== "") continue;
    let content: string;
    try {
      content = STRICT_UTF8.decode(readFileSync(join(ctx.root, rel)));
    } catch {
      continue;
    }
    if (hasConflictMarker(content)) {
      findings.push(
        error(
          `${rel}: contains unresolved merge-conflict markers left by ` +
            "copier or git; edit the file and resolve each conflict block",
        ),
      );
    }
  }
  return findings;
}
