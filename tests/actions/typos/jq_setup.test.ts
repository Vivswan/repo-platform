// jq prints its version behind a `jq-` prefix: a version read with the prefix never equals the pin, so a runner's jq at
// the pin would be fetched again and the fetched one refused.

import { expect, test } from "bun:test";
import { jqRelease } from "../../../actions/typos/jq-setup.ts";

const release = jqRelease("1.8.2", { X64: "a".repeat(64), ARM64: "b".repeat(64) });

test("jq's version is read past the prefix it prints", () => {
  expect(release.versionPattern.exec("jq-1.8.2\n")?.[1]).toBe("1.8.2");
});
