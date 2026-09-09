// The commit subject a branch-mode sync writes: what the render did to the
// module selection, read off the default branch's and the branch's
// .repo-platform.yml, or the ordinary sync subject when the selection did
// not change (an answers-only edit, a plain resync onto a branch).

/** The default-mode subject, one spelling for every sync commit. */
export function syncSubject(display: string): string {
  return `chore: update repo-platform template to ${display}`;
}

function nameList(names: string[]): string {
  return names.length === 1
    ? `${names[0]} module`
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} modules`;
}

/** The subject for a render pushed onto a branch whose selection is
 *  `branch` while the default branch's is `base` (null when the default
 *  branch's registration cannot be read: nothing to diff against). */
export function branchSubject(base: string[] | null, branch: string[], display: string): string {
  if (base === null) return syncSubject(display);
  const added = branch.filter((name) => !base.includes(name));
  const removed = base.filter((name) => !branch.includes(name));
  if (added.length > 0 && removed.length === 0) return `chore: render the ${nameList(added)}`;
  if (removed.length > 0 && added.length === 0) {
    return `chore: remove the ${nameList(removed)} render`;
  }
  if (added.length > 0 && removed.length > 0) {
    const delta = [...added.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)];
    return `chore: render the module selection (${delta.join(", ")})`;
  }
  return syncSubject(display);
}
