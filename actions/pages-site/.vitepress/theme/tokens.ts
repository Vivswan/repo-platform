// scripts/generate/theme_tokens.ts renders this file into tokens.css, which sets carbon's --vp-* values (the authoritative
// list is packages/theme/src/theme/styles/vars.css in github.com/brenoepics/vitepress-carbon) and adds the fleet's own
// --fleet-* tokens. The one accent is the repository's hue (config.mts sets <html data-fleet-hue="0..5"> at build time),
// and HUES below is the only place a hue value is written.
//   dark   -> the default: carbon's baseConfig sets the initial appearance
//   light  -> a full variant with the same grounds lifted
//   print  -> overrides only the subset that must be ink on paper

export type TokenName = `--${string}`;

/** `print` is set only for the tokens that carry color onto paper; the rest keep the screen value. */
export interface ModeValues {
  light: string;
  dark: string;
  print?: string;
}

export type Mode = keyof ModeValues;
export type ScreenMode = Exclude<Mode, "print">;
export const MODES: readonly Mode[] = ["light", "dark", "print"];

/** Overrides are applied in source order after the base, each inside its own media query. */
export type SharedValue = string | { base: string; overrides: readonly MediaOverride[] };

export interface MediaOverride {
  media: string;
  value: string;
}

/** Written on :root AND .dark: carbon's own .dark block sets several of them (brand-1, brand-2) directly, and the
 *  .dark declaration is what outranks it. */
