// Registers the Constructor Fabric color theme and brands the shell.
//
// Tokens come from constructorfabric.org `styles.css` `:root` (navy / blue /
// Geist). The site is a marketing page; we map those tokens onto VS Code color
// keys rather than importing its layout CSS. Base token colors stay Dark+ so
// TextMate / `.gdl` highlighting keeps working.
//
// Favicon: `@theia/cli` 1.75 has no hook for one, so it is injected at runtime.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { inject, injectable } from "@theia/core/shared/inversify";
import { MonacoThemingService } from "@theia/monaco/lib/browser/monaco-theming-service";

import fabricTheme from "../../../src/browser/theme/fabric-theme.json";
// Bundled as a data URL by Theia's webpack (`svg` → dataurl).
import faviconUrl from "../../../src/browser/theme/favicon.svg";
import darkPlus = require("@theia/monaco/data/monaco-themes/vscode/dark_plus.json");
import darkVs = require("@theia/monaco/data/monaco-themes/vscode/dark_vs.json");

/** Preference / Color Theme picker id. Must match `browser-app` defaults. */
export const FABRIC_THEME_ID = "gearbox-fabric";
export const FABRIC_THEME_LABEL = "Gearbox (Fabric)";

/**
 * Hex → role (from constructorfabric/website styles.css):
 *
 * | Token        | Hex       | Role in the IDE                          |
 * |--------------|-----------|------------------------------------------|
 * | navy-deep    | #001838   | editor / panel / title bar background    |
 * | navy         | #00204D   | side bar / widgets                       |
 * | navy-700     | #0A2D63   | selection, borders, raised surfaces      |
 * | blue         | #2668C5   | secondary accent / button hover          |
 * | blue-bright  | #0065E3   | primary button / status bar / badges     |
 * | blue-sky     | #6BA5F0   | focus, links, active accents             |
 * | (navy text)  | #DCE6F4   | body foreground on navy                  |
 */
@injectable()
export class FabricThemeContribution implements FrontendApplicationContribution {
  @inject(MonacoThemingService)
  protected readonly monacoThemingService!: MonacoThemingService;

  initialize(): void {
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
