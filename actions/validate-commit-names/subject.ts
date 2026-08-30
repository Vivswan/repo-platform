// The single source of the Conventional Commit subject grammar. Two
// consumers import these bytes: the CI action (validate-commit-names.ts,
// running `@build` in every fleet repo and at ./actions in this repo's
// CI) and this repo's commit-msg hook (scripts/check_commit_subject.ts).
// The module lives INSIDE the action directory, not under scripts/,
// because the direction is forced: the composed build branch ships
// actions/ but not scripts/, so an action-side import of a repo-root
// module would break every fleet `uses:` ref, while the hook only ever
// runs in a full checkout where actions/ exists. Dependency-free on
// purpose - the action carries no runtime dependencies.
// tests/scripts/check_commit_subject.test.ts proves the two consumers
// judge identically; a fork of this grammar reds there.

export const allowedTypes = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;

// One scope only: the scope class has no comma, and CI refuses a
// comma-scoped subject like `docs(all-green,build-provenance): ...` -
// the exact shape that reddened main on 2026-08-30 because nothing
// judged it before the push.
export const scopeCharacterClass = "[A-Za-z0-9._/-]";

export const conventionalSubject = new RegExp(
  `^(${allowedTypes.join("|")})(\\(${scopeCharacterClass}+\\))?!?: .+`,
);

/** First line of a commit message, trimmed. */
export function subject(message: unknown): string {
  return String(message ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
}

/** Merge commits are exempt from the grammar, in CI and locally alike. */
export function isMergeSubject(value: string): boolean {
  return /^Merge (pull request|branch|remote-tracking branch)\b/.test(value);
}
