// Which screens may exist right now, and closing the ones that may not.
//
// `StudioContextService` derives *what* is being worked on and publishes it as a
// context key and a perspective. That is enough to gate a menu and not enough to
// govern a widget: a menu is re-read every time it opens, and a widget that is
// already on screen is never asked again. So a product's screens survived the
// product -- the empty `Gearbox Product` tab a UX pass found on Home -- and, less
// visibly, survived *into another product*, where `ProductEditService` would
// happily commit them against whatever was open by then.
//
// This is the other half: one place that reconciles the shell with the context,
// and the only place that decides which screen comes forward.
//
// **Closed, not detached, and only widgets this application builds.** Every
// Gearbox widget is bound transiently behind a `WidgetFactory`, and
// `WidgetManager` drops its cache entry when a widget disposes
// (`widget-manager.js:150`), so the next open builds a fresh one --
// `LayoutMigration` has closed the Inspector on that argument since migration
// version 4. Detaching would leave a live widget subscribed to `ProductStore`,
// rendering a product that is gone, and would hand *that* instance back on the
// next open. The `terminal-` lesson does not apply here: that package keeps
// bookkeeping outside `WidgetManager`, and foreign widgets are still detached
// rather than closed, by `LayoutMigration.sweepForbidden`.

import { ApplicationShell, FrontendApplicationContribution } from "@theia/core/lib/browser";
import { FrontendApplicationStateService } from "@theia/core/lib/browser/frontend-application-state";
import { inject, injectable } from "@theia/core/shared/inversify";
import type { Widget } from "@theia/core/shared/@lumino/widgets";

/**
 * What a context does to one side panel.
 *
 * Three values, not two, and `leave` is the one that matters: it is what stops a
 * preset fighting a person who deliberately reopens a panel. Presets apply on a
 * *transition* only, so reopening the Inspector inside the product context is
 * not a transition and nothing re-collapses it.
 */
type PanelIntent = "expand" | "collapse" | "leave";

type Preset = Readonly<Record<PanelArea, PanelIntent>>;

/**
 * The layout each context asks for.
 *
 * **Home folds all three, which reverses a stated position** -- ADR-0011 had the
 * catalogue beside Start as Home's second half. The UX pass that asked for this
 * also pointed out what the old arrangement cost: `Browse Catalogue` on the
 * Start screen was a button that revealed a panel already on screen. With the
 * left panel folded it becomes the act it is named after, and Start gets the
 * whole centre.
 *
 * **Product and Gear leave all three alone, and that is not a weaker version of
 * folding the catalogue -- it is the same outcome without the fight.** Home
 * already folds everything, so a product entered from Home starts folded; the
 * only case where a product preset would have anything to collapse is one where
 * the person opened a panel *on purpose* during the previous context. Taking it
 * away then is what `leave` exists to prevent.
 *
 * And it removes a real hazard rather than a hypothetical one. A collapse
 * relayouts the shell, React replaces nodes, and a click already in flight is
 * lost between mousedown and mouseup -- measured twice: the `Open Product...`
 * quick-input dismissed on Home, and the Product view's own stage tabs refusing
 * to switch. Home's fold is safe because it runs before the screen appears; a
 * fold on entering a product cannot be, because a product takes three seconds to
 * arrive and the person is already looking at it.
 */
const PRESETS: Readonly<Record<ContextKind, Preset>> = {
  home: { left: "collapse", right: "collapse", bottom: "collapse" },
  product: { left: "leave", right: "leave", bottom: "leave" },
  gear: { left: "leave", right: "leave", bottom: "leave" },
};

import {
  GearAuthorViewContribution,
  ProductViewContribution,
  StartViewContribution,
} from "../view-contributions";
import { FocusModeService, PANELS, type PanelArea } from "./focus-mode-service";
import {
  OwnedWidget,
  identityOf,
  outOfScope,
  screenFor,
  type ContextIdentity,
  type ContextKind,
} from "./screens";
import { StudioContextService, type StudioContext } from "./studio-context-service";

