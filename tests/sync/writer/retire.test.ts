import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Records } from "../../../.github/scripts/sync/writer/manifest.ts";
import { keepReason, retire } from "../../../.github/scripts/sync/writer/retire.ts";
import { renderRegion } from "../../../.github/scripts/sync/writer/write_split.ts";
import { HASH_REGION_MARKERS } from "../../../actions/shared/grammar.ts";
import { sha256 } from "../../../actions/shared/values.ts";
import { fixtureGit } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const M = HASH_REGION_MARKERS;

function checkout(files: Record<string, string | Buffer>): string {
  const target = temp.dir("writer-retire-");
  fixtureGit(target, ["init", "-q", "-b", "main"]);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(target, rel, ".."), { recursive: true });
    writeFileSync(join(target, rel), content);
  }
  fixtureGit(target, ["add", "-A"]);
  fixtureGit(target, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "seed"]);
  return target;
}

const REGION = renderRegion("managed", M);
const split = (hash: string) => ({
  class: "split",
  grammar: "managed-region",
  begin: M.begin,
  end: M.end,
  hash,
});
const KEPT =
  "repository-owned content kept as a plain file; the region is gone, so read the file whole, give it a heading and intro if it lost them, or delete it";

describe("keepReason", () => {
  // The judgement table sync.ts's class flip reads: a keep reason makes the flip report the content as replaced local
  // edits instead of overwriting it silently as its own last write, so a hand-over must be one; a hash-null record
  // is not one the writer reads, so it vouches for nothing.
  test("names why each state is not the writer's own last write", () => {
    const target = checkout({
      same: "v1\n",
      edited: "v2\n",
      region: REGION,
      "region-blank": `${REGION}\n\n`,
      "region-tail": `${REGION}mine\n`,
      starter: "s\n",
      unrecorded: "u\n",
      nohash: "n\n",
    });
    const records: Records = {
      same: { class: "managed", hash: sha256("v1\n") },
      edited: { class: "managed", hash: sha256("v1\n") },
      region: split(sha256(REGION)),
      "region-blank": split(sha256(REGION)),
      "region-tail": split(sha256(REGION)),
      starter: { class: "starter" },
      nohash: { class: "managed", hash: null },
    };
    expect(keepReason(target, "same", records)).toBeNull();
    expect(keepReason(target, "region", records)).toBeNull();
    expect(keepReason(target, "region-blank", records)).toBeNull();
    expect(keepReason(target, "edited", records)).toBe("the content differs from the last write");
    expect(keepReason(target, "region-tail", records)).toBe(
      "the file carries repository-owned content outside the managed region",
    );
    expect(keepReason(target, "starter", records)).toBe("a starter is repo-owned");
    expect(keepReason(target, "unrecorded", records)).toBe("no record of the platform writing it");
    expect(keepReason(target, "nohash", records)).toBe("no record of the platform writing it");
  });

  // A link is judged by its target string, never read through, and the record's kind alone tells a link from a file
  // holding its target as text. Crafted input: the link target bytes ff 2e 6d 64 decode to U+FFFD.md, so a decoded
  // compare would vouch for a foreign link.
  test("a link is judged by its target string under a symlink-mirror record, and by class under any other", () => {
    const target = checkout({
      "AGENTS.md": "agents\n",
      "as-file.md": "not a link\n",
      "as-mirror-file.md": "AGENTS.md",
    });
    symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
    symlinkSync("../AGENTS.md", join(target, "other.md"));
    symlinkSync("AGENTS.md", join(target, "mirror-link.md"));
    symlinkSync("AGENTS.md", join(target, "mirror-copy-as-link.md"));
    symlinkSync(Buffer.from([0xff, 0x2e, 0x6d, 0x64]), join(target, "malformed.md"));
    const records: Records = {
      "malformed.md": { class: "mirror", kind: "symlink", hash: sha256("\uFFFD.md") },
      "CLAUDE.md": { class: "managed", hash: sha256("AGENTS.md") },
      "other.md": { class: "mirror", kind: "symlink", hash: sha256("AGENTS.md") },
      "as-file.md": { class: "mirror", kind: "symlink", hash: sha256("AGENTS.md") },
      "mirror-link.md": { class: "mirror", kind: "symlink", hash: sha256("AGENTS.md") },
      "as-mirror-file.md": { class: "mirror", kind: "symlink", hash: sha256("AGENTS.md") },
      "mirror-copy-as-link.md": { class: "mirror", hash: sha256("AGENTS.md") },
    };
    expect(keepReason(target, "CLAUDE.md", records)).toBe(
      "a symbolic link sits where a regular file is recorded",
    );
    expect(keepReason(target, "mirror-link.md", records)).toBeNull();
    expect(keepReason(target, "other.md", records)).toBe(
      "the path is a symbolic link whose target is not the recorded one",
    );
    for (const path of ["as-file.md", "as-mirror-file.md"]) {
      expect(keepReason(target, path, records)).toBe(
        "a regular file sits where a link is recorded",
      );
    }
    expect(keepReason(target, "mirror-copy-as-link.md", records)).toBe(
      "a symbolic link sits where a regular file is recorded",
    );
    expect(keepReason(target, "malformed.md", records)).toBe(
      "the path is a symbolic link whose target is not the recorded one",
    );
    expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).toBe("agents\n");
  });
});

