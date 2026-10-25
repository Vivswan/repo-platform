// Headless Chrome through puppeteer-core, for the tests that judge the theme in a real layout over a built site.
// CHROME_BIN, else the platform's install: puppeteer-core drives the browser it is pointed at and downloads none.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
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

/** puppeteer's own deadlines (the launch, a protocol command, a page's waits) are harness bounds here like every
 *  other, so a loaded runner fails on the scenario's scaled bound and never on an unscaled one of puppeteer's. */
export function launchChrome(userDataDir: string): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chromePath(),
    userDataDir,
    headless: true,
    // The layout cases measure the reading column in the 1400px window, not puppeteer's 800x600 default viewport.
    defaultViewport: null,
    args: ["--disable-gpu", "--window-size=1400,1200"],
    // Chrome keeps scratch of its own (com.google.Chrome.*) under TMPDIR, and its URL fetcher's survives Browser.close;
    // pointed at the profile directory, it goes when the test removes that, never as a leftover the test launcher judges.
    env: { ...process.env, TMPDIR: userDataDir },
    timeout: harnessBound(30_000),
    protocolTimeout: harnessBound(180_000),
  });
}

export async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(harnessBound(30_000));
  return page;
}

/** Chrome gone within the bound: puppeteer's close waits for the exit a Chrome that acknowledged Browser.close may
 *  never make, and the profile directory is removed right after this. */
export async function closeChrome(browser: Browser): Promise<void> {
  const closed = browser.close();
  const exited = await Promise.race([
    closed.then(() => true),
    Bun.sleep(harnessBound(5_000)).then(() => false),
  ]);
  if (exited) return;
  browser.process()?.kill("SIGKILL");
  await closed;
}

/** A page-side expression's awaited value; the page scripts are strings, which puppeteer types as unknown. */
export function evaluate<T = unknown>(page: Page, expression: string): Promise<T> {
  return page.evaluate(expression) as Promise<T>;
}

/** The role and name assistive technology receives for the first element `selector` matches. */
export async function accessibleNode(
  page: Page,
  selector: string,
): Promise<{ role: string; name: string }> {
  const element = await page.$(selector);
  if (element === null) throw new Error(`no element matches ${selector}`);
  const node = await page.accessibility.snapshot({ root: element, interestingOnly: false });
  return { role: node?.role ?? "", name: node?.name ?? "" };
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