@injectable()
export class ScreenScopeService implements FrontendApplicationContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
  @inject(StudioContextService) protected readonly contexts!: StudioContextService;
  @inject(FrontendApplicationStateService)
  protected readonly appState!: FrontendApplicationStateService;
  // The three contributions that own the rule about when their view may come
  // forward. Reached rather than reimplemented: `mayTakeTheFront` must have one
  // definition, and a bare `shell.activateWidget` here would be a second.
  @inject(StartViewContribution) protected readonly start!: StartViewContribution;
  @inject(ProductViewContribution) protected readonly product!: ProductViewContribution;
  @inject(GearAuthorViewContribution) protected readonly gear!: GearAuthorViewContribution;
  @inject(FocusModeService) protected readonly focus!: FocusModeService;

  /**
   * The identity a reconcile ran to completion for.
   *
   * Assigned only after a pass that finished under one identity -- see
   * [`reconcile`]. `undefined` until the first pass, which is what makes a
   * restored layout get swept whatever it holds.
   */
  protected applied: ContextIdentity | undefined;

  /** The pass in flight, and at most one waiting behind it. */
  protected running: Promise<void> = Promise.resolve();
  protected queued = false;

  /**
   * Which subject each open screen was opened under.
   *
   * **Stamped when the widget joins the shell, not when a wizard seeds it**, and
   * that distinction is a bug fix rather than tidiness. Withdrawal is not
   * instantaneous: it waits for the perspective switch, and opening a product
   * takes about three seconds, so a person can open a screen *while* the
   * reconciliation for that same product is still running. Deciding by declared
   * scope alone, the sweep would then close a screen that belongs to the product
   * that had just finished opening -- observed as a Graph that vanished
   * immediately after being asked for.
   *
   * Keyed by widget id and read alongside `OwnedWidget.ownerIdentity`, which the
   * wizards also record for the write boundary: both are taken from the same
   * `identityOf(current)` at the same moment, so they cannot disagree.
   */
  protected owners = new Map<string, ContextIdentity>();

  onStart(): void {
    // No payload. A queued pass that captured a context and then awaited would
    // act on a subject that has since moved -- see `reconcile`, which re-reads.
    this.contexts.onDidChange(() => this.enqueue());
    // Not redundant with the line above: `onDidChange` never fires when the
    // derived context equals the initial `home`, which is the boot case -- and
    // the boot case is exactly where a restored layout may hold a Product tab
    // saved into the Home snapshot.
    void this.appState.reachedState("ready").then(() => this.enqueue());
    // **The main tab, never the event's payload.** `onDidChangeCurrentWidget` is
    // fired from the shell's own `FocusTracker`, so it also fires when focus
    // moves into the catalogue or the Inspector, carrying that widget. What this
    // is about is which screen occupies the centre.
    this.shell.onDidAddWidget((widget) => this.stampOnAdd(widget));
    this.shell.onDidRemoveWidget((widget) => this.owners.delete(widget.id));
  }

  /** Record the subject a screen was opened under. See [`owners`]. */
  protected stampOnAdd(widget: Widget): void {
    if (screenFor(widget.id)?.lifetime !== "context-instance") return;
    this.owners.set(widget.id, identityOf(this.contexts.current));
  }

  /** What a screen belongs to: its own record if it kept one, else ours. */
  protected ownerOf(widget: Widget): ContextIdentity | undefined {
    const own = OwnedWidget.is(widget) ? widget.ownerIdentity : undefined;
    return own ?? this.owners.get(widget.id);
  }

  /**
   * Ask for a reconciliation, coalescing repeats.
   *
   * One running and one waiting, never a queue: three context changes in a row
   * want the shell to match the third, not to be dragged through the first two.
   */
  enqueue(): void {
    if (this.queued) return;
    this.queued = true;
    this.running = this.running
      .then(() => {
        this.queued = false;
        return this.reconcile();
      })
      .catch(() => {
        this.queued = false;
      });
  }

  /** Resolves when no reconciliation is pending. For tests and for callers that follow one. */
  async settled(): Promise<void> {
    await this.running;
  }

  /**
   * Make the shell hold exactly the screens the current subject may have.
   *
   * **Every await is followed by a re-read**, and the reason is not symmetry. A
   * pass that captured `product:b` and woke after a further move to `home` would
   * withdraw for B, open B's workspace over Home, collapse Home's panels for a
   * product, and then record `applied = product:b` -- leaving the *next* pass to
   * coalesce itself away as already done. So `applied` is assigned only by a
   * pass that finished under one identity, and any other pass re-enqueues.
   *
   * The first await is the load-bearing one: `settled()` is what keeps a close
   * out of a perspective switch's own `setLayoutData`, which is the race that
   * poisoned the Home snapshot three times before.
   */
  protected async reconcile(): Promise<void> {
    await this.contexts.settled();

    const next = this.contexts.current;
    const to = identityOf(next);
    if (to === this.applied) return;

    // Before the withdrawal, so a wizard being closed cannot leave an episode
    // half-applied, and so the preset below is the only thing deciding panels.
    this.focus.suspend();

    await this.withdraw(to);
    if (!this.isCurrent(to)) return this.enqueue();

    // **The panels before the screen, and that order was measured.** With the
    // preset last, the layout settled *after* the context's screen appeared --
    // and appearing is what everything downstream waits for, the conformance
    // fixture included. So three panels collapsed a moment after a person could
    // already click, and the collapse dismissed a quick-input they had just
    // opened: `Open Product...` became a button that did nothing. Arranging the
    // room before showing the screen also leaves the focus where it belongs,
    // which is on the screen rather than on the last panel this touched.
    this.applyPreset(next.kind);
    if (!this.isCurrent(to)) return this.enqueue();

    await this.reassertPrimary(next);
    if (!this.isCurrent(to)) return this.enqueue();

    this.applied = to;
  }

  /**
   * Fold the panels this context does not want, and leave the rest alone.
   *
   * Imperative rather than declared, because `chromeOptions.collapseAreas`
   * applies on a perspective's **first** activation only -- Theia runs the
   * chrome loop in the branch where no saved layout exists
   * (`perspective-service.js:130-144`) -- so it was already a no-op for anyone
   * returning to a context they had visited.
   *
   * Safe where `activateWidget` was not: `SidePanelHandler.collapse()` sets
   * `currentTitle = null` and returns an `animationFrame()`. No `waitForRevealed`,
   * no 2.25-second `waitForActivation`, no focus change, no dispose. `expand()`
   * with no id restores `state.lastActiveTabIndex`, which `collapse()` never
   * clears, so the tab the person had is the tab that comes back and this
   * service keeps no record of its own.
   *
   * **The returned promise is deliberately not awaited.** It resolves on the next
   * animation frame, and the layout change has already been applied
   * synchronously before it is returned -- so awaiting buys nothing and can cost
   * everything: a browser that throttles `requestAnimationFrame` never settles
   * it, and this sits in front of `reassertPrimary`, so the whole reconciliation
   * stopped and no screen was ever put on screen at all. Measured as a shell
   * that booted to an empty centre.
   */
  protected applyPreset(kind: ContextKind): void {
    const preset = PRESETS[kind];
    for (const area of PANELS) {
      const intent = preset[area];
      if (intent === "leave") continue;
      const expanded = this.shell.isExpanded(area);
      if (intent === "collapse" && expanded) {
        void this.shell.collapsePanel(area);
      } else if (intent === "expand" && !expanded) {
        this.shell.expandPanel(area);
      }
    }
  }

  protected isCurrent(to: ContextIdentity): boolean {
    return identityOf(this.contexts.current) === to;
  }

  /**
   * Close the screens that do not belong to `to`.
   *
   * Two reasons a widget goes, and the second is the one that matters. The
   * declared scope covers a screen whose *kind* of context has ended -- Add Gear
   * with no product. The recorded owner covers a screen whose *subject* has
   * changed underneath it: a wizard staged against one product when another is
   * opened, which the declaration alone cannot see, because both are `product`.
   *
   * One `closeMany`, not a loop of `closeWidget`: it is one layout update, and
   * it is the method Theia's own documentation points at for exactly this.
   */
  protected async withdraw(to: ContextIdentity): Promise<void> {
    const declared = new Set(outOfScope(this.applied, to));
    const doomed: Widget[] = [];
    for (const widget of this.shell.widgets) {
      if (!widget.isAttached) continue;
      const owner = this.ownerOf(widget);
      // **A recorded owner outranks the declared scope, and only in one
      // direction: it can save a screen, never condemn one.** A screen opened
      // while this very reconciliation was in flight carries the subject that is
      // arriving, and closing it would undo an act the person had already
      // completed. A screen with no owner at all falls back to the declaration.
      if (owner === to) continue;
      if (declared.has(widget.id) || owner !== undefined) {
        doomed.push(widget);
      }
    }
    if (doomed.length === 0) return;
    await this.shell.closeMany(doomed);
  }

  /**
   * Put the context's own screen back in front.
   *
   * **Not optional, and not cosmetic.** Closing the current main widget makes
   * Lumino activate a sibling of its choosing (`application-shell.js:1069-1085`)
   * -- an editor, the Graph, whatever happens to be next in the tab bar. That is
   * the mechanism that took ten Add Gear claims down at once when Start was
   * closed, and the reason the previous three attempts at closing anything here
   * were abandoned.
   *
   * **And it is the only imperative activation in the application.** The Start
   * view used to open itself from a context event, and the perspectives opened
   * theirs from `onActivate`; both fired before the layout settled and raced
   * this. A second owner of "what is in front", however well guarded, is what
   * produced the 2.5-second front-stealing ADR-0011 records.
   */
  protected async reassertPrimary(context: StudioContext): Promise<void> {
    switch (context.kind) {
      case "home":
        await this.start.openView({ activate: true, reveal: true });
        return;
      case "product":
        await this.product.openIfProduct();
        return;
      case "gear":
        await this.gear.openView({ activate: true, reveal: true });
        return;
    }
  }
}
