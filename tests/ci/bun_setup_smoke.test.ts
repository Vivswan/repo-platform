import { describe, expect, test } from "bun:test";
import {
  earlierRelease,
  type SmokeReading,
  smokeProblems,
} from "../../.github/scripts/ci/bun_setup_smoke";
import { clientOver } from "../shared/fake_github";

describe("earlierRelease", () => {
  interface Release {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
  }

  const release = (tag_name: string, flags: Partial<Release> = {}): Release => ({
    tag_name,
    draft: false,
    prerelease: false,
    ...flags,
  });

  const listing = (tags: Release[]) =>
    clientOver({ "repos/oven-sh/bun/releases": [{ status: 200, body: tags }] }).client;

  // The smoke's second call installs this version, so it must be one bun published. Arithmetic on the pin guessed it:
  // a new major had no answer (the job went red on the pull request bumping bun) and a skipped number named no release.
  test.each<{ reason: string; pin: string; tags: Release[]; previous: string }>([
    {
      reason: "a new major's predecessor is the last release of the old major",
      pin: "2.0.0",
      tags: [release("bun-v2.0.0"), release("bun-v1.9.3"), release("bun-v1.9.2")],
      previous: "1.9.3",
    },
    {
      reason: "a patch number upstream skipped is not a release",
      pin: "1.4.3",
      tags: [release("bun-v1.4.1"), release("bun-v1.4.3"), release("bun-v1.4.0")],
      previous: "1.4.1",
    },
    {
      reason: "a canary, a pre-release, a draft, and a newer release are never the predecessor",
      pin: "1.4.0",
      tags: [
        release("canary", { prerelease: true }),
        release("bun-v1.4.1"),
        release("bun-v1.3.12", { prerelease: true }),
        release("bun-v1.3.11", { draft: true }),
        release("bun-v1.3.9"),
        release("bun-v1.3.10"),
      ],
      previous: "1.3.10",
    },
  ])("$reason", async ({ pin, tags, previous }) => {
    expect(await earlierRelease(pin, listing(tags))).toBe(previous);
  });
});

describe("smokeProblems", () => {
  const good: SmokeReading = {
    current: "1.4.0",
    previous: "1.3.0",
    first: { path: "/opt/bun/1.4.0/bun", installed: "false", version: "1.4.0" },
    second: { path: "/opt/bun/1.3.0/bun", installed: "true", version: "1.3.0" },
  };

  // ci.yml's bun-setup smoke job runs this judge over two recorded calls; a verdict that
  // never finds a problem keeps that job green forever, so every field has a row here.
  test.each<{ reason: string; reading: SmokeReading; problems: string[] }>([
    { reason: "the current bun reused, the previous one installed", reading: good, problems: [] },
    {
      reason: "the first call installed although the current bun was on PATH",
      reading: { ...good, first: { ...good.first, installed: "true" } },
      problems: ["first installed is 'true', expected false"],
    },
    {
      reason: "the second call reused the current bun instead of installing the previous",
      reading: { ...good, second: { ...good.first } },
      problems: [
        "second version is '1.4.0', pin is '1.3.0'",
        "second installed is 'false', expected true",
      ],
    },
    {
      reason: "a first path that is not absolute and prints nothing",
      reading: { ...good, first: { ...good.first, path: "bun", version: "" } },
      problems: ["first path is not absolute: 'bun'", "first version is '', pin is '1.4.0'"],
    },
  ])("$reason", ({ reading, problems }) => {
    expect(smokeProblems(reading)).toEqual(problems);
  });
});
