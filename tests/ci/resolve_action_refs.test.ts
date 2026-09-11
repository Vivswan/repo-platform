import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ActionRef, collectRefs } from "../../.github/scripts/ci/resolve_action_refs";
import { boundedSpawnSync } from "../shared/bounded_spawn";
import { tempDirs } from "../shared/temp_dir";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SCRIPT = resolve(import.meta.dir, "../../.github/scripts/ci/resolve_action_refs.ts");
const temp = tempDirs();

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
        { path: "a.yml", text: `      - uses: actions/checkout@${SHA} # v7.0.1\n` },
        { path: "b.yml", text: `      - uses: actions/checkout@${SHA} # v7.0.1\n        with:\n` },
      ],
      expected: [
        { repo: "actions/checkout", ref: SHA, version: "v7.0.1", sources: ["a.yml", "b.yml"] },
      ],
    },
    {
      reason: "a subpath action resolves to its owner/repo; a quoted pin keeps its comment",
      files: [
        { path: "c.yml", text: `        uses: "github/codeql-action/init@${SHA}" # v4.38.0\n` },
      ],
      expected: [
        { repo: "github/codeql-action", ref: SHA, version: "v4.38.0", sources: ["c.yml"] },
      ],
    },
    {
      reason:
        "one sha under two version comments stays two entries; a branch comment and no comment are null",
      files: [
        { path: "i.yml", text: `      - uses: actions/checkout@${SHA} # v7.0.1\n` },
        { path: "j.yml", text: `      - uses: actions/checkout@${SHA} # v7.0.0\n` },
        { path: "k.yml", text: `      - uses: dtolnay/rust-toolchain@${SHA} # master\n` },
        { path: "l.yml", text: `      - uses: actions/cache@${SHA}\n` },
      ],
      expected: [
        { repo: "actions/cache", ref: SHA, version: null, sources: ["l.yml"] },
        { repo: "actions/checkout", ref: SHA, version: "v7.0.0", sources: ["j.yml"] },
        { repo: "actions/checkout", ref: SHA, version: "v7.0.1", sources: ["i.yml"] },
        { repo: "dtolnay/rust-toolchain", ref: SHA, version: null, sources: ["k.yml"] },
      ],
    },
    {
      reason: "local ./ paths and placeholder-owner refs are skipped",
      files: [
        {
          path: "d.yml",
          text: [
            "      - uses: ./actions/check-typography",
            "      - uses: {{github_username}}/repo-platform/actions/fuzz-issue@build",
            "      - uses: gitleaks/gitleaks-action@v3",
          ].join("\n"),
        },
      ],
      expected: [
        { repo: "gitleaks/gitleaks-action", ref: "v3", version: null, sources: ["d.yml"] },
      ],
    },
    {
      reason: "distinct refs of one action stay distinct pins, sorted by ref",
      files: [
        { path: "e.yml", text: "      - uses: actions/cache@v6\n" },
        { path: "f.yaml", text: "      - uses: actions/cache@v4\n" },
      ],
      expected: [
        { repo: "actions/cache", ref: "v4", version: null, sources: ["f.yaml"] },
        { repo: "actions/cache", ref: "v6", version: null, sources: ["e.yml"] },
      ],
    },
    {
      reason: "quoted uses values and SHA refs parse, sorted by repo",
      files: [
        {
          path: "g.yml",
          text: '      - uses: "Vivswan/github-settings-as-code@046adf3b24454f26f569850630809bcf481f8b84" # v2.0.0\n',
        },
        { path: "h.yml", text: "      - uses: 'actions/checkout@v7'\n" },
      ],
      expected: [
        { repo: "actions/checkout", ref: "v7", version: null, sources: ["h.yml"] },
        {
          repo: "Vivswan/github-settings-as-code",
          ref: "046adf3b24454f26f569850630809bcf481f8b84",
          version: "v2.0.0",
          sources: ["g.yml"],
        },
      ],
    },
  ])("$reason", ({ files, expected }) => {
    expect(collectRefs(files)).toEqual(expected);
  });
});

/** The script run as CI runs it, over a scratch tree, with `gh` replaced by
 * a stand-in that answers `repos/<repo>/commits/<ref>` from a table: a sha
 * (the commit the ref names), "404" (no such ref), or "500" (an outage). */
