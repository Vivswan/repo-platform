# The fleet docs theme

This directory is the ONE home of the fleet's docs-site look: every managed repository's docs site builds with these files, and none of them exists in any fleet repository (fleet repos carry only markdown). Changes here ship on the next `build` branch publish, and every site picks them up on its next deploy (each site's nightly rebuild makes that automatic - no per-repo work).

The base skin is [vitepress-carbon](https://github.com/brenoepics/vitepress-carbon) (GitHub-monochrome, token-based), pinned exact in `../../package.json` next to the exact `vitepress` pin - both bumped only by deliberate commits here, never by a floating range.

## The customization contract

| File | What it controls | Changing it |
|---|---|---|
| `custom.css` | The fleet's visual identity as CARBON TOKEN OVERRIDES | This is the primary drop-in point: carbon's design system is `--vp-*` custom properties (the authoritative token list is `packages/theme/src/theme/styles/vars.css` in carbon's repo), so a full restyle is a set of variable values here - no component work. |
| `index.ts` | The theme entry: carbon as base, which components mount where | Keep exporting a VitePress `Theme`. If you change the `Layout`, keep mounting `VersionSwitcher` in a nav slot (carbon forwards all default-theme slots, `nav-bar-content-after` included) - the version dropdown is theme-owned; nothing else renders it. |
| `version-switcher.ts` | The version dropdown | Restyle or replace freely, but keep reading `themeConfig.docsSiteVersions` and `docsSiteCurrent` - that is the build-time contract with the pages-site action, and versioned sites lose version navigation without it. |
| `../config.mts` | Site structure: carbon's `baseConfig`, title/base/srcDir wiring (env-driven, leave intact), sidebar and rewrites (from `derive.ts`), locales, search, editLink, the llms.txt plugin | Adjust `themeConfig` freely; the `DOCS_SITE_*` env contract at the top of the file belongs to the action and must keep working. |
| `../derive.ts` | Sidebar, route, and locale derivation from the docs tree | Change the derivation rules here to change every site's navigation shape. |

## The VitePress 2 path (deferred deliberately)

`vitepress` stays on the 1.6 line because carbon tracks it (carbon@1.6.0 declares no VitePress 2 compatibility). When VitePress 2 goes stable, either carbon has ported (bump both pins together) or the move is a token port: reimplement carbon's `vars.css` values over VitePress's default theme in this directory - the file layout and the contract table above are built so that swap stays local to this directory plus `../config.mts`'s `extends`/theme imports.

## Content rules

- Fleet docs are plain `.md` only - no MDX and no per-repo Vue components. Rich widgets are added HERE, as theme-provided [markdown containers](https://vitepress.dev/guide/markdown#custom-containers) or globally registered components, so every repository gets them for free.
- Translations follow one convention: `docs/<lang>[-<region>]/` (a two-letter ISO 639-1 code, e.g. `zh-cn/`, `ja/`) mirroring the root structure. Detected directories become VitePress locales with the language switcher in the nav (carbon ships the translations menu); the root tree is the default (English) locale. The detection rule lives in `../derive.ts`.
- The dropdown navigates to a version's ROOT, not the same page in the other version - page sets differ across versions, so deep cross-version links are not guaranteed to exist.
