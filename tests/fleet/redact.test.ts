import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assignHints,
  type DiscoveredRepo,
  enrich,
  enrichedRowSchema,
  hintName,
  parseDiscoveredList,
  VERIFY_HEX_LENGTH,
  verifyTag,
} from "../../.github/scripts/fleet/redact.ts";
import { boundedSpawnSync } from "../shared/bounded_spawn";

describe("hintName", () => {
  test.each([
    {
      name: "hidden-server",
      hint: "h**-s**r",
      reason: "a final of five or more keeps its last char",
    },
    { name: "chromium-bridge", hint: "c**-b**e", reason: "same rule on a longer final" },
    { name: "myrepo", hint: "m**o", reason: "a single long segment is its own final" },
    // A final under five chars would echo most of the name back.
    { name: "ab", hint: "a**", reason: "a two-char final echoes nothing" },
    { name: "api", hint: "a**", reason: "a three-char final echoes nothing" },
    { name: "home", hint: "h**", reason: "four chars is still under five" },
    { name: "a-b", hint: "a**-b**", reason: "a short final after a separator echoes nothing" },
    { name: "a.b_c", hint: "a**.b**_c**", reason: "every separator kind renders literally" },
    { name: "a--b", hint: "a**-**-b**", reason: "an empty segment renders as ** alone" },
    { name: "Repo2", hint: "R**2", reason: "case and digits pass through" },
    { name: "cloud-speech", hint: "c**-s**h", reason: "the initial keeps the name's case" },
  ])("$name -> $hint: $reason", ({ name, hint }) => {
    expect(hintName(name)).toBe(hint);
  });
});

describe("assignHints", () => {
  test("collisions get deterministic #N suffixes in slug order", () => {
    // "hail-sooner" and "hidden-server" share the base hint; slug order
    // decides who keeps it.
    expect(assignHints(["o/hidden-server", "o/hail-sooner", "o/skills"])).toEqual(
      new Map([
        ["o/hail-sooner", "h**-s**r"],
        ["o/hidden-server", "h**-s**r#2"],
        ["o/skills", "s**s"],
      ]),
    );
  });

  test("duplicate slugs assign once", () => {
    // The value is the claim: a duplicate that consumed a collision slot
    // would overwrite the same key with "#2" and still leave ONE entry.
    expect(assignHints(["o/a-repo", "o/a-repo"])).toEqual(new Map([["o/a-repo", "a**-r**"]]));
  });
});

describe("verifyTag", () => {
  test("is stable, truncated, and case-insensitive over the slug", () => {
    const tag = verifyTag("pat-value", "12345", "Owner/Hidden-Server");
    expect(tag).toBe(verifyTag("pat-value", "12345", "owner/hidden-server"));
    expect(tag).toHaveLength(VERIFY_HEX_LENGTH);
    expect(tag).toMatch(/^[0-9a-f]+$/);
    // Different run, key, or slug: different tag.
    expect(verifyTag("pat-value", "99999", "Owner/Hidden-Server")).not.toBe(tag);
    expect(verifyTag("other-pat", "12345", "Owner/Hidden-Server")).not.toBe(tag);
    expect(verifyTag("pat-value", "12345", "owner/other")).not.toBe(tag);
  });

  test("rejects an empty PAT instead of deriving a publicly known key", () => {
    expect(() => verifyTag("", "424242", "o/r")).toThrow(/empty PAT/);
  });
});

describe("enrich", () => {
  const tagFor = (slug: string) => `tag(${slug})`;

  test("one row per discovered repo, sorted by slug: private rows hinted and tagged, public rows plain", () => {
    // The whole output for a small fleet, discovery order scrambled: the
    // rows come back sorted, and the shape of each is the contract.
    expect(
      enrich(
        [
          { repo: "o/pub", private: false },
          { repo: "o/hidden-one", private: true },
        ],
        tagFor,
      ),
    ).toEqual([
      { repo: "o/hidden-one", private: true, display: "h**-o**", verify: "tag(o/hidden-one)" },
      { repo: "o/pub", private: false, display: "o/pub", verify: "" },
    ]);
  });

  test("hints number collisions over the whole discovered fleet", () => {
    // A scope narrows AFTER enrichment, so a single-repo dispatch numbers
    // collision suffixes the same way a full run does.
    const rows = enrich(
      [
        { repo: "o/hidden-server", private: true },
        { repo: "o/hail-sooner", private: true },
      ],
      tagFor,
    );
    expect(rows.map((row) => row.display)).toEqual(["h**-s**r", "h**-s**r#2"]);
  });

  test("an empty fleet is an empty row list", () => {
    expect(enrich([], tagFor)).toEqual([]);
  });
});

