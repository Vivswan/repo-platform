// The fleet docs theme entry: vitepress-carbon as the base skin, with the
// theme-owned components mounted in its layout slots. README.md next to
// this file holds the replacement contract for each file.

import "@fontsource-variable/wix-madefor-text";
import "@fontsource-variable/wix-madefor-display";
import "@fontsource-variable/jetbrains-mono";
import { inBrowser, type Theme } from "vitepress";
import { VPCarbon } from "vitepress-carbon";
import { h } from "vue";
import "./custom.css";
import "./components.css";
import "./launcher.css";
import FactsPanel from "./facts-panel.ts";
import FleetLauncher from "./launcher.ts";
import NavLauncher from "./nav-launcher.ts";
import Provenance from "./provenance.ts";
import VersionSwitcher from "./version-switcher.ts";

export default {
  ...VPCarbon,
  Layout: () =>
    h(VPCarbon.Layout!, null, {
      "nav-bar-content-before": () => h(NavLauncher),
      "nav-bar-content-menu-after": () => h(VersionSwitcher),
      "aside-top": () => h(FactsPanel),
      "doc-after": () => h(Provenance),
    }),
  async enhanceApp(ctx) {
    await VPCarbon.enhanceApp?.(ctx);
    ctx.app.component("FleetLauncher", FleetLauncher);
    // Vue's production SSR renderer catches a page's render error, logs
    // it, and emits the page with an EMPTY body (a literal `{{ x.y }}` in
    // markdown is compiled as an interpolation and blows up there), so
    // `vitepress build` stayed green while shipping blank pages. Only this
    // flag makes the render throw: a rethrowing app.config.errorHandler is
    // itself wrapped in callWithErrorHandling and logged the same way.
    if (!inBrowser) ctx.app.config.throwUnhandledErrorInProduction = true;
  },
} satisfies Theme;
