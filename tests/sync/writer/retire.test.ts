// Retirement over a fixture git checkout: deletion only on a recorded-hash
// match, holds for every other state, starters kept, moves through git mv
// with the record travelling, and stale records treated like retirements.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HASH_REGION_MARKERS } from "../../../actions/shared/grammar.ts";
import { type Records, sha256 } from "../../../.github/scripts/sync/writer/manifest.ts";
import { keepReason, retire } from "../../../.github/scripts/sync/writer/retire.ts";
import { renderRegion } from "../../../.github/scripts/sync/writer/write_split.ts";
import { fixtureGit } from "../../shared/fixture_git";
import { tempDirs } from "../../shared/temp_dir";

const temp = tempDirs();
const M = HASH_REGION_MARKERS;

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
      "region-tail": `${REGION}mine\n`,
      starter: "s\n",
      unrecorded: "u\n",
      nohash: "n\n",
    });
    const records: Records = {
      same: { class: "managed", hash: sha256("v1\n") },
      edited: { class: "managed", hash: sha256("v1\n") },
      region: split(sha256(REGION)),
      "region-tail": split(sha256(REGION)),
      starter: { class: "starter" },
      nohash: { class: "managed", hash: null },
    };
    expect(keepReason(target, "same", records)).toBeNull();
    expect(keepReason(target, "region", records)).toBeNull();
    expect(keepReason(target, "edited", records)).toBe("the content differs from the last write");
    expect(keepReason(target, "region-tail", records)).toBe(
      "the file carries repository-owned content outside the managed region",
    );
    expect(keepReason(target, "starter", records)).toBe("a starter is repo-owned");
    expect(keepReason(target, "unrecorded", records)).toBe("no record of the platform writing it");
    expect(keepReason(target, "nohash", records)).toBe("the record carries no hash");
  });
});

describe("retire", () => {
  test("deletes matches, holds the rest, keeps starters, skips absent paths", () => {
    const target = checkout({ same: "v1\n", edited: "v2\n", starter: "s\n" });
    const records: Records = {
      same: { class: "managed", hash: sha256("v1\n") },
      edited: { class: "managed", hash: sha256("v1\n") },
      starter: { class: "starter" },
    };
    const rows = retire(
      target,
      [{ path: "same" }, { path: "edited" }, { path: "starter" }, { path: "absent" }],
      [],
      records,
    );
    expect(rows).toEqual([
      { path: "same", outcome: "deleted", detail: "retired" },
      { path: "edited", outcome: "held", detail: "the content differs from the last write" },
      { path: "starter", outcome: "kept", detail: "a starter is repo-owned" },
    ]);
    expect(existsSync(join(target, "same"))).toBe(false);
    expect(existsSync(join(target, "edited"))).toBe(true);
    expect(records.same).toBeUndefined();
  });

  test("moves through git mv with the record, and holds when the new path exists", () => {
    const target = checkout({ "SECURITY.md": "policy\n", "old.md": "o\n", "new.md": "n\n" });
    const records: Records = { "SECURITY.md": { class: "managed", hash: sha256("policy\n") } };
    const rows = retire(
      target,
      [
        { path: "SECURITY.md", moved_to: ".github/SECURITY.md" },
        { path: "old.md", moved_to: "new.md" },
      ],
      [],
      records,
    );
    expect(rows).toEqual([
      { path: "SECURITY.md", outcome: "moved", detail: "to .github/SECURITY.md" },
      {
        path: "old.md",
        outcome: "held",
        detail: "new.md already exists, so the file was not moved over it",
      },
    ]);
    expect(existsSync(join(target, "SECURITY.md"))).toBe(false);
    expect(fixtureGit(target, ["status", "--porcelain"])).toBe(
      "R  SECURITY.md -> .github/SECURITY.md",
    );
    expect(records[".github/SECURITY.md"]).toEqual({ class: "managed", hash: sha256("policy\n") });
    expect(records["SECURITY.md"]).toBeUndefined();
  });

  test("stale recorded paths retire the same way, labelled as no longer selected", () => {
    const target = checkout({ "docs.yml": "d\n" });
    const records: Records = { "docs.yml": { class: "managed", hash: sha256("d\n") } };
    expect(retire(target, [], ["docs.yml", "gone.yml"], records)).toEqual([
      { path: "docs.yml", outcome: "deleted", detail: "no longer selected" },
    ]);
  });
});
