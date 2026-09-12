import { describe, expect, test } from "bun:test";
import {
  earlierRelease,
  type SmokeReading,
  smokeProblems,
} from "../../.github/scripts/ci/bun_setup_smoke";

describe("earlierRelease", () => {
  test.each([
    ["1.4.0", "1.3.0"],
    ["1.4.2", "1.4.1"],
    ["1.4.2\n", "1.4.1"],
  ])("%s -> %s", (version, previous) => {
    expect(earlierRelease(version)).toBe(previous);
  });

  test.each(["2.0.0", "0.0.0", "1.4", "v1.4.0", ""])("refuses %j", (version) => {
    expect(() => earlierRelease(version)).toThrow();
  });
});

describe("smokeProblems", () => {
  const good: SmokeReading = {
    current: "1.4.0",
    previous: "1.3.0",
    first: { path: "/opt/bun/1.4.0/bun", ready: "true", installed: "false", version: "1.4.0" },
    second: { path: "/opt/bun/1.3.0/bun", ready: "true", installed: "true", version: "1.3.0" },
  };

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
    {
      reason: "neither call ready",
      reading: {
        ...good,
        first: { ...good.first, ready: "false" },
        second: { ...good.second, ready: "false" },
      },
      problems: ["first ready is 'false'", "second ready is 'false'"],
    },
  ])("$reason", ({ reading, problems }) => {
    expect(smokeProblems(reading)).toEqual(problems);
  });
});
