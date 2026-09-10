import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mermaidRule } from "../../../actions/pages-site/.vitepress/mermaid.ts";
import { vitepressRenderer } from "./vitepress_renderer.ts";

// markdown-it is the action's dependency, not the root's: resolve it from
// the action's own tree, the way the table-wrap test does.
type Md = Parameters<typeof mermaidRule>[0];
const ACTION_DIR = resolve(import.meta.dir, "../../../actions/pages-site");
const { default: MarkdownIt } = (await import(Bun.resolveSync("markdown-it", ACTION_DIR))) as {
  default: new () => Md;
};

// Every character the escape must touch, plus the hexagon node's `{{ }}`,
// which the mount's v-pre keeps out of Vue's compiler.
const SOURCE = 'graph TD\n  A["x <b>& y</b>"] -->|"go"| B{{done}}';
const MOUNT =
  '<div class="fleet-mermaid" v-pre><pre class="fleet-mermaid-source">' +
  "graph TD\n  A[&quot;x &lt;b&gt;&amp; y&lt;/b&gt;&quot;] --&gt;|&quot;go&quot;| B{{done}}" +
  "</pre></div>\n";

/** A renderer as VitePress hands it to markdown.config: its fence chain
 *  (highlighter, copy button, line numbers) already installed, stood in for
 *  by one rule that names the fence it received. */
function render(markdown: string): string {
  const md = new MarkdownIt();
  md.renderer.rules.fence = (tokens, idx) => `<HIGHLIGHTED ${tokens[idx].info.trim()}>\n`;
  mermaidRule(md);
  return md.render(markdown);
}

test.each([
  ["mermaid", MOUNT],
  ["mermaid {1}", MOUNT],
  ["mermaid:line-numbers", MOUNT],
  ["mermaidjs", "<HIGHLIGHTED mermaidjs>\n"],
  ["ts", "<HIGHLIGHTED ts>\n"],
  ["", "<HIGHLIGHTED >\n"],
])("a fence with info %j renders as", (info, expected) => {
  expect(render(`\`\`\`${info}\n${SOURCE}\n\`\`\`\n`)).toBe(expected);
});

test("a page keeps its prose and its other fences around the mount, tilde fences included", () => {
  const html = render(
    `# Title\n\n~~~mermaid\n${SOURCE}\n~~~\n\nProse.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n`,
  );
  expect(html).toBe(`<h1>Title</h1>\n${MOUNT}<p>Prose.</p>\n<HIGHLIGHTED ts>\n`);
});

// Through VitePress's own renderer, whose code-group container marks its
// first fence active and whose tabs show the block carrying `.active`: a
// mount in a group is a `vp-block` (the class VitePress gives a group's
// non-code block), active when first, and the fence's `[Title]` names its
// tab; outside a group the mount carries neither class.
test("a mermaid fence in a code group is a vp-block the tabs can switch, active when first", async () => {
  const md = await vitepressRenderer();
  const group = (first: string, second: string) =>
    md.render(
      `::: code-group\n\n${first}\n\n${second}\n\n:::\n\n\`\`\`mermaid\ngraph LR\n\`\`\`\n`,
    );
  const diagram = "```mermaid [Diagram]\ngraph LR\n```";
  const code = "```ts [Source]\nconst x = 1;\n```";
  const mount = (classes: string) =>
    `<div class="${classes}" v-pre><pre class="fleet-mermaid-source">graph LR</pre></div>`;
  const diagramFirst = group(diagram, code);
  expect(diagramFirst).toContain(mount("fleet-mermaid vp-block active"));
  expect(diagramFirst).toContain('<div class="language-ts vp-adaptive-theme">');
  expect(diagramFirst).not.toContain('<div class="language-ts vp-adaptive-theme active">');
  expect(diagramFirst).toContain('data-title="Diagram"');
  expect(diagramFirst).toContain('data-title="Source"');
  expect(diagramFirst).toContain(mount("fleet-mermaid"));
  const codeFirst = group(code, diagram);
  expect(codeFirst).toContain('<div class="language-ts vp-adaptive-theme active">');
  expect(codeFirst).toContain(mount("fleet-mermaid vp-block"));
  expect(codeFirst).not.toContain("vp-block active");
});
