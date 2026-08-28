// Where the two views live in the shell, and the commands that open them.

import { AbstractViewContribution, FrontendApplicationContribution } from "@theia/core/lib/browser";
import { Command, CommandRegistry } from "@theia/core/lib/common";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueStore } from "./catalogue-store";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import { GearDetailWidget } from "./detail/gear-detail-widget";
import { DepsGraphWidget } from "./graph/deps-graph-widget";

export const RELOAD_CATALOGUE: Command = {
  id: "gearbox.catalogue.reload",
  label: "Gearbox: Reload Catalogue",
};

@injectable()
export class CatalogueViewContribution
  extends AbstractViewContribution<CatalogueWidget>
  implements FrontendApplicationContribution
{
  @inject(CatalogueStore) protected readonly store!: CatalogueStore;

  constructor() {
    super({
      widgetId: CatalogueWidget.ID,
      widgetName: CatalogueWidget.LABEL,
      defaultWidgetOptions: { area: "left", rank: 100 },
      toggleCommandId: "gearbox.catalogue.toggle",
    });
  }

  /**
   * Start the one load, here rather than in the widget.
   *
   * The widget is closable and transient, so a load in its `postConstruct` ran
   * again every time the panel was reopened -- including in the middle of a
   * projection, where the first load's pending set would land on top of the
   * second's already-projected rows. The application starts exactly one; the
   * reload command starts the rest.
   *
   * `onStart` and not `initializeLayout`: the latter is skipped entirely when
   * there is a saved layout, which would leave a returning user with a panel
   * that never loads.
   */
  onStart(): void {
    // `load()` does not reject -- a failure becomes the store's error state,
    // which the panel renders.
    void this.store.load();
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(RELOAD_CATALOGUE, {
      execute: () => this.store.load(),
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
