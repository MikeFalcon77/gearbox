// Where the two views live in the shell, and the commands that open them.

import {
  AbstractViewContribution,
  FrontendApplicationContribution,
  codicon,
} from "@theia/core/lib/browser";
import {
  ConnectionStatus,
  ConnectionStatusService,
} from "@theia/core/lib/browser/connection-status-service";
import { Command, CommandRegistry, MenuModelRegistry } from "@theia/core/lib/common";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueStore } from "./catalogue-store";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import { ConflictsWidget } from "./conflicts/conflicts-widget";
import { GraphWidget } from "./graph/graph-widget";
import { InspectorWidget } from "./inspector/inspector-widget";
import { GenerateWidget } from "./generate/generate-widget";
import { LockWidget } from "./lock/lock-widget";
import { GearboxMenus } from "./menus";
import { ProductStore } from "./product-store";
import { ProductWidget } from "./product/product-widget";
import { StartWidget } from "./start/start-widget";

export const RELOAD_CATALOGUE: Command = {
  id: "gearbox.catalogue.reload",
  label: "Gearbox: Reload Catalogue",
  shortTitle: "Reload Catalogue",
  iconClass: codicon("refresh"),
};

export const RESOLVE_PRODUCT: Command = {
  id: "gearbox.product.resolve",
  label: "Gearbox: Resolve Product",
  shortTitle: "Resolve",
  iconClass: codicon("sync"),
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
   * `Reload Catalogue` under Product, and **not** the panel toggle.
   *
   * The toggle used to be here as well, labelled `Catalogue`, and it was one half
   * of the duplication in this menu: `AbstractViewContribution.registerMenus`
   * already puts every toggle under `View > Views`, so the same command appeared
   * twice under two different words. The rule now is that **View lists panels and
   * Product lists things to do** -- so a panel toggle belongs in View, and
   * reloading the catalogue, which is an act with an effect, belongs here.
   */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
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

/**
 * The Home screen.
 *
 * Not a `FrontendApplicationContribution`, so it does not open itself at startup:
 * the Home perspective opens it, because whether it belongs on screen is a
 * question about the context rather than about the application starting. Opening
 * it here as well would put it in the main area behind a product that a saved
 * layout had already restored.
 */
@injectable()
export class StartViewContribution extends AbstractViewContribution<StartWidget> {
  constructor() {
    super({
      widgetId: StartWidget.ID,
      widgetName: StartWidget.LABEL,
      defaultWidgetOptions: { area: "main" },
      // **No toggle command, and therefore no entry in `View`.** Every other view
      // is something a person chooses to look at; this one is what the shell shows
      // when there is nothing open, and it arrives by closing a product rather than
      // by being picked from a list. A toggle would also have read as
      // `Gearbox Studio` among seven `Gearbox <noun>` views -- the application's
      // own name sitting in a list of its panels.
    });
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

/**
 * The one panel that answers about a selection.
 *
 * Replaces `DetailViewContribution` and `ExplainViewContribution`. They opened
 * two bottom tabs that answered about two different selections, so the second one
 * was empty in the ordinary case -- see `InspectorWidget` for why that was worth
 * merging rather than wiring together.
 */
@injectable()
export class InspectorViewContribution
  extends AbstractViewContribution<InspectorWidget>
  implements FrontendApplicationContribution
{
  constructor() {
    super({
      widgetId: InspectorWidget.ID,
      widgetName: InspectorWidget.LABEL,
      // The bottom area, so the tree, the graph and the answer are all readable at
      // once. In the side panel this content was clipped, which hid exactly the
      // projected facts it exists to show.
      defaultWidgetOptions: { area: "bottom" },
      toggleCommandId: "gearbox.inspector.toggle",
    });
  }

  async initializeLayout(): Promise<void> {
    // Not activated: whatever the person is choosing from keeps focus, because
    // making a selection is what fills this panel.
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
      // detail of the catalogue. The Product perspective opens it; the toggle
      // still opens it on request from Catalogue, so a person is not forced
      // through the switch to look at one description.
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

  /**
   * `Resolve Product`, and not the panel toggle -- see `CatalogueViewContribution`
   * for the rule. The Product view is reached from `View`, or by opening a product,
   * which is what the Product perspective is for.
   */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: RESOLVE_PRODUCT.id,
      label: "Resolve Product",
      order: "2",
    });
  }
}

/**
 * Conflicts, in the bottom area beside the Inspector.
 *
 * Bottom rather than main: it is read *while* looking at the tree that caused the
 * complaint, and a conflict list that replaces the product is a list you cannot
 * act on. Not opened by `initializeLayout` either -- a panel that appears at
 * startup to say "no conflicts" is a panel that says nothing.
 */
@injectable()
export class ConflictsViewContribution extends AbstractViewContribution<ConflictsWidget> {
  constructor() {
    super({
      widgetId: ConflictsWidget.ID,
      widgetName: ConflictsWidget.LABEL,
      defaultWidgetOptions: { area: "bottom" },
      toggleCommandId: "gearbox.conflicts.toggle",
    });
  }

  /**
   * In the Product menu, because looking at what the resolution could not decide
   * is one of the few things there is to *do* to a product -- the exception to
   * "View lists panels" that the rule was written to allow.
   */
  override registerMenus(menus: MenuModelRegistry): void {
    super.registerMenus(menus);
    menus.registerMenuAction(GearboxMenus.GEARBOX_RESOLVE, {
      commandId: this.toggleCommand?.id ?? "",
      label: "Conflicts",
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
