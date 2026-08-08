import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChannel } from "../../.github/scripts/sync/resolve_channel.ts";

// Run the helper the way resolve_refs.ts does: imported, against a stub
// target answers file.
function resolve(channelInput: string, answers: string): string {
  const answersFile = join(mkdtempSync(join(tmpdir(), "answers-")), "answers.yml");
  writeFileSync(answersFile, answers);
  return resolveChannel(channelInput, answersFile);
}

// The precedence rule: fleet config (the channel input) > the target's
// recorded copier answer > latest.
describe("resolve_channel", () => {
  test("a non-empty channel input wins over the recorded answer", () => {
    expect(resolve("staging", "_commit: templates/v1.0.0\nchannel: latest\n")).toBe("staging");
  });

  test("an empty channel input falls back to the recorded answer", () => {
    expect(resolve("", "_commit: templates/v1.0.0\nchannel: staging\n")).toBe("staging");
  });

  test("no input and no recorded answer defaults to latest", () => {
    expect(resolve("", "_commit: templates/v1.0.0\n")).toBe("latest");
  });
});
