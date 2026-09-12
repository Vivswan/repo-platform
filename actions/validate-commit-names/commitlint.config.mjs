// The fleet's commit grammar: @commitlint/config-conventional plus one scope per subject. Both feeders of the action
// (the commit-names step over a range, the pr-title workflow over the title) and this repository's commit-msg hook
// run commitlint over this file: the grammar has one home.
//
// body/footer line caps off -> the house style never hard-wraps a commit body, and a squash body carries PR text

import isIgnored from "@commitlint/is-ignored";

// The comma case is named: a committer read `style(contract,tests): ...` refused by the bare grammar as a validator
// bug. Judged on the scope as the parser reads it, which is how release-please (the same parser) will read the
// landed subject: `fix(a):(c): x` carries the scope `a):(c`, `fix(core): handle fn(): safely` the scope
// `core): handle fn(`. The parser reads `fix(): x` as no scope at all, so an empty pair is read off the header.
const scopeToken = /^[A-Za-z0-9._/-]+$/;

const scopeOne = (parsed) => {
  const scope = parsed.scope ?? (/^\w*\(\)/.test(parsed.header ?? "") ? "" : null);
  if (scope === null || scopeToken.test(scope)) return [true];
  return [
    false,
    "one scope per subject, spelled [A-Za-z0-9._/-]: split the change or pick the scope that names it",
  ];
};

// commitlint's own exemptions (merge, revert, fixup, squash, semver subjects), judged on the subject line alone: over
// the whole message its merge pattern is multiline, so a body line `Merge branch topic` would exempt a bad subject.
// The split ends at every terminator that pattern's `^` honors (\r and U+2028/9 included), not only at a newline.
const subjectIgnored = (message) => isIgnored(message.split(/[\n\r\u2028\u2029]/, 1)[0]);

export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [{ rules: { "scope-one": scopeOne } }],
  defaultIgnores: false,
  ignores: [subjectIgnored],
  rules: {
    "scope-one": [2, "always"],
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};
