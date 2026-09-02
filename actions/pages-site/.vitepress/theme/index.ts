// The fleet docs theme entry: vitepress-carbon as the base skin (GitHub's
// monochrome, token-based - the user's palette overrides its tokens in
// custom.css) with the version switcher mounted in the nav bar. The
// replacement contract for each file is in README.md next to this one.

import type { Theme } from "vitepress";
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
} satisfies Theme;
