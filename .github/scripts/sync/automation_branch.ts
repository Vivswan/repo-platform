// The rolling branch every default-branch sync regenerates and opens its PR
// from. Named once: resolve_refs.ts pushes to it, and read_target.ts
// refuses it as a branch-mode target (a render onto it would skip the sync
// PR's disarm and could let an armed PR merge a review-required revision).
export const AUTOMATION_BRANCH = "automation/repo-platform";