describe("retire", () => {
  // Unreadable records (a hardlink kind, a split without markers) are not the writer's to touch, and a foreign file
  // is held, never skipped, so the report names it.
  test("deletes matches, holds the rest, skips absent paths and records it has none of or cannot read", () => {
    const target = checkout({
      same: "v1\n",
      edited: "v2\n",
      unrecorded: "u\n",
      "odd-kind": "v1\n",
      "no-markers": REGION,
      "docs.yml": "d\n",
      "AGENTS.md": "a\n",
      "all-region": REGION,
      "blank-tail": `${REGION}\n  \n\n`,
      "edited-region": `${REGION.replace("managed", "edited")}mine\n`,
      "stale-tail": `${REGION}mine\n`,
    });
    symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
    const records: Records = {
      same: { class: "managed", hash: sha256("v1\n") },
      edited: { class: "managed", hash: sha256("v1\n") },
      "odd-kind": { class: "mirror", kind: "hardlink", hash: sha256("v1\n") },
      "no-markers": { class: "split", grammar: "managed-region", hash: sha256(REGION) },
      "docs.yml": { class: "managed", hash: sha256("d\n") },
      "CLAUDE.md": { class: "mirror", kind: "symlink", hash: sha256("AGENTS.md") },
      "all-region": split(sha256(REGION)),
      "blank-tail": split(sha256(REGION)),
      "edited-region": split(sha256(REGION)),
      "stale-tail": split(sha256(REGION)),
    };
    const rows = retire(
      target,
      [
        "same",
        "edited",
        "absent",
        "unrecorded",
        "odd-kind",
        "no-markers",
        "docs.yml",
        "gone.yml",
        "CLAUDE.md",
        "all-region",
        "blank-tail",
        "edited-region",
        "stale-tail",
      ],
      records,
    );
    expect(rows).toEqual([
      { path: "same", outcome: "deleted", detail: "no longer selected" },
      { path: "edited", outcome: "held", detail: "the content differs from the last write" },
      { path: "docs.yml", outcome: "deleted", detail: "no longer selected" },
      { path: "CLAUDE.md", outcome: "deleted", detail: "no longer selected" },
      { path: "all-region", outcome: "deleted", detail: "no longer selected" },
      {
        path: "blank-tail",
        outcome: "deleted",
        detail: "no longer selected; only blank lines sat outside the managed region",
      },
      { path: "edited-region", outcome: "held", detail: "the managed region was edited" },
      { path: "stale-tail", outcome: "region removed", detail: `no longer selected; ${KEPT}` },
    ]);
    for (const gone of ["same", "docs.yml", "CLAUDE.md", "all-region", "blank-tail"]) {
      expect(existsSync(join(target, gone))).toBe(false);
    }
    expect(readFileSync(join(target, "edited"), "utf-8")).toBe("v2\n");
    expect(readFileSync(join(target, "unrecorded"), "utf-8")).toBe("u\n");
    expect(readFileSync(join(target, "odd-kind"), "utf-8")).toBe("v1\n");
    expect(readFileSync(join(target, "no-markers"), "utf-8")).toBe(REGION);
    expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).toBe("a\n");
    expect(readFileSync(join(target, "edited-region"), "utf-8")).toBe(
      `${REGION.replace("managed", "edited")}mine\n`,
    );
    expect(readFileSync(join(target, "stale-tail"), "utf-8")).toBe("mine\n");
    expect(records).toEqual({
      edited: { class: "managed", hash: sha256("v1\n") },
      "odd-kind": { class: "mirror", kind: "hardlink", hash: sha256("v1\n") },
      "no-markers": { class: "split", grammar: "managed-region", hash: sha256(REGION) },
      "edited-region": split(sha256(REGION)),
    });
    for (const path of ["unrecorded", "odd-kind", "no-markers"]) {
      expect(keepReason(target, path, records)).toBe("no record of the platform writing it");
    }
  });

  // joinHalves' seam rules: the blank lines that framed the region merge into one between two halves and go when
  // one half is empty; CRLF regions keep their line ends; and the halves round-trip as bytes (latin1), so a byte
  // that is not valid UTF-8 comes back as itself, never as U+FFFD. The hand-over happens once: the record leaves.
  test.each<{ reason: string; content: string | Buffer; kept: string | Buffer }>([
    {
      reason: "a tail, no trailing newline",
      content: `${REGION}## Mine\n\nkeep this`,
      kept: "## Mine\n\nkeep this",
    },
    {
      reason: "a tail behind the blank lines that framed the region",
      content: `${REGION}\n\n## Mine\n\nkeep this\n`,
      kept: "## Mine\n\nkeep this\n",
    },
    {
      reason: "a head and a tail",
      content: `# Title\n\n${REGION}\ntail\n`,
      kept: "# Title\n\ntail\n",
    },
    {
      reason: "a head and a tail with no blank line between",
      content: `# Title\n${REGION}tail\n`,
      kept: "# Title\ntail\n",
    },
    {
      reason: "a head alone, the region at the bottom",
      content: `# Title\n\n${REGION}\n\n`,
      kept: "# Title\n",
    },
    {
      reason: "blank lines above a top region",
      content: `\n  \n${REGION}\ntail\n`,
      kept: "tail\n",
    },
    {
      reason: "CRLF lines around a CRLF region",
      content: `head\r\n\r\n${REGION.replaceAll("\n", "\r\n")}\r\ntail one\r\ntail two\r\n`,
      kept: "head\r\n\r\ntail one\r\ntail two\r\n",
    },
    {
      reason: "non-ASCII UTF-8 in the tail",
      content: `${REGION}caf\u00e9 \u2014 \u00fcber\n`,
      kept: "caf\u00e9 \u2014 \u00fcber\n",
    },
    {
      reason: "a tail byte that is not valid UTF-8",
      content: Buffer.concat([Buffer.from(REGION), Buffer.from([0xff, 0x0a])]),
      kept: Buffer.from([0xff, 0x0a]),
    },
  ])(
    "a split file with repository-owned content around its recorded region hands it over once: $reason",
    ({ content, kept }) => {
      const target = checkout({ "CONTRIBUTING.md": content });
      const crlf = typeof content === "string" && content.includes("\r\n");
      const region = crlf ? REGION.replaceAll("\n", "\r\n") : REGION;
      const records: Records = { "CONTRIBUTING.md": split(sha256(region)) };
      const expected = Buffer.from(typeof kept === "string" ? Buffer.from(kept, "utf-8") : kept);
      expect(retire(target, ["CONTRIBUTING.md"], records)).toEqual([
        {
          path: "CONTRIBUTING.md",
          outcome: "region removed",
          detail: `no longer selected; ${KEPT}`,
        },
      ]);
      expect(readFileSync(join(target, "CONTRIBUTING.md"))).toEqual(expected);
      expect(records["CONTRIBUTING.md"]).toBeUndefined();
      expect(retire(target, ["CONTRIBUTING.md"], records)).toEqual([]);
      expect(readFileSync(join(target, "CONTRIBUTING.md"))).toEqual(expected);
    },
  );
});
