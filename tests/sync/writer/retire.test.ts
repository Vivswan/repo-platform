import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Records,
  readRecords,
  writeManifest,
} from "../../../.github/scripts/sync/writer/manifest.ts";
import { keepReason, retire } from "../../../.github/scripts/sync/writer/retire.ts";
import { renderRegion } from "../../../.github/scripts/sync/writer/write_split.ts";
import { HASH_REGION_MARKERS } from "../../../actions/shared/grammar.ts";
import { sha256 } from "../../../actions/shared/values.ts";
import { fixtureGit } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const M = HASH_REGION_MARKERS;
const BUILD = "0123456789abcdef0123456789abcdef01234567";
// A variable, so neither the linter nor the type checker reads the lookup
// as the inherited property.
const PROTO = "__proto__";

function checkout(files: Record<string, string>): string {
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

describe("keepReason", () => {
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
    // A hash-null record is not one the writer reads, so it vouches for nothing.
    expect(keepReason(target, "nohash", records)).toBe("no record of the platform writing it");
  });
});

describe("keepReason on symbolic links", () => {
  test("a link is judged by its target string under a symlink-mirror record, and by class under any other", () => {
    // as-mirror-file.md holds the link target string itself, so only the record's kind can tell it from the link.
    const target = checkout({
      "AGENTS.md": "agents\n",
      "as-file.md": "not a link\n",
      "as-mirror-file.md": "AGENTS.md",
    });
    symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
    symlinkSync("../AGENTS.md", join(target, "other.md"));
    symlinkSync("AGENTS.md", join(target, "mirror-link.md"));
    symlinkSync("AGENTS.md", join(target, "mirror-copy-as-link.md"));
    // Raw target bytes that decode to the recorded target's text: only a byte comparison tells them apart.
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
  test("deletes matches, holds the rest, skips absent paths and records it has none of or cannot read", () => {
    const target = checkout({
      same: "v1\n",
      edited: "v2\n",
      unrecorded: "u\n",
      "odd-kind": "v1\n",
      "no-markers": REGION,
    });
    const records: Records = {
      same: { class: "managed", hash: sha256("v1\n") },
      edited: { class: "managed", hash: sha256("v1\n") },
      // Hand edits the writer cannot read: their files match the hashes, and are still not its to touch.
      "odd-kind": { class: "mirror", kind: "hardlink", hash: sha256("v1\n") },
      "no-markers": { class: "split", grammar: "managed-region", hash: sha256(REGION) },
    };
    const rows = retire(
      target,
      ["same", "edited", "absent", "unrecorded", "odd-kind", "no-markers"],
      records,
    );
    expect(rows).toEqual([
      { path: "same", outcome: "deleted", detail: "no longer selected" },
      { path: "edited", outcome: "held", detail: "the content differs from the last write" },
    ]);
    expect(existsSync(join(target, "same"))).toBe(false);
    expect(readFileSync(join(target, "edited"), "utf-8")).toBe("v2\n");
    expect(readFileSync(join(target, "unrecorded"), "utf-8")).toBe("u\n");
    expect(readFileSync(join(target, "odd-kind"), "utf-8")).toBe("v1\n");
    expect(readFileSync(join(target, "no-markers"), "utf-8")).toBe(REGION);
    expect(records).toEqual({
      edited: { class: "managed", hash: sha256("v1\n") },
      "odd-kind": { class: "mirror", kind: "hardlink", hash: sha256("v1\n") },
      "no-markers": { class: "split", grammar: "managed-region", hash: sha256(REGION) },
    });
    for (const path of ["unrecorded", "odd-kind", "no-markers"]) {
      expect(keepReason(target, path, records)).toBe("no record of the platform writing it");
    }
  });

  test("a path named __proto__ is judged, deleted, and unrecorded like any other", () => {
    const target = checkout({ "old.md": "o\n" });
    // An object literal keyed __proto__ would set the fixture's prototype.
    writeFileSync(join(target, PROTO), "mine\n");
    writeManifest(target, { "old.md": { class: "managed", hash: sha256("o\n") } }, BUILD);
    const unrecorded = readRecords(target).records;
    expect(retire(target, [PROTO], unrecorded)).toEqual([]);
    expect(readFileSync(join(target, PROTO), "utf-8")).toBe("mine\n");
    expect(keepReason(target, PROTO, unrecorded)).toBe("no record of the platform writing it");
    writeManifest(
      target,
      Object.fromEntries([[PROTO, { class: "managed", hash: sha256("mine\n") }]]),
      BUILD,
    );
    const records = readRecords(target).records;
    expect(Object.hasOwn(records, PROTO)).toBe(true);
    expect(retire(target, [PROTO], records)).toEqual([
      { path: PROTO, outcome: "deleted", detail: "no longer selected" },
    ]);
    expect(existsSync(join(target, PROTO))).toBe(false);
    expect(Object.hasOwn(records, PROTO)).toBe(false);
  });

  test("a symlink mirror record is judged by its target string, and an absent stale path makes no row", () => {
    const target = checkout({ "docs.yml": "d\n", "AGENTS.md": "a\n" });
    symlinkSync("AGENTS.md", join(target, "CLAUDE.md"));
    const records: Records = {
      "docs.yml": { class: "managed", hash: sha256("d\n") },
      "CLAUDE.md": { class: "mirror", kind: "symlink", hash: sha256("AGENTS.md") },
    };
    expect(retire(target, ["docs.yml", "gone.yml", "CLAUDE.md"], records)).toEqual([
      { path: "docs.yml", outcome: "deleted", detail: "no longer selected" },
      { path: "CLAUDE.md", outcome: "deleted", detail: "no longer selected" },
    ]);
    expect(existsSync(join(target, "CLAUDE.md"))).toBe(false);
    expect(readFileSync(join(target, "AGENTS.md"), "utf-8")).toBe("a\n");
  });

  const KEPT =
    "repository-owned content kept as a plain file; the region is gone, so read the file whole, give it a heading and intro if it lost them, or delete it";
  test.each([
    ["a tail, no trailing newline", `${REGION}## Mine\n\nkeep this`, "## Mine\n\nkeep this"],
    [
      "a tail behind the blank lines that framed the region",
      `${REGION}\n\n## Mine\n\nkeep this\n`,
      "## Mine\n\nkeep this\n",
    ],
    ["a head and a tail", `# Title\n\n${REGION}\ntail\n`, "# Title\n\ntail\n"],
    ["a head and a tail with no blank line between", `# Title\n${REGION}tail\n`, "# Title\ntail\n"],
    ["a head alone, the region at the bottom", `# Title\n\n${REGION}\n\n`, "# Title\n"],
    ["blank lines above a top region", `\n  \n${REGION}\ntail\n`, "tail\n"],
    [
      "CRLF lines around a CRLF region",
      `head\r\n\r\n${REGION.replaceAll("\n", "\r\n")}\r\ntail one\r\ntail two\r\n`,
      "head\r\n\r\ntail one\r\ntail two\r\n",
    ],
    [
      "non-ASCII bytes in the tail",
      `${REGION}caf\u00e9 \u2014 \u00fcber\n`,
      "caf\u00e9 \u2014 \u00fcber\n",
    ],
  ])(
    "a split file with repository-owned content around its recorded region hands it over once: %s",
    (_name, content, kept) => {
      const target = checkout({ "CONTRIBUTING.md": content });
      const region = content.includes("\r\n") ? REGION.replaceAll("\n", "\r\n") : REGION;
      const records: Records = { "CONTRIBUTING.md": split(sha256(region)) };
      const rows = retire(target, ["CONTRIBUTING.md"], records);
      expect(rows).toEqual([
        {
          path: "CONTRIBUTING.md",
          outcome: "region removed",
          detail: `no longer selected; ${KEPT}`,
        },
      ]);
      expect(readFileSync(join(target, "CONTRIBUTING.md"))).toEqual(Buffer.from(kept, "utf-8"));
      expect(records["CONTRIBUTING.md"]).toBeUndefined();
      expect(retire(target, ["CONTRIBUTING.md"], records)).toEqual([]);
      expect(readFileSync(join(target, "CONTRIBUTING.md"))).toEqual(Buffer.from(kept, "utf-8"));
    },
  );

  test("deletes an all-region or blank-framed split file, holds an edited region, and hands over a tailed one", () => {
    const target = checkout({
      "all-region": REGION,
      "blank-tail": `${REGION}\n  \n\n`,
      edited: `${REGION.replace("managed", "edited")}mine\n`,
      "stale-tail": `${REGION}mine\n`,
    });
    const records: Records = {
      "all-region": split(sha256(REGION)),
      "blank-tail": split(sha256(REGION)),
      edited: split(sha256(REGION)),
      "stale-tail": split(sha256(REGION)),
    };
    const rows = retire(target, ["all-region", "blank-tail", "edited", "stale-tail"], records);
    expect(rows).toEqual([
      { path: "all-region", outcome: "deleted", detail: "no longer selected" },
      {
        path: "blank-tail",
        outcome: "deleted",
        detail: "no longer selected; only blank lines sat outside the managed region",
      },
      { path: "edited", outcome: "held", detail: "the managed region was edited" },
      {
        path: "stale-tail",
        outcome: "region removed",
        detail: `no longer selected; ${KEPT}`,
      },
    ]);
    expect(existsSync(join(target, "all-region"))).toBe(false);
    expect(existsSync(join(target, "blank-tail"))).toBe(false);
    expect(readFileSync(join(target, "edited"), "utf-8")).toBe(
      `${REGION.replace("managed", "edited")}mine\n`,
    );
    expect(readFileSync(join(target, "stale-tail"), "utf-8")).toBe("mine\n");
    expect(Object.keys(records)).toEqual(["edited"]);
  });

  test("a path under a symlinked directory is refused, never unlinked through the link", () => {
    const target = checkout({ "shared/x": "v\n" });
    symlinkSync("shared", join(target, "docs"));
    const records: Records = { "docs/x": { class: "managed", hash: sha256("v\n") } };
    expect(() => retire(target, ["docs/x"], records)).toThrow("ancestor 'docs' is a symbolic link");
    expect(existsSync(join(target, "shared/x"))).toBe(true);
  });
});