function runOver(
  pins: Record<string, string>,
  table: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const root = temp.dir("action-refs-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env bun",
      "const table = JSON.parse(process.env.GH_TABLE);",
      'const match = /^repos\\/(.+)\\/commits\\/(.+)$/.exec(process.argv[3] ?? "");',
      "const answer = match ? table[`${match[1]}@${decodeURIComponent(match[2])}`] : undefined;",
      'if (answer === undefined || answer === "404") {',
      '  console.error(answer === undefined ? "gh: No commit found (HTTP 422)" : "gh: Not Found (HTTP 404)");',
      "  process.exit(1);",
      "}",
      'if (answer === "500") {',
      '  console.error("gh: Internal Server Error (HTTP 500)");',
      "  process.exit(1);",
      "}",
      "console.log(answer);",
      "",
    ].join("\n"),
  );
  chmodSync(gh, 0o755);
  for (const dir of [".github/workflows", "files/m/.github/workflows", "actions/x"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  // One file per scanned root, the sync writer's workflow block file
  // included: its block value sits before the .yml extension.
  const files: Record<string, string[]> = {
    ".github/workflows/a.yml": [],
    "files/m/.github/workflows/c.block.toolchain.yml": [],
    "actions/x/action.yml": [],
  };
  const names = Object.keys(files);
  Object.entries(pins).forEach(([action, ref], index) => {
    files[names[index % names.length]].push(`      - uses: ${action}@${ref}`);
  });
  for (const [rel, lines] of Object.entries(files)) {
    writeFileSync(join(root, rel), `${lines.join("\n")}\n`);
  }
  return boundedSpawnSync(["bun", SCRIPT], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TABLE: JSON.stringify(table) },
  });
}

describe("resolve_action_refs.ts over a scratch tree", () => {
  const OTHER = "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";
  const DEAD = "0000000000000000000000000000000000000001";

  test("every pin whose sha exists and whose comment names that commit passes; a branch comment is not judged", () => {
    const result = runOver(
      {
        "actions/checkout": `${SHA} # v7.0.1`,
        "github/codeql-action/init": `${OTHER} # v4.38.0`,
        "dtolnay/rust-toolchain": `${DEAD} # master`,
        "Vivswan/repo-platform/actions/plan": "build",
      },
      {
        [`actions/checkout@${SHA}`]: SHA,
        "actions/checkout@v7.0.1": SHA,
        [`github/codeql-action@${OTHER}`]: OTHER,
        "github/codeql-action@v4.38.0": OTHER,
        [`dtolnay/rust-toolchain@${DEAD}`]: DEAD,
        "Vivswan/repo-platform@build": OTHER,
      },
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "action-refs: all 4 pinned refs resolve\n",
      stderr: "",
    });
  });

  test("a stale comment, a dangling ref, a comment naming no release, and an API failure each fail with their own message; the sound pin beside them stays silent", () => {
    const result = runOver(
      {
        "actions/checkout": `${SHA} # v7.0.1`,
        "actions/cache": `${SHA} # v6.1.0`,
        "astral-sh/setup-uv": "v9",
        "oven-sh/setup-bun": `${OTHER} # v2.2.0`,
        "actions/setup-node": `${DEAD} # v7.0.999`,
      },
      {
        [`actions/checkout@${SHA}`]: SHA,
        "actions/checkout@v7.0.1": SHA,
        [`actions/cache@${SHA}`]: SHA,
        "actions/cache@v6.1.0": OTHER,
        "astral-sh/setup-uv@v9": "404",
        [`oven-sh/setup-bun@${OTHER}`]: "500",
        [`actions/setup-node@${DEAD}`]: DEAD,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trimEnd().split("\n")).toEqual([
      `::error::action-refs: actions/cache@${SHA} # v6.1.0: v6.1.0 is commit ${OTHER}, not ${SHA} (pinned in files/m/.github/workflows/c.block.toolchain.yml). Re-pin the sha the comment names, or fix the comment.`,
      `::error::action-refs: actions/setup-node@v7.0.999 (the comment beside ${DEAD}) does not resolve to any commit, tag, or branch upstream (pinned in files/m/.github/workflows/c.block.toolchain.yml). Name the release the pinned sha is.`,
      "::error::action-refs: astral-sh/setup-uv@v9 does not resolve to any commit, tag, or branch upstream (pinned in actions/x/action.yml). Check the repository's published tags and pin one that exists.",
      `::error::action-refs: could not verify oven-sh/setup-bun@${OTHER} (gh: Internal Server Error (HTTP 500)). This is an API problem (rate limit, auth, outage), not evidence the pin is wrong - re-run the job.`,
    ]);
  });
});
