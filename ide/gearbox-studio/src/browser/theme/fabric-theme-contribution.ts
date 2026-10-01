// Registers the Constructor Fabric color themes and brands the shell.
//
// Tokens come from constructorfabric.org `styles.css` `:root` (navy / blue /
// Geist). The site is a marketing page; we map those tokens onto VS Code color
// keys rather than importing its layout CSS. Base token colors stay Dark+ /
// Light+ so TextMate / `.gdl` highlighting keeps working.
//
// **Two themes, one palette read two ways.** The light one is the default; the
// dark one stays registered and selectable. They are deliberately symmetric,
// key for key, so the pair can be diffed: navy is the background in one and the
// text in the other. What that symmetry buys is a stylesheet with no theme
// awareness at all -- `style/index.css` carries 199 `var(--theia-*)` references
// and no color literal, so every rule that needs a different value under a
// different background gets it from here rather than from a second CSS rule.
//
// Two places where that is load-bearing rather than tidy:
//   - `editorGutter.addedBackground` is what Theia derives `successBackground`
//     from, and the stylesheet uses it as a *text* color in five places. So the
//     light value is a dark green (#0E7C5A, 4.8:1 on the widget surface) rather
//     than the dark theme's mint, which would be ~1.6:1 on white.
//   - the stage-count badge writes `editor.background` over
//     `editorWarning.foreground`, so the light warning is a deep amber
//     (#8A5A00) that carries white at 5.9:1, not a pale one.
//
// Favicon: `@theia/cli` 1.75 has no hook for one, so it is injected at runtime.
// One asset for both themes -- it is a mark, not a palette.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { inject, injectable } from "@theia/core/shared/inversify";
import { MonacoThemingService } from "@theia/monaco/lib/browser/monaco-theming-service";

import fabricTheme from "../../../src/browser/theme/fabric-theme.json";
import fabricLightTheme from "../../../src/browser/theme/fabric-light-theme.json";
// Bundled as a data URL by Theia's webpack (`svg` → dataurl).
import faviconUrl from "../../../src/browser/theme/favicon.svg";
import darkPlus = require("@theia/monaco/data/monaco-themes/vscode/dark_plus.json");
import darkVs = require("@theia/monaco/data/monaco-themes/vscode/dark_vs.json");
import lightPlus = require("@theia/monaco/data/monaco-themes/vscode/light_plus.json");
import lightVs = require("@theia/monaco/data/monaco-themes/vscode/light_vs.json");

/** Preference / Color Theme picker ids. Must match `browser-app` defaults. */
export const FABRIC_THEME_ID = "gearbox-fabric";
export const FABRIC_THEME_LABEL = "Gearbox (Fabric)";
export const FABRIC_LIGHT_THEME_ID = "gearbox-fabric-light";
export const FABRIC_LIGHT_THEME_LABEL = "Gearbox (Fabric Light)";

/**
 * Hex → role (from constructorfabric/website styles.css):
 *
 * | Token       | Hex     | Dark: role                | Light: role          |
 * |-------------|---------|---------------------------|----------------------|
 * | navy-deep   | #001838 | editor / panel / titlebar | body text            |
 * | navy        | #00204D | side bar / widgets        | link pressed         |
 * | navy-700    | #0A2D63 | selection, borders        | scrollbar slider     |
 * | blue        | #2668C5 | secondary accent / hover  | icons / button hover |
 * | blue-bright | #0065E3 | primary button / badges   | same, plus focus     |
 * | blue-sky    | #6BA5F0 | focus, links, accents     | decoration only (*)  |
 * | (navy text) | #DCE6F4 | body foreground on navy   | selection / raised   |
 *
 * (*) #6BA5F0 is 2.5:1 on white, so under the light theme it carries no text
 * and no focus ring; #0065E3 takes those roles at 5.3:1.
 *
 * Light-only surfaces, which the brand has no token for because the site is
 * dark: #FFFFFF editor, #F2F6FC widgets / side bar, #E8EFF9 title bar / tabs,
 * #C3D0E3 borders. All picked in #DCE6F4's hue family so the greys stay cool.
 */
@injectable()
export class FabricThemeContribution implements FrontendApplicationContribution {
  @inject(MonacoThemingService)
  protected readonly monacoThemingService!: MonacoThemingService;

  initialize(): void {
    // `uiTheme` is the only thing that makes a theme light or dark to Theia:
    // `monaco-indexed-db` maps `vs` → `light` and `vs-dark` → `dark`, and that
    // type is what lands on `document.body` as a class and what the color
    // registry uses to pick each unspecified token's default. Which is why the
    // light JSON can be short: everything it does not name arrives light.
    this.monacoThemingService.registerParsedTheme({
      id: FABRIC_LIGHT_THEME_ID,
      label: FABRIC_LIGHT_THEME_LABEL,
      description: "Constructor Fabric brand theme for Gearbox Studio, light",
      uiTheme: "vs",
      json: fabricLightTheme,
      includes: {
        "./light_plus.json": lightPlus,
        "./light_vs.json": lightVs,
      },
    });

    this.monacoThemingService.registerParsedTheme({
      id: FABRIC_THEME_ID,
      label: FABRIC_THEME_LABEL,
      description: "Constructor Fabric brand theme for Gearbox Studio",
      uiTheme: "vs-dark",
      json: fabricTheme,
      includes: {
        "./dark_plus.json": darkPlus,
        "./dark_vs.json": darkVs,
      },
    });
  }

  onStart(): void {
    this.installFavicon();
  }

  protected installFavicon(): void {
    const existing = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    const link = existing ?? document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";
    link.href = typeof faviconUrl === "string" ? faviconUrl : String(faviconUrl);
    if (!existing) {
      document.head.appendChild(link);
    }
  }
}
