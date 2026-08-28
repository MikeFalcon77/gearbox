// Where the two views live in the shell, and the commands that open them.

import { AbstractViewContribution, FrontendApplicationContribution } from "@theia/core/lib/browser";
import { injectable } from "@theia/core/shared/inversify";

import { CatalogueWidget } from "./catalogue/catalogue-widget";
import { GearDetailWidget } from "./detail/gear-detail-widget";
import { DepsGraphWidget } from "./graph/deps-graph-widget";

@injectable()
export class CatalogueViewContribution
  extends AbstractViewContribution<CatalogueWidget>
  implements FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: CatalogueWidget.ID,
      widgetName: CatalogueWidget.LABEL,
      defaultWidgetOptions: { area: "left", rank: 100 },
      toggleCommandId: "gearbox.catalogue.toggle",
    });
  }

  /**
   * Open the catalogue by default: it is the reason this application exists.
   *
   * `initializeLayout`, not `onStart`. Two reasons, and the first was a real bug:
   * `onStart` runs before the shell is attached, so the panel was opened and then
   * left collapsed by layout setup -- the widget stayed in the DOM, queryable and
   * invisible. And `initializeLayout` only runs when there is no saved layout, so
   * a person who closes the panel does not get it forced back open next time.
   */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: true, reveal: true });
  }
}

@injectable()
export class GraphViewContribution extends AbstractViewContribution<DepsGraphWidget> {
  constructor() {
    super({
      widgetId: DepsGraphWidget.ID,
      widgetName: DepsGraphWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.graph.deps.toggle",
    });
  }
}

@injectable()
export class DetailViewContribution
  extends AbstractViewContribution<GearDetailWidget>
  implements FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: GearDetailWidget.ID,
      widgetName: GearDetailWidget.LABEL,
      // The bottom area, so the tree, the graph and the detail are all readable
      // at once. In the side panel this content was clipped, which hid exactly
      // the projected facts it exists to show.
      defaultWidgetOptions: { area: "bottom" },
      toggleCommandId: "gearbox.detail.toggle",
    });
  }

  async initializeLayout(): Promise<void> {
    // Not activated: the catalogue keeps focus, because selecting a gear there
    // is the first thing anyone does.
    await this.openView({ activate: false, reveal: true });
  }
}
