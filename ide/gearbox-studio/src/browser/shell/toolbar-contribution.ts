// Puts the toolbar in the shell's top area, beside the menu.
//
// Theia 1.75 already shows that panel in the browser target -- it is hidden
// only when `window.menuBarVisibility` is `compact` or `hidden`
// (`application-shell.js` `setTopPanelVisibility`). We have a menu, so the
// panel is visible, and the insertion is the same `addWidget(..., { area:
// "top" })` `BrowserMenuBarContribution.appendMenu` uses. No `hideTopPanel`
// override.

import {
  FrontendApplication,
  FrontendApplicationContribution,
} from "@theia/core/lib/browser";
import { inject, injectable } from "@theia/core/shared/inversify";

import { ToolbarWidget } from "./toolbar-widget";

@injectable()
export class ToolbarContribution implements FrontendApplicationContribution {
  @inject(ToolbarWidget) protected readonly toolbar!: ToolbarWidget;

  onStart(app: FrontendApplication): void {
    app.shell.addWidget(this.toolbar, { area: "top" });
  }
}
