import { describe, expect, test } from "bun:test";
import { type ActionRef, collectRefs } from "../../.github/scripts/ci/resolve_action_refs";

describe("collectRefs", () => {
  // Each row pins the whole sorted ActionRef[] - repo, ref, and the
  // aggregated sources in first-seen order - so a regression in any
  // dimension (dedup, subpath trimming, skip rules, sort) shows here.
  test.each<{
    reason: string;
    files: Array<{ path: string; text: string }>;
    expected: ActionRef[];
  }>([
    {
      reason: "one pin in two files collapses to one entry aggregating both sources",
      files: [
        { path: "a.yml", text: "      - uses: actions/checkout@v7\n" },
        { path: "b.yml", text: "      - uses: actions/checkout@v7\n        with:\n" },
      ],
      expected: [{ repo: "actions/checkout", ref: "v7", sources: ["a.yml", "b.yml"] }],
    },
    {
      reason: "a subpath action resolves to its owner/repo",
      files: [{ path: "c.yml", text: "        uses: github/codeql-action/init@v4\n" }],
      expected: [{ repo: "github/codeql-action", ref: "v4", sources: ["c.yml"] }],
    },
    {
      reason: "local ./ paths and template-expression refs are skipped",
      files: [
        {
          path: "d.jinja",
          text: [
            "      - uses: ./actions/check-typography",
            "      - uses: {{ github_username }}/repo-platform/actions/fuzz-issue@{{ uses_ref }}",
            "      - uses: gitleaks/gitleaks-action@v3",
          ].join("\n"),
        },
      ],
      expected: [{ repo: "gitleaks/gitleaks-action", ref: "v3", sources: ["d.jinja"] }],
    },
    {
      reason: "distinct refs of one action stay distinct pins, sorted by ref",
      files: [
        { path: "e.yml", text: "      - uses: actions/cache@v6\n" },
        { path: "f.jinja", text: "      - uses: actions/cache@v4\n" },
      ],
      expected: [
        { repo: "actions/cache", ref: "v4", sources: ["f.jinja"] },
        { repo: "actions/cache", ref: "v6", sources: ["e.yml"] },
      ],
    },
    {
      reason: "quoted uses values and SHA refs parse, sorted by repo",
      files: [
        {
          path: "g.yml",
          text: '      - uses: "Vivswan/github-settings-as-code@ac83fb48219309e2249294ef37fb55310bd45fb3"\n',
        },
        { path: "h.yml", text: "      - uses: 'actions/checkout@v7'\n" },
      ],
      expected: [
        { repo: "actions/checkout", ref: "v7", sources: ["h.yml"] },
        {
          repo: "Vivswan/github-settings-as-code",
          ref: "ac83fb48219309e2249294ef37fb55310bd45fb3",
          sources: ["g.yml"],
        },
      ],
    },
  ])("$reason", ({ files, expected }) => {
    expect(collectRefs(files)).toEqual(expected);
  });
});
