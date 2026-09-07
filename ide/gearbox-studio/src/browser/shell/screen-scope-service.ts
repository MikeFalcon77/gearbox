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

import {
  GearAuthorViewContribution,
  ProductViewContribution,
  StartViewContribution,
} from "../view-contributions";
import { OwnedWidget, identityOf, outOfScope, type ContextIdentity } from "./screens";
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

  onStart(): void {
    // No payload. A queued pass that captured a context and then awaited would
    // act on a subject that has since moved -- see `reconcile`, which re-reads.
    this.contexts.onDidChange(() => this.enqueue());
    // Not redundant with the line above: `onDidChange` never fires when the
    // derived context equals the initial `home`, which is the boot case -- and
    // the boot case is exactly where a restored layout may hold a Product tab
    // saved into the Home snapshot.
    void this.appState.reachedState("ready").then(() => this.enqueue());
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

    await this.withdraw(to);
    if (!this.isCurrent(to)) return this.enqueue();

    await this.reassertPrimary(next);
    if (!this.isCurrent(to)) return this.enqueue();

    this.applied = to;
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
      const owned = OwnedWidget.is(widget) ? widget.ownerIdentity : undefined;
      if (declared.has(widget.id) || (owned !== undefined && owned !== to)) {
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
