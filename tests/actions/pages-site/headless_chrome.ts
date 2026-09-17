// Headless Chrome over its DevTools protocol, for the tests that judge the theme in a real layout over a built site.
// CHROME_BIN, else the platform's install; one browser socket with flat sessions, one Tab per scenario.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { harnessBound } from "../../shared/harness_bound.ts";

function chromePath(): string {
  const found = [
    process.env.CHROME_BIN,
    ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((name) =>
      Bun.which(name),
    ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((path): path is string => typeof path === "string" && path !== "" && existsSync(path));
  if (found === undefined) {
    throw new Error("no Chrome or Chromium found: set CHROME_BIN to the executable");
  }
  return found;
}

interface Message {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
}

type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export class Chrome {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<Listener>>();

  private constructor(
    private readonly process: Subprocess<"ignore", "ignore", "pipe">,
    private readonly socket: WebSocket,
  ) {
    socket.addEventListener("message", (event) => {
      const message: Message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method ?? "") ?? []) {
        listener(message.params ?? {}, message.sessionId);
      }
    });
  }

  static async launch(userDataDir: string): Promise<Chrome> {
    const process = Bun.spawn(
      [
        chromePath(),
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-gpu",
        "--hide-scrollbars",
        "--window-size=1400,1200",
        "about:blank",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    // Chrome is owned from the spawn on: a launch that fails past it must not leave it running.
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let text = "";
        const decoder = new TextDecoder();
        void (async () => {
          for await (const chunk of process.stderr) {
            text += decoder.decode(chunk, { stream: true });
            const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
            if (match !== null) resolve(match[1]);
          }
          reject(new Error(`chrome exited before announcing its DevTools socket:\n${text}`));
        })();
      });
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error(`no DevTools socket at ${url}`)));
      });
      return new Chrome(process, socket);
    } catch (error) {
      process.kill("SIGKILL");
      await process.exited;
      throw error;
    }
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  on(method: string, listener: Listener): void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
  }

  async close(): Promise<void> {
    void this.send("Browser.close").catch(() => undefined);
    const exited = await Promise.race([
      this.process.exited,
      Bun.sleep(harnessBound(5_000)).then(() => null),
    ]);
    if (exited === null) {
      this.process.kill("SIGKILL");
      await this.process.exited;
    }
    this.socket.close();
  }
}

/** A fresh tab; `onNewDocument` runs in the page before any of its own scripts. */
export class Tab {
  private constructor(
    private readonly chrome: Chrome,
    readonly sessionId: string,
    private readonly targetId: string,
  ) {}

  static async open(chrome: Chrome, onNewDocument?: string): Promise<Tab> {
    const { targetId } = (await chrome.send("Target.createTarget", { url: "about:blank" })) as {
      targetId: string;
    };
    const { sessionId } = (await chrome.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    const tab = new Tab(chrome, sessionId, targetId);
    await tab.send("Page.enable");
    if (onNewDocument !== undefined) {
      await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: onNewDocument });
    }
    return tab;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return this.chrome.send(method, params, this.sessionId);
  }

  navigate(url: string): Promise<Record<string, unknown>> {
    return this.send("Page.navigate", { url });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const { result, exceptionDetails } = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (exceptionDetails !== undefined) {
      throw new Error(
        `page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`,
      );
    }
    return result.value;
  }

  /** One key press as the browser sees it (a synthetic KeyboardEvent never reaches a dialog's cancel);
   *  `modifiers` is the protocol's bit set (1 Alt, 2 Ctrl, 4 Meta, 8 Shift). */
  async press(key: string, code: number, modifiers = 0): Promise<void> {
    for (const type of ["keyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        modifiers,
      });
    }
  }

  /** The role and name assistive technology receives for the first element `selector` matches. */
  async accessibleNode(selector: string): Promise<{ role: string; name: string }> {
    const { root } = (await this.send("DOM.getDocument", { depth: 0 })) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await this.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    })) as { nodeId: number };
    const { nodes } = (await this.send("Accessibility.getPartialAXTree", {
      nodeId,
      fetchRelatives: false,
    })) as { nodes: { role?: { value: string }; name?: { value: string } }[] };
    return { role: nodes[0]?.role?.value ?? "", name: nodes[0]?.name?.value ?? "" };
  }

  close(): Promise<Record<string, unknown>> {
    return this.chrome.send("Target.closeTarget", { targetId: this.targetId });
  }
}

/** The built site as Pages would serve it: the repository's base stripped, a directory to its index. */
export function serve(site: string, base: string): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      let file = join(site, path.startsWith(base) ? path.slice(base.length) : path);
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file));
    },
  });
}
