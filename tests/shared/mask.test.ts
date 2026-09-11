import { describe, expect, test } from "bun:test";
import { maskForms } from "../../.github/scripts/shared/mask.ts";

describe("maskForms", () => {
  test("carries the slug, both URL spellings, the bare name, and their lower-case forms once each", () => {
    expect(maskForms("Vivswan/Hidden-Server")).toEqual([
      "Vivswan/Hidden-Server",
      "vivswan/hidden-server",
      "https://github.com/Vivswan/Hidden-Server",
      "https://github.com/vivswan/hidden-server",
      "https://github.com/Vivswan/Hidden-Server.git",
      "https://github.com/vivswan/hidden-server.git",
      "git@github.com:Vivswan/Hidden-Server.git",
      "git@github.com:vivswan/hidden-server.git",
      "Hidden-Server",
      "hidden-server",
    ]);
  });

  test("a short bare name is not masked on its own (it would garble every innocent occurrence)", () => {
    const forms = maskForms("Vivswan/api");
    expect(forms).toContain("Vivswan/api");
    expect(forms).not.toContain("api");
  });
});