describe("enrichedRowSchema", () => {
  const hidden = { repo: "o/hidden-one", private: true, display: "h**-o**", verify: "deadbeef" };
  const plain = { repo: "o/pub", private: false, display: "o/pub", verify: "" };

  test("accepts both row kinds", () => {
    expect(enrichedRowSchema.safeParse(hidden).success).toBe(true);
    expect(enrichedRowSchema.safeParse(plain).success).toBe(true);
  });

  // The issue path pins WHICH rule fired: success=false alone cannot tell
  // the display refinement from a union arm failing for another reason.
  test.each<{ reason: string; row: Record<string, unknown>; path: PropertyKey[] }>([
    {
      reason: "a private row missing its verify tag",
      row: { ...hidden, verify: "" },
      path: ["verify"],
    },
    {
      reason: "a private row whose display is the slug, not a hint",
      row: { ...hidden, display: "o/hidden-one" },
      path: ["display"],
    },
    {
      reason: "a public row carrying a verify tag",
      row: { ...plain, verify: "deadbeef" },
      path: ["verify"],
    },
    {
      reason: "a public row whose display is a hint, not its slug",
      row: { ...plain, display: "p**" },
      path: ["display"],
    },
  ])("rejects $reason", ({ row, path }) => {
    const result = enrichedRowSchema.safeParse(row);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("expected a rejection");
    expect(result.error.issues.map((issue) => issue.path)).toEqual([path]);
  });

  test("rejects a row with neither flag shape (a non-boolean private)", () => {
    expect(enrichedRowSchema.safeParse({ ...plain, private: "false" }).success).toBe(false);
  });
});

// The discovered list fails CLOSED: an entry without an explicit boolean
// `private` rejects the whole list.
describe("parseDiscoveredList", () => {
  // Identity on every accepted payload: only repo and private are
  // inspected; everything else passes through untouched, whatever its
  // type - pinned so a schema tightening cannot silently change it.
  test.each<{ reason: string; input: (DiscoveredRepo & Record<string, unknown>)[] }>([
    {
      reason: "{repo, private} entries pass their extra keys through",
      input: [{ repo: "o/a", private: true, archived: false, pushed_at: "now" }],
    },
    { reason: "an empty list is valid", input: [] },
    {
      reason: "a wrong-typed EXTRA key survives unchanged (only repo and private are inspected)",
      input: [{ repo: "o/a", private: true, extra: 42 }],
    },
  ])("accepts: $reason", ({ input }) => {
    expect(parseDiscoveredList(input)).toEqual(input);
  });

  test("rejects a missing or non-boolean private (fail closed, whole list)", () => {
    expect(parseDiscoveredList([{ repo: "o/a" }])).toBeNull();
    expect(parseDiscoveredList([{ repo: "o/a", private: "true" }])).toBeNull();
    expect(parseDiscoveredList([{ repo: "o/a", private: true }, { repo: "o/b" }])).toBeNull();
  });

  test("rejects non-object entries, a non-string repo, and a non-array payload", () => {
    expect(parseDiscoveredList(["o/a"])).toBeNull();
    expect(parseDiscoveredList([{ repo: 7, private: true }])).toBeNull();
    expect(parseDiscoveredList({ repo: "o/a", private: true })).toBeNull();
  });
});

describe("redact CLI", () => {
  const script = join(import.meta.dir, "../../.github/scripts/fleet/redact.ts");

  test("hint subcommand prints the hint", () => {
    const proc = boundedSpawnSync(["bun", script, "hint", "hidden-server"]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.trim()).toBe("h**-s**r");
  });

  test("any other subcommand fails with the usage line", () => {
    const proc = boundedSpawnSync(["bun", script, "enrich"]);
    expect(proc.exitCode).toBe(1);
    expect(proc.stdout).toContain("usage: redact.ts hint <name>");
  });
});
