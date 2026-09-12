// bun has no DOM, so the document holds only what the render pass touches.

import { beforeEach, expect, test } from "bun:test";
import { HUES } from "../../../actions/pages-site/.vitepress/theme/tokens.ts";

class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  className = "";
  innerHTML = "";
  textContent = "";
  dataset: Record<string, string> = {};
  constructor(readonly tag: string) {}
  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }
  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  /** Only the `:scope > .class` form the pass uses. */
  querySelector(selector: string): FakeElement | null {
    const match = /^:scope > \.([\w-]+)$/.exec(selector);
    if (match === null) throw new Error(`unsupported selector ${selector}`);
    return this.children.find((child) => child.className.split(" ").includes(match[1])) ?? null;
  }
  get shape(): string {
    const content = this.tag === "div" && this.innerHTML !== "" ? this.innerHTML : this.textContent;
    return `${this.tag}.${this.className}:${content}`;
  }
}

const mounts: FakeElement[] = [];
const html = new FakeElement("html");
(globalThis as { document?: unknown }).document = {
  documentElement: html,
  querySelectorAll: () => mounts,
  createElement: (tag: string) => new FakeElement(tag),
};

interface Held {
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Each render's SVG carries its ordinal, so a stale result landing is visible. */
const stub = { failLoad: false, hold: false, held: [] as Held[] };
const calls = { loads: 0, initialize: [] as Record<string, unknown>[], renders: [] as string[] };
Bun.plugin({
  name: "mermaid-stub",
  setup(build) {
    build.module("mermaid", () => {
      calls.loads += 1;
      if (stub.failLoad) throw new Error("offline");
      return {
        loader: "object",
        exports: {
          default: {
            initialize(config: Record<string, unknown>) {
              calls.initialize.push(config);
            },
            async render(id: string, source: string) {
              calls.renders.push(id);
              const ordinal = calls.renders.length;
              if (stub.hold) {
                await new Promise<void>((resolve, reject) => stub.held.push({ resolve, reject }));
              }
              if (source.endsWith("-->")) throw new Error("Parse error on line 2:\nA -->\n-----^");
              return { svg: `<svg data-render="${ordinal}">${source}</svg>` };
            },
          },
        },
      };
    });
  },
});

const { renderAll } = await import(
  "../../../actions/pages-site/.vitepress/theme/mermaid-render.ts"
);

function mount(source: string): FakeElement {
  const element = new FakeElement("div");
  element.className = "fleet-mermaid";
  const pre = new FakeElement("pre");
  pre.className = "fleet-mermaid-source";
  pre.textContent = source;
  element.append(pre);
  mounts.push(element);
  return element;
}

const shapes = (element: FakeElement) => element.children.map((child) => child.shape);
const darkModes = () =>
  calls.initialize.map((config) => (config.themeVariables as { darkMode: boolean }).darkMode);

async function heldRenders(count: number): Promise<void> {
  for (let i = 0; i < 100 && stub.held.length < count; i += 1) await Bun.sleep(1);
  expect(stub.held).toHaveLength(count);
}

beforeEach(() => {
  mounts.length = 0;
  html.dataset = { fleetHue: "2" };
  calls.initialize.length = 0;
  calls.renders.length = 0;
  stub.failLoad = false;
  stub.hold = false;
  stub.held.length = 0;
});

// First, before any run has loaded the package: a load that fails is not
// cached, so the next run imports again (bun re-runs the stub's factory).
test("no mount never loads mermaid; a failed load is every mount's error and the next run loads again", async () => {
  await renderAll(true);
  expect(calls.loads).toBe(0);
  const first = mount("graph LR");
  const second = mount("graph TD");
  stub.failLoad = true;
  await renderAll(true);
  expect(calls.loads).toBe(1);
  for (const element of [first, second]) {
    expect(shapes(element)[1]).toBe("p.fleet-mermaid-error:The diagram did not render: offline");
    expect(element.dataset.state).toBe("error");
  }
  expect(calls.renders).toEqual([]);
  stub.failLoad = false;
  await renderAll(true);
  await renderAll(false);
  expect(calls.loads).toBe(2);
  expect(shapes(first)).toEqual([
    "pre.fleet-mermaid-source:graph LR",
    'div.fleet-mermaid-diagram:<svg data-render="3">graph LR</svg>',
  ]);
  expect(shapes(second)).toEqual([
    "pre.fleet-mermaid-source:graph TD",
    'div.fleet-mermaid-diagram:<svg data-render="4">graph TD</svg>',
  ]);
  expect([first.dataset.state, second.dataset.state]).toEqual(["rendered", "rendered"]);
});

test("renders each mount in the mode's theme and hue, keeps a broken one's source with the error's first line", async () => {
  const good = mount("graph LR\n  A --> B");
  const bad = mount("graph LR\n  A -->");
  await renderAll(true);
  expect(shapes(good)).toEqual([
    "pre.fleet-mermaid-source:graph LR\n  A --> B",
    'div.fleet-mermaid-diagram:<svg data-render="1">graph LR\n  A --> B</svg>',
  ]);
  expect(good.dataset.state).toBe("rendered");
  expect(shapes(bad)).toEqual([
    "pre.fleet-mermaid-source:graph LR\n  A -->",
    "p.fleet-mermaid-error:The diagram did not render: Parse error on line 2:",
  ]);
  expect(bad.dataset.state).toBe("error");
  // One id per mount per run: the run's number, then the mount's index.
  expect(calls.renders.map((id) => id.replace(/^fleet-mermaid-\d+-/, ""))).toEqual(["0", "1"]);
  expect(new Set(calls.renders.map((id) => id.replace(/-\d+$/, ""))).size).toBe(1);
  expect(calls.initialize).toHaveLength(1);
  const config = calls.initialize[0];
  expect(config.securityLevel).toBe("strict");
  expect(config.suppressErrorRendering).toBe(true);
  expect(config.startOnLoad).toBe(false);
  expect(config.theme).toBe("base");
  const variables = config.themeVariables as { darkMode: boolean; nodeBorder: string };
  expect(variables.darkMode).toBe(true);
  expect(variables.nodeBorder).toBe(HUES[2].dark.hue);
});

test("a re-render replaces the diagram or the error in place under new ids, so the mount never stacks two", async () => {
  const good = mount("graph LR\n  A --> B");
  const bad = mount("graph LR\n  A -->");
  await renderAll(true);
  const firstIds = [...calls.renders];
  bad.children[0].textContent = "graph LR\n  A --> C";
  await renderAll(false);
  expect(darkModes()).toEqual([true, false]);
  expect(calls.renders.slice(2).filter((id) => firstIds.includes(id))).toEqual([]);
  expect(shapes(good)).toEqual([
    "pre.fleet-mermaid-source:graph LR\n  A --> B",
    'div.fleet-mermaid-diagram:<svg data-render="3">graph LR\n  A --> B</svg>',
  ]);
  expect(shapes(bad)).toEqual([
    "pre.fleet-mermaid-source:graph LR\n  A --> C",
    'div.fleet-mermaid-diagram:<svg data-render="4">graph LR\n  A --> C</svg>',
  ]);
  expect(bad.dataset.state).toBe("rendered");
  good.children[0].textContent = "graph LR\n  B -->";
  await renderAll(false);
  expect(shapes(good)).toEqual([
    "pre.fleet-mermaid-source:graph LR\n  B -->",
    "p.fleet-mermaid-error:The diagram did not render: Parse error on line 2:",
  ]);
  expect(good.dataset.state).toBe("error");
});

test("a run overtaken before it draws never initializes or renders; the newest mode lands alone", async () => {
  const element = mount("graph LR");
  const stale = renderAll(true);
  const fresh = renderAll(false);
  await Promise.all([stale, fresh]);
  expect(darkModes()).toEqual([false]);
  expect(calls.renders).toHaveLength(1);
  expect(shapes(element)).toEqual([
    "pre.fleet-mermaid-source:graph LR",
    'div.fleet-mermaid-diagram:<svg data-render="1">graph LR</svg>',
  ]);
});

test("a run overtaken mid-draw writes neither its late diagram nor its late error over the newer one", async () => {
  const element = mount("graph LR");
  stub.hold = true;
  const stale = renderAll(true);
  await heldRenders(1);
  const fresh = renderAll(false);
  await heldRenders(2);
  stub.held[1].resolve();
  await fresh;
  expect(shapes(element)).toEqual([
    "pre.fleet-mermaid-source:graph LR",
    'div.fleet-mermaid-diagram:<svg data-render="2">graph LR</svg>',
  ]);
  stub.held[0].resolve();
  await stale;
  expect(shapes(element)[1]).toBe('div.fleet-mermaid-diagram:<svg data-render="2">graph LR</svg>');
  const staleFailing = renderAll(true);
  await heldRenders(3);
  const newest = renderAll(false);
  await heldRenders(4);
  stub.held[3].resolve();
  await newest;
  stub.held[2].reject(new Error("late failure"));
  await staleFailing;
  expect(shapes(element)).toEqual([
    "pre.fleet-mermaid-source:graph LR",
    'div.fleet-mermaid-diagram:<svg data-render="4">graph LR</svg>',
  ]);
  expect(element.dataset.state).toBe("rendered");
  expect(darkModes()).toEqual([true, false, true, false]);
});