export const SHARED_TOKENS = {
  fonts: {
    "--vp-font-family-base": '"Wix Madefor Text Variable", "Segoe UI", system-ui, sans-serif',
    "--vp-font-family-mono": '"JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace',
    "--fleet-font-display": '"Wix Madefor Display Variable", var(--vp-font-family-base)',
  },
  radii: {
    "--fleet-radius-lg": "12px",
    "--fleet-radius-md": "8px",
    "--fleet-radius-sm": "5px",
  },
  motion: {
    "--fleet-transition": "180ms cubic-bezier(0.2, 0, 0, 1)",
  },
  measure: {
    "--fleet-measure": "68ch",
  },
  layout: {
    "--vp-nav-height": "60px",
    // Below carbon's aside breakpoint the sidebar shares the width with the
    // article alone, and a 320px column would leave a 768px viewport a 37ch
    // article; the doc column keeps 70ch from 1440px up either way.
    "--vp-sidebar-width": {
      base: "320px",
      overrides: [{ media: "(min-width: 768px) and (max-width: 1279px)", value: "280px" }],
    },
    "--vp-doc-content-max-width": "760px",
    "--vp-doc-aside-width": "240px",
    "--vp-layout-max-width": "1440px",
    // The margin each side of the 1440px frame on a wider viewport. Carbon
    // offsets only the article by it (VPContent); the component rules offset
    // the sidebar, the nav's title and controls, and the search field by the
    // same value so the whole page reads as one centered frame. 100vw, not
    // 100%, because that is what carbon's article formula uses.
    "--fleet-gutter": {
      base: "0px",
      overrides: [
        { media: "(min-width: 1440px)", value: "calc((100vw - var(--vp-layout-max-width)) / 2)" },
      ],
    },
  },
  // Functional tokens that read the hue and the grounds, so they hold in
  // both modes and every hue.
  brand: {
    "--vp-c-brand-1": "var(--fleet-hue)",
    "--vp-c-brand-2": "var(--fleet-hue)",
    "--vp-c-brand-3": "var(--fleet-hue)",
    "--vp-c-brand-soft": "var(--fleet-hue-band)",
    "--vp-c-default-soft": "var(--vp-c-bg-soft-2)",
    "--vp-c-warning-soft": "var(--vp-c-bg-soft-2)",
    "--vp-c-danger-1": "var(--vp-c-text-1)",
    "--vp-c-danger-soft": "var(--vp-c-bg-soft-2)",
    "--vp-c-success-1": "var(--vp-c-text-1)",
    "--vp-c-success-soft": "var(--vp-c-bg-soft-2)",
  },
  // One color per custom-block kind, on carbon's GitHub names (its
  // custom-block.css reads them for the rule and title; the theme's block
  // rules read them for the kinds carbon has no rule for); warning and
  // caution are per mode in MODE_TOKENS.alerts.
  customBlocks: {
    "--color-note": "var(--fleet-hue)",
    "--color-tip": "var(--fleet-hue)",
    "--color-important": "var(--fleet-hue)",
    "--color-info": "var(--fleet-hue)",
    "--color-details": "var(--fleet-hue)",
  },
  code: {
    "--vp-code-font-size": "15px",
    "--vp-code-line-height": "1.65",
    "--vp-code-color": "var(--vp-c-text-1)",
    "--vp-code-link-color": "var(--fleet-hue)",
    "--vp-code-link-hover-color": "var(--fleet-hue)",
    "--vp-code-bg": "var(--vp-c-bg-code)",
    "--vp-code-block-color": "var(--vp-c-text-1)",
    "--vp-code-block-bg": "var(--vp-c-bg-code)",
    "--vp-code-block-divider-color": "var(--vp-c-divider)",
    "--vp-code-lang-color": "var(--vp-c-text-3)",
    "--vp-code-line-highlight-color": "var(--fleet-hue-band)",
    "--vp-code-line-number-color": "var(--vp-c-text-3)",
    "--vp-code-copy-code-border-color": "var(--vp-c-border)",
    "--vp-code-copy-code-bg": "var(--vp-c-bg-soft)",
    "--vp-code-copy-code-hover-border-color": "var(--fleet-hue)",
    "--vp-code-copy-code-hover-bg": "var(--vp-c-bg-soft-2)",
    "--vp-code-copy-code-active-text": "var(--vp-c-text-1)",
    "--vp-code-tab-active-bar-color": "var(--fleet-hue)",
  },
  buttons: {
    "--vp-button-brand-border": "transparent",
    "--vp-button-brand-text": "var(--vp-c-bg)",
    "--vp-button-brand-bg": "var(--fleet-hue)",
    "--vp-button-brand-hover-border": "transparent",
    "--vp-button-brand-hover-text": "var(--vp-c-bg)",
    "--vp-button-brand-hover-bg": "var(--fleet-hue)",
    "--vp-button-brand-active-border": "transparent",
    "--vp-button-brand-active-text": "var(--vp-c-bg)",
    "--vp-button-brand-active-bg": "var(--fleet-hue)",
    "--vp-button-alt-border": "var(--vp-c-border)",
    "--vp-button-alt-text": "var(--vp-c-text-1)",
    "--vp-button-alt-bg": "var(--vp-c-bg-soft)",
    "--vp-button-alt-hover-border": "var(--fleet-hue)",
    "--vp-button-alt-hover-text": "var(--vp-c-text-1)",
    "--vp-button-alt-hover-bg": "var(--vp-c-bg-soft)",
    "--vp-button-alt-active-border": "var(--fleet-hue)",
    "--vp-button-alt-active-text": "var(--vp-c-text-1)",
    "--vp-button-alt-active-bg": "var(--vp-c-bg-soft-2)",
    "--mktg-accent-primary": "var(--fleet-hue)",
  },
  surfaces: {
    "--vp-badge-tip-text": "var(--fleet-hue)",
    "--vp-badge-tip-bg": "var(--fleet-hue-band)",
    "--vp-badge-warning-text": "var(--vp-c-text-1)",
    "--vp-badge-warning-bg": "var(--vp-c-bg-soft-2)",
    "--vp-badge-danger-text": "var(--vp-c-text-1)",
    "--vp-badge-danger-bg": "var(--vp-c-bg-soft-2)",
    "--vp-nav-screen-bg-color": "var(--vp-c-bg)",
    "--vp-local-nav-bg-color": "var(--vp-c-bg)",
    "--vp-backdrop-bg-color": "rgba(0, 0, 0, 0.45)",
    "--vp-home-hero-name-color": "var(--fleet-hue)",
    "--vp-home-card-border-hover-color": "var(--fleet-hue)",
    "--vp-home-card-icon-bg": "var(--fleet-hue-band)",
    "--vp-home-card-icon-color": "var(--fleet-hue)",
    "--vp-local-search-bg": "var(--vp-c-bg-soft)",
    "--vp-local-search-result-bg": "var(--vp-c-bg-soft)",
    "--vp-local-search-result-border": "var(--vp-c-border)",
    "--vp-local-search-result-selected-bg": "var(--fleet-hue-band)",
    "--vp-local-search-result-selected-border": "var(--fleet-hue)",
    "--vp-local-search-highlight-bg": "transparent",
    "--vp-local-search-highlight-text": "var(--fleet-hue)",
  },
} as const satisfies Record<string, Record<TokenName, SharedValue>>;

