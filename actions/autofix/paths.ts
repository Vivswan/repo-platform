// Which changes a fix may carry. The unprivileged job judges with this to stage; the job holding the write token judges
// again with it, over the lists it read from the default branch itself.
//
//   label -> a change outside the lists is dropped, the rest is committed  (a format fix is per file)
//   push  -> a change outside the lists refuses the whole fix              (a regeneration is one set)

import { REGISTRATION_PATH } from "../shared/platform.ts";
import { pathProblem } from "../shared/repo_path.ts";

const STEP_SCRIPTS = ".github/scripts/";
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";
const RAW_HEADER = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/;

/** The trigger a run answers: the fix-lint label, or a push to the pull request. */
export type FixEvent = "label" | "push";

/** One event's allow-lists, as the registration on the default branch declares them. */
export interface Lists {
  /** The globs a fix may add or change. */
  paths: readonly string[];

  /** The globs a fix may delete; nothing else is ever deleted. */
  delete: readonly string[];
}

/** One path a fix changed, as `git diff --raw --no-renames` names it. */
export interface Change {
  /** The path, relative to the repository root. */
  path: string;

  /** Git's status letter: A added, M modified, D deleted, T type changed. */
  status: string;

  /** The file's mode before the fix, 000000 when it did not exist. */
  oldMode: string;

  /** The file's mode after the fix, 000000 when it is deleted. */
  newMode: string;
}

/** A change as git printed it, with the name the decoded `path` loses when its bytes are not UTF-8. */
export interface RawChange extends Change {
  /** The path's own bytes, as the index holds them. */
  name: Buffer;
}

/** A change no fix may carry, and why. */
export interface Rejection {
  /** The path the fix changed. */
  path: string;

  /** Why it is not carried. */
  reason: string;
}

/** What a set of changes comes to under one event's rule. */
export type Judgment =
  | { kind: "stage"; staged: Change[]; dropped: Rejection[] }
  | { kind: "refuse"; refused: Rejection[] };

/** Whether `path` matches the list entry `pattern`: a glob, or a directory spelled with a closing slash. */
export function matches(pattern: string, path: string): boolean {
  const glob = pattern.endsWith("/") ? `${pattern}**` : pattern;

  return new Bun.Glob(glob).match(path);
}

/** Why no list can ever allow `change`, or null: .github/ but its step scripts, the registration, a symlink, a submodule. */
function alwaysRefused(change: Change): string | null {
  const problem = pathProblem(change.path);
  if (problem !== null) return `the path ${problem}`;

  // Git's bytes are read as UTF-8, and a byte that is none reads as this character: the name judged is not the name committed.
  if (change.path.includes("\uFFFD")) return "the path is not valid UTF-8";

  // GitHub reads these names on a case-sensitive tree, and a case-insensitive checkout folds the rest onto them.
  // The step scripts open in their exact case alone, so a folded spelling of them stays refused.
  const path = change.path.toLowerCase();
  if (path.startsWith(".github/") && !change.path.startsWith(STEP_SCRIPTS)) {
    return "under .github/ outside .github/scripts/, which no fix changes";
  }

  if (path === REGISTRATION_PATH) return "the registration, which no fix changes";

  if (path === ".gitmodules") return "the submodule list, which no fix changes";

  const modes = [change.oldMode, change.newMode];
  if (modes.includes(SYMLINK_MODE)) return "a symbolic link";

  if (modes.includes(SUBMODULE_MODE)) return "a submodule";

  return null;
}

/** Why `change` is not carried under `lists`, or null when it is. A rename arrives as a deletion and an addition. */
export function rejection(change: Change, lists: Lists): string | null {
  const refused = alwaysRefused(change);
  if (refused !== null) return refused;

  if (change.status === "D") {
    const allowed = lists.delete.some((pattern) => matches(pattern, change.path));
    return allowed ? null : "a deletion outside the delete list";
  }

  if (!["A", "M", "T"].includes(change.status)) return `git status ${change.status}`;

  const allowed = lists.paths.some((pattern) => matches(pattern, change.path));
  return allowed ? null : "outside the paths list";
}

/** The changes a fix carries under `event`'s rule: the label drops what the lists do not allow, a push refuses the lot. */
export function judge(event: FixEvent, changes: readonly Change[], lists: Lists): Judgment {
  const staged: Change[] = [];
  const rejected: Rejection[] = [];
  for (const change of changes) {
    const reason = rejection(change, lists);
    if (reason === null) staged.push(change);
    else rejected.push({ path: change.path, reason });
  }

  if (event === "push" && rejected.length > 0) return { kind: "refuse", refused: rejected };

  return { kind: "stage", staged, dropped: rejected };
}

/**
 * The changes in the output of `git diff --raw -z --no-renames --no-abbrev`.
 *
 * @throws {Error} a record is not git's `:<old mode> <new mode> <old sha> <new sha> <status>` header and a path
 */
export function parseRawDiff(output: Buffer): RawChange[] {
  const fields: Buffer[] = [];
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    fields.push(output.subarray(start, end === -1 ? output.length : end));
    start = end === -1 ? output.length : end + 1;
  }

  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = RAW_HEADER.exec(fields[index].toString("latin1"));
    const name = fields[index + 1];
    if (header === null || name === undefined) {
      throw new Error(`git diff --raw printed a record this action cannot read at field ${index}`);
    }

    const [, oldMode, newMode, status] = header;
    changes.push({ path: name.toString("utf8"), name, status, oldMode, newMode });
  }

  return changes;
}
