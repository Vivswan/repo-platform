import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { MANIFEST_NAME } from "../../../shared/manifest.ts";
import { type Context, REGISTRATION_PATH } from "../context.ts";
import { error, type Finding } from "../findings.ts";
import { isRecord } from "../readers.ts";

/** The declared mirror copies the tree must carry. A copy the sync wrote
 *  has a `mirror` record, and manifest_parity holds it to that hash; a
 *  declared literal target with no such record is judged here against its
 *  source's bytes, so a declaration whose copy was never written is red
 *  until the copy holds the source (a copy made by hand passes, and the
 *  next sync adopts and records it). `*` patterns are the sync's to
 *  expand; a malformed declaration is the plan job's error. */
export function checkMirrors(ctx: Context): Finding[] {
  if (ctx.mode !== "render" || ctx.manifest.state !== "parsed") return [];
  const mirrors = ctx.registration?.mirrors;
  if (!Array.isArray(mirrors)) return [];
  const findings: Finding[] = [];
  const sources = new Map<string, Buffer | null>();
  const sourceBytes = (source: string): Buffer | null => {
    const known = sources.get(source);
    if (known !== undefined) return known;
    const found = probe(ctx.root, source);
    const bytes = found.kind === "file" ? found.bytes : null;
    if (bytes === null) {
      findings.push(
        error(
          `${REGISTRATION_PATH}: mirror source '${source}' is ${found.kind === "file" ? "" : found.what}, ` +
            "so its copies cannot be judged - the source must be a file files.yml " +
            "writes here (the plan job rejects any other); fix the declaration",
        ),
      );
    }
    sources.set(source, bytes);
    return bytes;
  };
  for (const entry of mirrors) {
    if (!isRecord(entry) || typeof entry.source !== "string" || !Array.isArray(entry.targets)) {
      continue;
    }
    for (const target of entry.targets) {
      if (typeof target !== "string" || target.includes("*")) continue;
      if (ctx.manifest.files[target]?.class === "mirror") continue;
      if (!cleanPath(target)) continue;
      const source = sourceBytes(entry.source);
      if (source === null) continue;
      const where = `${target}: declared in ${REGISTRATION_PATH} as a mirror of '${entry.source}'`;
      const copy = probe(ctx.root, target);
      if (copy.kind !== "file") {
        findings.push(
          error(
            `${where} but ${copy.what} and unrecorded in ${MANIFEST_NAME} - the copy was never ` +
              "written; run a template sync, or copy the source there yourself (the next sync adopts " +
              "a copy holding the source's bytes)",
          ),
        );
      } else if (!copy.bytes.equals(source)) {
        findings.push(
          error(
            `${where} but unrecorded in ${MANIFEST_NAME} and its content differs from the source - ` +
              "a copy made outside a sync that drifted; run a template sync to rewrite and record it",
          ),
        );
      }
    }
  }
  return findings;
}

/** A path the validator may join under the root: no absolute, `.`, `..`,
 *  or empty segment (the plan job rejects such a target outright). */
function cleanPath(path: string): boolean {
  return (
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** What sits at `rel` under `root`: a regular file with its bytes, or
 *  what stands there instead, in words. A lookup that fails for any reason
 *  but absence (a link loop above it, a directory the runner may not
 *  read) is named by its code, never read as absence. */
type Probed = { kind: "file"; bytes: Buffer } | { kind: "other"; what: string };

function probe(root: string, rel: string): Probed {
  const abs = join(root, rel);
  let stat: Stats;
  try {
    stat = lstatSync(abs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: "other",
      what:
        code === "ENOENT" ? "missing from the repo" : `not readable (${code ?? "unknown error"})`,
    };
  }
  if (stat.isFile()) return { kind: "file", bytes: readFileSync(abs) };
  return {
    kind: "other",
    what: stat.isSymbolicLink()
      ? "a symbolic link"
      : stat.isDirectory()
        ? "a directory"
        : "not a regular file",
  };
}