export const HUE_TOKENS = {
  hue: "--fleet-hue",
  band: "--fleet-hue-band",
  soft: "--fleet-hue-soft",
} as const satisfies Record<string, TokenName>;

export type HueValues = Record<keyof typeof HUE_TOKENS, string>;

export interface Hue extends Record<ScreenMode, HueValues> {
  name: string;
  /** The deep variant, ink on paper grounds. */
  light: HueValues;
  /** The light variant, chalk on night grounds. */
  dark: HueValues;
}

/** The hue set by slot: `data-fleet-hue="N"` is HUES[N]; slot 0 is the
 *  default, written into the mode blocks themselves. */
export const HUES: readonly Hue[] = [
  {
    name: "amber",
    light: { hue: "#8a5a0a", band: "rgba(138, 90, 10, 0.11)", soft: "rgba(138, 90, 10, 0.28)" },
    dark: { hue: "#d9a866", band: "rgba(217, 168, 102, 0.15)", soft: "rgba(217, 168, 102, 0.32)" },
  },
  {
    name: "sky",
    light: { hue: "#1f5f9e", band: "rgba(31, 95, 158, 0.11)", soft: "rgba(31, 95, 158, 0.28)" },
    dark: { hue: "#7fb2e5", band: "rgba(127, 178, 229, 0.16)", soft: "rgba(127, 178, 229, 0.34)" },
  },
  {
    name: "sage",
    light: { hue: "#2f6b3a", band: "rgba(47, 107, 58, 0.11)", soft: "rgba(47, 107, 58, 0.28)" },
    dark: { hue: "#8fbf8a", band: "rgba(143, 191, 138, 0.16)", soft: "rgba(143, 191, 138, 0.34)" },
  },
  {
    name: "rose",
    light: { hue: "#a3384f", band: "rgba(163, 56, 79, 0.11)", soft: "rgba(163, 56, 79, 0.28)" },
    dark: { hue: "#e08c9a", band: "rgba(224, 140, 154, 0.16)", soft: "rgba(224, 140, 154, 0.34)" },
  },
  {
    name: "violet",
    light: { hue: "#5e46a3", band: "rgba(94, 70, 163, 0.11)", soft: "rgba(94, 70, 163, 0.28)" },
    dark: { hue: "#b39ddb", band: "rgba(179, 157, 219, 0.16)", soft: "rgba(179, 157, 219, 0.34)" },
  },
  {
    name: "teal",
    light: { hue: "#1b6b67", band: "rgba(27, 107, 103, 0.11)", soft: "rgba(27, 107, 103, 0.28)" },
    dark: { hue: "#6fc2bd", band: "rgba(111, 194, 189, 0.16)", soft: "rgba(111, 194, 189, 0.34)" },
  },
];

/** On paper every hue is the ink: a dark-mode hue printed from a dark
 *  screen would sit at 2:1 on white. */
export const PRINT_HUE: HueValues = {
  hue: "#1c1f26",
  band: "rgba(20, 24, 32, 0.1)",
  soft: "rgba(20, 24, 32, 0.28)",
};

