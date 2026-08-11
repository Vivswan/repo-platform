import { describe, expect, test } from "bun:test";
import { collectRefs } from "../../.github/scripts/ci/resolve_action_refs";

describe("collectRefs", () => {
  test("extracts owner/repo@ref and aggregates sources", () => {
    const refs = collectRefs([
      { path: "a.yml", text: "      - uses: actions/checkout@v7\n" },
      { path: "b.yml", text: "      - uses: actions/checkout@v7\n        with:\n" },
    ]);
    expect(refs).toEqual([{ repo: "actions/checkout", ref: "v7", sources: ["a.yml", "b.yml"] }]);
  });

  test("resolves subpath actions to their repository", () => {
    const refs = collectRefs([
      { path: "c.yml", text: "        uses: github/codeql-action/init@v4\n" },
    ]);
    expect(refs[0]?.repo).toBe("github/codeql-action");
    expect(refs[0]?.ref).toBe("v4");
  });

  test("skips local paths and template expressions", () => {
    const refs = collectRefs([
      {
        path: "d.jinja",
        text: [
          "      - uses: ./actions/check-typography",
          "      - uses: {{ github_username }}/repo-platform/actions/fuzz-issue@{{ uses_ref }}",
          "      - uses: gitleaks/gitleaks-action@v3",
        ].join("\n"),
      },
    ]);
    expect(refs).toEqual([{ repo: "gitleaks/gitleaks-action", ref: "v3", sources: ["d.jinja"] }]);
  });

  test("distinct refs of one action stay distinct pins", () => {
    const refs = collectRefs([
      { path: "e.yml", text: "      - uses: actions/cache@v6\n" },
      { path: "f.jinja", text: "      - uses: actions/cache@v4\n" },
    ]);
    expect(refs.map((r) => `${r.repo}@${r.ref}`)).toEqual(["actions/cache@v4", "actions/cache@v6"]);
  });

  test("accepts quoted uses values and SHA refs", () => {
    const refs = collectRefs([
      {
        path: "g.yml",
        text: '      - uses: "Vivswan/github-settings-as-code@ac83fb48219309e2249294ef37fb55310bd45fb3"\n',
      },
      { path: "h.yml", text: "      - uses: 'actions/checkout@v7'\n" },
    ]);
    expect(refs.map((r) => `${r.repo}@${r.ref}`)).toEqual([
      "actions/checkout@v7",
      "Vivswan/github-settings-as-code@ac83fb48219309e2249294ef37fb55310bd45fb3",
    ]);
  });
});
