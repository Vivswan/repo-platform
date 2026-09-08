// The fleet docs theme entry: vitepress-carbon as the base skin, with the
// theme-owned components mounted in its layout slots. README.md next to
// this file holds the replacement contract for each file.

import "@fontsource-variable/wix-madefor-text";
import "@fontsource-variable/wix-madefor-display";
import "@fontsource-variable/jetbrains-mono";
import { inBrowser, type Theme } from "vitepress";
import { VPCarbon } from "vitepress-carbon";
import { h } from "vue";
import type { ProjectFacts } from "../../facts.ts";
import "./custom.css";
import "./components.css";
import "./launcher.css";
import FactsPanel from "./facts-panel.ts";
import FleetLauncher from "./launcher.ts";
import NavLauncher from "./nav-launcher.ts";
import PageActionsFeedback from "./page-actions.ts";
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
      "layout-bottom": () => h(PageActionsFeedback),
    }),
  async enhanceApp(ctx) {
    await VPCarbon.enhanceApp?.(ctx);
    ctx.app.component("FleetLauncher", FleetLauncher);
    if (inBrowser) {
      // The built pages carry data-fleet-hue from config.mts's
      // transformHtml (so the hue is there before any script runs);
      // `vitepress dev` never runs that hook, so the dev server would
      // show the default hue without this.
      const facts: ProjectFacts | undefined = ctx.siteData.value.themeConfig.docsSiteFacts;
      const root = document.documentElement;
      if (facts && root.dataset.fleetHue === undefined) root.dataset.fleetHue = String(facts.hue);
      return;
    }
    // Vue's production SSR renderer catches a page's render error, logs
    // it, and emits the page with an EMPTY body (a literal `{{ x.y }}` in
    // markdown is compiled as an interpolation and blows up there), so
    // `vitepress build` stayed green while shipping blank pages. Only this
    // flag makes the render throw: a rethrowing app.config.errorHandler is
    // itself wrapped in callWithErrorHandling and logged the same way.
    ctx.app.config.throwUnhandledErrorInProduction = true;
  },
} satisfies Theme;
