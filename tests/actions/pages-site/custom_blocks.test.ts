import { describe, expect, test } from "bun:test";
import { vitepressRenderer } from "./vitepress_renderer.ts";

describe("alertTitlesRule under VitePress's renderer", () => {
  // VitePress's GitHub-alert plugin is the external fact: it hands the rule an author's own title and the uppercase
  // default through the same token field, so the rule must retitle one and leave the other.
  test("GitHub-style alerts take the container labels; an author's own title stays unless it spells the default", async () => {
    const md = await vitepressRenderer();
    const src = [
      "> [!NOTE]",
      "> a",
      "",
      "> [!TIP]",
      "> b",
      "",
      "> [!IMPORTANT]",
      "> c",
      "",
      "> [!WARNING]",
      "> d",
      "",
      "> [!CAUTION]",
      "> e",
      "",
      "> [!WARNING] Mind the gap",
      "> f",
      "",
      "> [!WARNING] WARNING",
      "> g",
      "",
      "::: warning",
      "h",
      ":::",
      "",
    ].join("\n");
    const alert = (type: string, title: string, body: string) =>
      `<div class="${type} custom-block github-alert"><p class="custom-block-title">${title}</p>\n<p>${body}</p>\n</div>\n`;
    expect(md.render(src, { relativePath: "page.md", path: "/site/page.md" })).toBe(
      alert("note", "Note", "a") +
        alert("tip", "Tip", "b") +
        alert("important", "Important", "c") +
        alert("warning", "Warning", "d") +
        alert("caution", "Caution", "e") +
        alert("warning", "Mind the gap", "f") +
        alert("warning", "Warning", "g") +
        '<div class="warning custom-block"><p class="custom-block-title">Warning</p>\n<p>h</p>\n</div>\n',
    );
  });
});
