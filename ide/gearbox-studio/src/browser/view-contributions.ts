// Where the two views live in the shell, and the commands that open them.

import { AbstractViewContribution, FrontendApplicationContribution } from "@theia/core/lib/browser";
import {
  ConnectionStatus,
  ConnectionStatusService,
} from "@theia/core/lib/browser/connection-status-service";
import { Command, CommandRegistry, MenuModelRegistry } from "@theia/core/lib/common";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueStore } from "./catalogue-store";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import { GearDetailWidget } from "./detail/gear-detail-widget";
import { GraphWidget } from "./graph/graph-widget";
import { ExplainWidget } from "./explain/explain-widget";
import { GenerateWidget } from "./generate/generate-widget";
import { LockWidget } from "./lock/lock-widget";
import { GearboxMenus } from "./menus";
import { ProductStore } from "./product-store";
import { ProductWidget } from "./product/product-widget";

export const RELOAD_CATALOGUE: Command = {
  id: "gearbox.catalogue.reload",
  label: "Gearbox: Reload Catalogue",
};

export const RESOLVE_PRODUCT: Command = {
  id: "gearbox.product.resolve",
  label: "Gearbox: Resolve Product",
};

@injectable()
export class CatalogueViewContribution
  extends AbstractViewContribution<CatalogueWidget>
  implements FrontendApplicationContribution
{
  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(ConnectionStatusService)
  protected readonly connection!: ConnectionStatusService;
  // Reached from here because the reconnect edge is one event and both stores
  // went stale on it. The alternative -- a second contribution listening to the
  // same event -- would also have to know to run after this one, since it is
  // `CatalogueStore.load()` that calls `initialize` and so respawns the engine
  // a product resolve needs.
  @inject(ProductStore) protected readonly products!: ProductStore;

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
    this.reloadOnReconnect();
  }

  /**
   * Load again after the backend connection comes back.
   *
   * Not a nicety. `frontendConnectionTimeout` is `0`, so a closed socket
   * disposes the backend contribution at once, and
   * `gearbox-studio-backend-module.ts` disposes the service -- and its engine --
   * with it. The frontend, meanwhile, reconnects in place: same page, same
   * stores, same rendered tree, now backed by a fresh `GearboxServiceImpl` that
   * has never seen `initialize`. Nothing called `initialize` a second time,
   * because the only caller is `onStart` and the application already started.
   * The result was a panel showing a complete catalogue where every action
   * answered "the engine is not running", until someone thought to hit Reload.
   *
   * Reloading rather than raising the timeout or setting `reloadOnReconnect`:
   * both of those are decisions about the whole application -- a longer timeout
   * keeps every backend contribution alive for a window that may never return,
   * and `reloadOnReconnect` throws away editor state to fix a catalogue. The
   * thing that actually went stale is this store, and it knows how to refill
   * itself.
   */
  protected reloadOnReconnect(): void {
    let offline = this.connection.currentStatus === ConnectionStatus.OFFLINE;
    this.connection.onStatusChange((status) => {
      if (status === ConnectionStatus.OFFLINE) {
        offline = true;
        return;
      }
      // Only the offline-to-online edge. `onStatusChange` also fires for
      // ONLINE-to-ONLINE on some paths, and a load per ping is not a load.
      if (offline) {
        offline = false;
        void this.store.load().then(() => {
          // Only if a product was open. Discovering one here would open a panel
          // nobody asked for, on the strength of a dropped websocket.
          if (this.products.current.open !== undefined) {
            void this.products.reload();
          }
        });
      }
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(RELOAD_CATALOGUE, {
      execute: () => this.store.load(),
    });
  }

  /**
   * Put the catalogue commands under Gearbox.
   *
   * `menus.ts` has declared the submenu since the shell was narrowed, and until
   * now nothing registered into it -- so the menu bar carried a "Gearbox" label
   * with an empty dropdown. Theia 1.75 renders an empty submenu, so that was
   * visible rather than merely latent.
   */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_INSPECT, {
      commandId: this.toggleCommand?.id ?? "",
      label: "Catalogue",
      order: "1",
    });
    menus.registerMenuAction(GearboxMenus.GEARBOX_INSPECT, {
      commandId: RELOAD_CATALOGUE.id,
      label: "Reload Catalogue",
      order: "2",
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
export class GraphViewContribution extends AbstractViewContribution<GraphWidget> {
  constructor() {
    super({
      widgetId: GraphWidget.ID,
      widgetName: GraphWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.graph.toggle",
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

/**
 * Deliberately *not* a `FrontendApplicationContribution`.
 *
 * The other two views implement it to open themselves in `initializeLayout`.
 * This one opens on request, so it has no member of that interface to implement
 * -- and since every member is optional, claiming it would be a declaration
 * TypeScript rejects for having nothing in common with the type.
 */
@injectable()
export class ProductViewContribution extends AbstractViewContribution<ProductWidget> {
  @inject(ProductStore) protected readonly store!: ProductStore;

  constructor() {
    super({
      widgetId: ProductWidget.ID,
      widgetName: ProductWidget.LABEL,
      // The main area: a product is an object of work in its own right, not a
      // detail of the catalogue. ADR 0011 puts it in a second perspective, and
      // until the perspective switch exists this is the honest placement -- it
      // opens on request rather than on startup, so it does not compete with the
      // catalogue for the first thing a person sees.
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.product.toggle",
    });
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands);
    commands.registerCommand(RESOLVE_PRODUCT, {
      // Re-resolves whatever is open for whatever profile is selected, which is
      // what "resolve" means once a product is on screen. Opening one is the
      // toggle command's job.
      execute: () => this.store.reload(),
      isEnabled: () => this.store.current.open !== undefined,
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: this.toggleCommand?.id ?? "",
      label: "Product",
      order: "1",
    });
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: RESOLVE_PRODUCT.id,
      label: "Resolve Product",
      order: "2",
    });
  }
}

@injectable()
export class ExplainViewContribution extends AbstractViewContribution<ExplainWidget> {
  constructor() {
    super({
      widgetId: ExplainWidget.ID,
      widgetName: ExplainWidget.LABEL,
      // The bottom area, beside Gear detail, and for the same reason: it answers
      // about a selection made elsewhere, so it has to be readable *while* the
      // Product view is on screen rather than instead of it.
      defaultWidgetOptions: { area: "bottom" },
      toggleCommandId: "gearbox.explain.toggle",
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: this.toggleCommand?.id ?? "",
      label: "Explain",
      order: "3",
    });
  }
}

@injectable()
export class LockViewContribution extends AbstractViewContribution<LockWidget> {
  constructor() {
    super({
      widgetId: LockWidget.ID,
      widgetName: LockWidget.LABEL,
      // The main area, beside Product: the lock is the same object seen at full
      // fidelity, and reading it means scrolling a few hundred lines. In the
      // bottom strip it would be a keyhole.
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.lock.toggle",
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: this.toggleCommand?.id ?? "",
      label: "Lock",
      order: "4",
    });
  }
}

@injectable()
export class GenerateViewContribution extends AbstractViewContribution<GenerateWidget> {
  constructor() {
    super({
      widgetId: GenerateWidget.ID,
      widgetName: GenerateWidget.LABEL,
      // The main area, beside Product and Lock: the plan is a tree of paths
      // and a Monaco diff, and both need width. In the bottom strip the
      // diff would be a keyhole.
      defaultWidgetOptions: { area: "main" },
      toggleCommandId: "gearbox.generate.toggle",
    });
  }

  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_GENERATE, {
      commandId: this.toggleCommand?.id ?? "",
      label: "Generate",
      order: "1",
    });
  }
}