export const MODE_TOKENS = {
  grounds: {
    "--vp-c-bg": { light: "#f3f4f6", dark: "#16181d", print: "#ffffff" },
    "--vp-c-bg-alt": { light: "#f3f4f6", dark: "#16181d", print: "#ffffff" },
    "--vp-c-bg-dark": { light: "#f3f4f6", dark: "#16181d" },
    "--vp-c-bg-elv": { light: "#ffffff", dark: "#1e2128", print: "#ffffff" },
    "--vp-c-bg-soft": { light: "#ffffff", dark: "#1e2128", print: "#ffffff" },
    "--vp-c-bg-soft-2": { light: "#eaecf0", dark: "#262a32", print: "#f3f4f6" },
    "--vp-c-bg-code": { light: "#eaecf0", dark: "#23262e", print: "#f3f4f6" },
    "--fleet-field-bg": { light: "#ffffff", dark: "#1b1e24" },
  },
  // Content scrollers (tables, code): the thumb, the edge shade that says
  // "more this way" (the thumb's own tint, so it reads as one system) and
  // the thumb at 3:1 on the code ground.
  scrollers: {
    "--fleet-scroll": { light: "rgba(20, 24, 32, 0.18)", dark: "rgba(255, 255, 255, 0.14)" },
    "--fleet-scroll-shade": { light: "rgba(20, 24, 32, 0.22)", dark: "rgba(255, 255, 255, 0.22)" },
    "--fleet-scroll-strong": { light: "rgba(20, 24, 32, 0.5)", dark: "rgba(255, 255, 255, 0.36)" },
  },
  dividers: {
    "--vp-c-divider": {
      light: "rgba(20, 24, 32, 0.1)",
      dark: "rgba(255, 255, 255, 0.09)",
      print: "rgba(20, 24, 32, 0.2)",
    },
    "--vp-c-border": {
      light: "rgba(20, 24, 32, 0.18)",
      dark: "rgba(255, 255, 255, 0.16)",
      print: "rgba(20, 24, 32, 0.3)",
    },
    "--vp-c-gutter": { light: "rgba(20, 24, 32, 0.1)", dark: "rgba(255, 255, 255, 0.09)" },
  },
  // text-3 is small type on every ground down to bg-code: it must clear
  // 4.5:1 there (tests/actions/pages-site/theme_contrast.test.ts).
  text: {
    "--vp-c-text-1": { light: "#1c1f26", dark: "#e7e9ee", print: "#000000" },
    "--vp-c-text-2": { light: "#585f6c", dark: "#a5acb8", print: "#333840" },
    "--vp-c-text-3": { light: "#626a78", dark: "#8c94a6", print: "#4a505c" },
    "--vp-c-text-dark": { light: "#1c1f26", dark: "#e7e9ee" },
    "--vp-color-fg-default": { light: "#1c1f26", dark: "#e7e9ee" },
    "--vp-color-fg-muted": { light: "#585f6c", dark: "#a5acb8" },
    "--vp-color-fg-subtle": { light: "#626a78", dark: "#8c94a6" },
  },
  actionList: {
    "--color-action-list-item-default-hover-bg": {
      light: "rgba(20, 24, 32, 0.06)",
      dark: "rgba(255, 255, 255, 0.06)",
    },
    "--color-action-list-item-default-active-bg": {
      light: "rgba(20, 24, 32, 0.1)",
      dark: "rgba(255, 255, 255, 0.1)",
    },
    "--color-action-list-item-default-selected-bg": {
      light: "rgba(20, 24, 32, 0.04)",
      dark: "rgba(255, 255, 255, 0.04)",
    },
    "--color-action-list-item-default-active-border": { light: "transparent", dark: "transparent" },
  },
  shadows: {
    "--vp-shadow-1": {
      light: "0 1px 2px rgba(20, 24, 32, 0.06), 0 1px 3px rgba(20, 24, 32, 0.08)",
      dark: "0 1px 2px rgba(0, 0, 0, 0.35), 0 1px 3px rgba(0, 0, 0, 0.3)",
    },
    "--vp-shadow-3": {
      light: "0 12px 32px rgba(20, 24, 32, 0.1), 0 2px 6px rgba(20, 24, 32, 0.06)",
      dark: "0 12px 32px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.3)",
    },
    "--vp-shadow-4": {
      light: "0 24px 60px rgba(20, 24, 32, 0.12), 0 2px 8px rgba(20, 24, 32, 0.06)",
      dark: "0 24px 60px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3)",
    },
  },
  // The two alert kinds that are not the hue (carbon's GitHub alert values,
  // 4.5:1 on the panel ground bg-soft); the hue kinds are SHARED_TOKENS.customBlocks.
  alerts: {
    "--color-warning": { light: "#9a6700", dark: "#d29922", print: "#9a6700" },
    "--color-caution": { light: "#d1242f", dark: "#f85149", print: "#d1242f" },
  },
  // The code palette: config.mts builds shiki's theme from these names, so
  // no highlighter hex is baked into a page; every value clears 4.5:1 on
  // bg-code.
  code: {
    "--fleet-code-foreground": { light: "#1c1f26", dark: "#e7e9ee", print: "#000000" },
    "--fleet-code-token-comment": { light: "#5f6673", dark: "#8c94a6", print: "#4a505c" },
    "--fleet-code-token-string": { light: "#0b4a8b", dark: "#9ecbff", print: "#0b4a8b" },
    "--fleet-code-token-string-expression": { light: "#0b4a8b", dark: "#9ecbff", print: "#0b4a8b" },
    "--fleet-code-token-constant": { light: "#005cc5", dark: "#79b8ff", print: "#005cc5" },
    "--fleet-code-token-keyword": { light: "#b8232f", dark: "#f97583", print: "#b8232f" },
    "--fleet-code-token-function": { light: "#6639b6", dark: "#b392f0", print: "#6639b6" },
    "--fleet-code-token-parameter": { light: "#1c1f26", dark: "#e7e9ee", print: "#000000" },
    "--fleet-code-token-punctuation": { light: "#585f6c", dark: "#a5acb8", print: "#333840" },
    "--fleet-code-token-link": { light: "#0b4a8b", dark: "#9ecbff", print: "#0b4a8b" },
    "--fleet-code-token-inserted": { light: "#1a6b2f", dark: "#85e89d", print: "#1a6b2f" },
    "--fleet-code-token-deleted": { light: "#b8232f", dark: "#f97583", print: "#b8232f" },
    "--fleet-code-token-changed": { light: "#7a4f00", dark: "#ffab70", print: "#7a4f00" },
  },
} as const satisfies Record<string, Record<TokenName, ModeValues>>;

export function tokenNames(): TokenName[] {
  return [
    ...Object.values(SHARED_TOKENS).flatMap((group) => Object.keys(group) as TokenName[]),
    ...Object.values(HUE_TOKENS),
    ...Object.values(MODE_TOKENS).flatMap((group) => Object.keys(group) as TokenName[]),
  ];
}

/** Light and dark carry the whole palette with hue slot 0; print carries the overrides alone and PRINT_HUE, the way
 *  the print sheet declares them. */
export function modeValues(mode: Mode): Map<TokenName, string> {
  const values = new Map<TokenName, string>();
  for (const group of Object.values(MODE_TOKENS)) {
    for (const [name, perMode] of Object.entries(group) as [TokenName, ModeValues][]) {
      const value = perMode[mode];
      if (value !== undefined) values.set(name, value);
    }
  }
  const hue = mode === "print" ? PRINT_HUE : HUES[0][mode];
  for (const [key, name] of Object.entries(HUE_TOKENS) as [keyof HueValues, TokenName][]) {
    values.set(name, hue[key]);
  }
  return values;
}
