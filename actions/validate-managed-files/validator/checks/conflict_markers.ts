import { capture, failureDetail } from "../../../shared/action_runtime.ts";
import { error, type Finding } from "../findings.ts";

/** Under the deadline src/run.ts gives the whole validator, so a hung git is reported by name. */
const SEARCH_TIMEOUT_MS = 120_000;

/** Counted, never literal: this file must pass its own scan. The carriage return is a checkout under core.autocrlf. */
const MARKER_LINE = "^(<{7} |>{7} |={7}\r?$)";

/** The files under `root` that carry a conflict-marker line, as paths relative to it, in git's order: the files git
 *  tracks and reads as text (`git grep -I`), whatever their names. An untracked file, a submodule's content, and a
 *  file git reads as binary are not judged.
 *
 *  @throws {Error} git could not search `root` (it is no git checkout, say), or ran past its deadline */
export function conflictMarkedFiles(root: string): string[] {
  const options = ["-I", "-l", "-z", "--no-color", "--no-recurse-submodules"];
  const searched = capture(["git", "-C", root, "grep", ...options, "-E", "-e", MARKER_LINE], {
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  // git grep exits 1 for "no line matched", which is the clean tree.
  const { exit } = searched;
  if (exit.kind !== "exited" || exit.code > 1) {
    throw new Error(`git grep failed in ${root}: ${failureDetail(searched)}`);
  }

  return searched.stdout.split("\0").filter((path) => path !== "");
}

export function checkConflictMarkers(marked: readonly string[]): Finding[] {
  return marked.map((path) =>
    error(
      `${path}: carries conflict-marker lines (a line opening with '<<<<<<< ' or '>>>>>>> ', or reading ` +
        "'=======' whole) - resolve each conflict block, or move an example so no line reads as a marker",
    ),
  );
}
