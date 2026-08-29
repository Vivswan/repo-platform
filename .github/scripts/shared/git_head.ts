// HEAD probe shared by the sync scripts that must distinguish "the path
// is genuinely absent at HEAD" from "the repository is broken":
// `git ls-tree HEAD -- rel` exits 0 with empty output for an absent path,
// 0 with output for a present one, and nonzero only on real failure -
// which throws, because reading damage as "absent" would silently skip a
// carry or a tripwire check (cat-file -e cannot make that distinction: it
// exits 128 for a missing path and for fatal errors alike).
//
// The result is DISCRIMINATED by object kind because a HEAD-relative
// content read answers for every kind: a directory yields tree-listing
// prose and a symlink yields its target path string. A probe returning
// bare bytes handed those to callers as if they were file content; the
// union makes that confusion unrepresentable - only a regular blob
// carries bytes at all, and the bytes are read BY THE OID the
// discriminating ls-tree returned, so both steps name the same object
// even if HEAD moves between the two git calls.

/** A VALUE-FREE failure for a HEAD probe: the git subcommand and its exit
 *  code only - never the path, the repository root, or git's stderr, each
 *  of which can name private-repo content. Defense in depth behind the
 *  callers' run_hidden.ts wrapping: the message stays safe even if a future
 *  caller logs it unwrapped. Same discipline as shared/json.ts; the withheld
 *  git detail is reproduced locally (docs/private-repos.md). */
import { capture, DEFAULT_HANG_BOUND_MS, timeoutExitCode } from "./proc.ts";

function headProbeFailed(subcommand: "ls-tree" | "cat-file", exitCode: number | null): Error {
  return new Error(
    `git ${subcommand} against HEAD failed (exit ${exitCode ?? "unknown"}); the path, ` +
      "repository root, and git stderr are withheld to keep private-repo content out of the " +
      "log - reproduce the sync locally to see them (docs/private-repos.md)",
  );
}

/** The non-blob object kinds a git tree can carry at a path. Wordings that
 * reach PR bodies and notices interpolate these, so they are prose words,
 * not git's type names ("tree", "commit"). */
export type HeadNonBlobKind = "directory" | "symlink" | "submodule";

/** What `root`'s HEAD carries at a path: a regular file's bytes, a
 * non-blob entry (which has NO file content - `git show` would answer
 * with tree-listing prose or a symlink's target string), or nothing. */
export type HeadEntry =
  | { kind: "blob"; bytes: Buffer }
  | {
      kind: "non-blob";
      object: HeadNonBlobKind;
      /** The entry's raw ls-tree mode and type ("120000 blob") - value-free
       * by construction (no oid, no path), so callers may log it. */
      raw: string;
    }
  | { kind: "absent" };

/** Value-free like headProbeFailed: `detail` is the mode/type token pair
 * or a content-free description, never an oid or a path. */
function headEntryUnrecognized(detail: string): Error {
  return new Error(
    `git ls-tree against HEAD listed an entry this probe does not recognize (${detail}); ` +
      "the path, repository root, and full listing are withheld to keep private-repo content " +
      "out of the log - reproduce the sync locally to see them (docs/private-repos.md)",
  );
}

/** What HEAD carries at `rel` (see HeadEntry), throwing on a broken
 * repository. Blob bytes stay raw so each caller picks the honest decode
 * (latin1 for byte-owned file content, utf-8 for the manifest).
 * --literal-pathspecs: a tracked file NAMED like pathspec magic
 * (":(top)a.txt" - the validators bar traversal, not leading colons)
 * would otherwise silently resolve to a different path. */
export function headEntry(root: string, rel: string): HeadEntry {
  // -z: entries are NUL-separated with UNQUOTED paths, so the exact-path
  // check below compares the real path, not git's C-quoted rendering of it.
  const probe = capture([
    "git",
    "--literal-pathspecs",
    "-C",
    root,
    "ls-tree",
    "-z",
    "HEAD",
    "--",
    rel,
  ]);
  if (probe.exitCode !== 0) {
    throw headProbeFailed("ls-tree", probe.exitCode);
  }
  const entries = probe.stdout.split("\0").filter((entry) => entry !== "");
  if (entries.length === 0) return { kind: "absent" };
  // A literal pathspec of one exact path names one entry (ls-tree does not
  // recurse into a matched tree); more means the pathspec matched a
  // LISTING instead (a trailing slash lists a tree's children) - refuse
  // rather than discriminate on an arbitrary entry.
  if (entries.length !== 1) {
    throw headEntryUnrecognized(`${entries.length} entries`);
  }
  // "<mode> SP <type> SP <oid> TAB <path>". The single entry must BE the
  // probed path: a single-child tree probed with a trailing slash would
  // otherwise answer with that child's entry.
  const tab = entries[0].indexOf("\t");
  if (tab === -1 || entries[0].slice(tab + 1) !== rel) {
    throw headEntryUnrecognized("an entry for a different path");
  }
  const fields = entries[0].slice(0, tab).split(" ");
  if (fields.length !== 3 || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[2])) {
    throw headEntryUnrecognized("a malformed entry line");
  }
  const [mode, type, oid] = fields;
  const raw = `${mode} ${type}`;
  // Exact mode/type pairs only. Symlinks are TYPE blob (their blob is the
  // target path string), so the mode is the discriminant that keeps them
  // out of the content branch - and a pair this roster does not know (a
  // future blob-backed special mode, say) must fail loudly here, never
  // read as regular file content.
  if (mode === "120000" && type === "blob") return { kind: "non-blob", object: "symlink", raw };
  if (mode === "040000" && type === "tree") return { kind: "non-blob", object: "directory", raw };
  if (mode === "160000" && type === "commit") return { kind: "non-blob", object: "submodule", raw };
  if (!((mode === "100644" || mode === "100755") && type === "blob")) {
    throw headEntryUnrecognized(raw);
  }
  // Read the blob BY THE OID ls-tree returned, never by re-resolving HEAD
  // (`git show HEAD:rel`): a HEAD move between the two git calls could
  // otherwise route a different object's bytes through this blob arm.
  // Raw Bun.spawnSync, not capture(): the blob contract is RAW BYTES, and
  // capture's string result is a utf-8 decode that folds non-utf-8 file
  // content onto U+FFFD. The hang bound still applies, carried inline with
  // proc.ts's own constant and timeout-is-failure mapping - and so does
  // proc.ts's env contract: live process.env is handed DELIBERATELY,
  // because bun's default is a process-start snapshot, so a caller's
  // GIT_* scrub would otherwise never reach this child and a stray
  // startup GIT_DIR would silently point the byte read at another
  // repository.
  const proc = Bun.spawnSync(["git", "-C", root, "cat-file", "blob", oid], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: DEFAULT_HANG_BOUND_MS,
    killSignal: "SIGKILL",
  });
  if (proc.exitedDueToTimeout === true) {
    throw headProbeFailed("cat-file", timeoutExitCode(proc));
  }
  if (proc.exitCode !== 0) {
    throw headProbeFailed("cat-file", proc.exitCode);
  }
  return { kind: "blob", bytes: Buffer.from(proc.stdout) };
}
