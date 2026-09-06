// The fleet docs theme entry: vitepress-carbon as the base skin (GitHub's
// monochrome, token-based - the user's palette overrides its tokens in
// custom.css) with the version switcher mounted in the nav bar. The
// replacement contract for each file is in README.md next to this one.

import { inBrowser, type Theme } from "vitepress";
import { VPCarbon } from "vitepress-carbon";
import { h } from "vue";
import "./custom.css";
import VersionSwitcher from "./version-switcher.ts";

export default {
  ...VPCarbon,
  Layout: () =>
    h(VPCarbon.Layout!, null, {
      "nav-bar-content-after": () => h(VersionSwitcher),
    }),
  async enhanceApp(ctx) {
    await VPCarbon.enhanceApp?.(ctx);
    // Vue's production SSR renderer catches a page's render error, logs
    // it, and emits the page with an EMPTY body (a literal `{{ x.y }}` in
    // markdown is compiled as an interpolation and blows up there), so
    // `vitepress build` stayed green while shipping blank pages. Only this
    // flag makes the render throw: a rethrowing app.config.errorHandler is
    // itself wrapped in callWithErrorHandling and logged the same way.
    if (!inBrowser) ctx.app.config.throwUnhandledErrorInProduction = true;
  },
} satisfies Theme;
