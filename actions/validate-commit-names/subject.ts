// Shared by the CI action (validate-commit-names.ts) and this repo's commit-msg hook (scripts/check/check_commit_subject.ts);
// tests/scripts/check/check_commit_subject.test.ts proves the two judge identically.
//   lives INSIDE the action directory  -> the build branch ships actions/ but not scripts/; a repo-root import would break every fleet `uses:` ref
//   dependency-free                    -> the action runs it with no install step

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

// One scope only: the class has no comma, so a comma-scoped subject like `docs(all-green,build-provenance): ...` is refused.
export const scopeCharacterClass = "[A-Za-z0-9._/-]";

const oneScope = `${scopeCharacterClass}+`;

function subjectGrammar(scope: string): RegExp {
  return new RegExp(`^(${allowedTypes.join("|")})(\\(${scope}\\))?!?: .+`);
}

export const conventionalSubject = subjectGrammar(oneScope);

// A committer who wrote `style(contract,tests): ...` read the generic refusal as a validator bug, so a subject the
// grammar accepts with a comma list of scopes is refused by name of the one-scope rule.
const commaScopedSubject = subjectGrammar(`${oneScope}(?:\\s*,\\s*${oneScope})+`);

export const oneScopeRule =
  "one scope per subject: split the change or pick the scope that names it";

export function refusal(value: string): string | undefined {
  if (conventionalSubject.test(value)) return undefined;
  if (commaScopedSubject.test(value)) return oneScopeRule;
  return "not of the shape <type>(<scope>)?!?: <description>";
}

export function subject(message: unknown): string {
  return String(message ?? "")
    .split(/\r?\n/, 1)[0]
    .trim();
}

/** Merge commits are exempt from the grammar, in CI and locally alike. */
export function isMergeSubject(value: string): boolean {
  return /^Merge (pull request|branch|remote-tracking branch)\b/.test(value);
}
