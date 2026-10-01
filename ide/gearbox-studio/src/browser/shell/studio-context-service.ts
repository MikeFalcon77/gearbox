// What Studio is working on: the one source of truth for menus, layout and header.
//
// ADR-0011 made Catalogue and Product two switchable perspectives, and its own
// revisit clause said what to do if that turned out wrong: "If the two
// perspectives turn out to be one -- if in practice nobody uses the catalogue
// except while editing a product -- collapse them." It did turn out wrong, and
// visibly: the toolbar grew `Catalogue` and `Product` buttons whose words matched
// two entries in the Gearbox menu while meaning something else -- switch a whole
// layout, not toggle a view.
//
// **A context is not a perspective, and the difference is the reason this file
// exists.** `PerspectiveService` stores and restores layouts, and it will happily
// restore one with no domain object behind it: after a reload its
// `activePerspectiveId` can say `gearbox.product` when no product is open. Keying
// the Product menu off that would offer product actions with nothing to act on.
//
// So the context is **derived from what is actually open**, never set
// independently. `ProductStore` owns whether a product is open; this owns what
// that means for the shell. One direction only:
//
//   StudioContextService --> PerspectiveService  (layout)
//                        --> context keys        (menus, actions)
//                        --> window title        (what you are working on)
//
// Not the reverse. A perspective cannot promote itself into a context.

import { FrontendApplicationContribution } from "@theia/core/lib/browser";
import { ContextKey, ContextKeyService } from "@theia/core/lib/browser/context-key-service";
import { FrontendApplicationStateService } from "@theia/core/lib/browser/frontend-application-state";
import { PerspectiveService } from "@theia/core/lib/browser/perspective-service";
import { Emitter, Event } from "@theia/core/lib/common/event";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";

import type { ProductRef } from "../../common/protocol";
import { ProductStore } from "../product-store";
import { GearSessionService } from "./gear-session-service";
import { SelectionService } from "./selection-service";

/**
 * The kinds of work Studio supports, named after the PRD's actors rather than
 * after its own panels: `cpt-gearbox-actor-integrator` composes a product,
 * `cpt-gearbox-actor-gear-author` writes a gear.
 */
export type StudioContext =
  | { readonly kind: "home" }
  | { readonly kind: "product"; readonly product: ProductRef }
  | { readonly kind: "gear"; readonly root: string };

/** The context key clauses key off. Values are the `kind`s above. */
export const STUDIO_CONTEXT_KEY = "gearbox.context";

/**
 * Whether anything is selected, as a context key rather than as a predicate.
 *
 * The Inspector answers about a selection, so with none it renders a panel whose
 * whole content is "select something" -- which §9.1 calls worse than an absent
 * one. A `canOpen()` predicate cannot express that on every surface:
 * `QuickViewService.getPicks` filters on `QuickViewItem.when` and consults no
 * command, so `Open View...` would have offered it regardless. A gate that must
 * reach that list has to be a key.
 */
export const HAS_SELECTION_KEY = "gearbox.hasSelection";

export const HOME_PERSPECTIVE = "gearbox.home";
export const PRODUCT_PERSPECTIVE = "gearbox.product";
export const GEAR_PERSPECTIVE = "gearbox.gear";

@injectable()
export class StudioContextService implements FrontendApplicationContribution {
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(GearSessionService) protected readonly gears!: GearSessionService;
  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(PerspectiveService) protected readonly perspectives!: PerspectiveService;
  @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;
  @inject(FrontendApplicationStateService)
  protected readonly appState!: FrontendApplicationStateService;

  protected readonly onDidChangeEmitter = new Emitter<StudioContext>();
  readonly onDidChange: Event<StudioContext> = this.onDidChangeEmitter.event;

  protected context: StudioContext = { kind: "home" };

  /**
   * The perspective switch in flight, so a caller can wait for the layout to
   * catch up with the context. Never rejects -- see [`settled`].
   */
  protected switching: Promise<void> = Promise.resolve();

  /**
   * Whether the shell is attached and its layout initialized.
   *
   * **Until it is, the context is computed but the layout is left alone.**
   * `FrontendApplication.start` runs every `onStart` *before* `attachShell` and
   * before `initializeLayout` (`frontend-application.js:59-66`), so a perspective
   * switched from `onStart` is applied to a shell nobody has attached and is then
   * overwritten by the restorer -- ADR-0011 records the same trap for opening a
   * view: "the panel ends up collapsed while its widget stays in the DOM, which
   * is worse than either". The menus and the header still need the context key
   * from the first frame, so the two halves are separated rather than delayed
   * together.
   */
  protected layoutReady = false;

  /**
   * Assigned in `@postConstruct`, never in a field initializer.
   *
   * A field initializer runs in the constructor, which is *before* inversify has
   * injected the properties -- so `this.contextKeys.createKey(...)` there throws
   * on `undefined` and takes the whole container down with it. That is not
   * hypothetical: it was written that way first, and the symptom was the catalogue
   * never settling, ninety seconds of nothing, and no hint that a context key was
   * to blame.
   */
  protected key!: ContextKey<string>;

  /** See [`HAS_SELECTION_KEY`]. Assigned beside `key`, and for the same reason. */
  protected selected!: ContextKey<boolean>;

  get current(): StudioContext {
    return this.context;
  }

  @postConstruct()
  protected init(): void {
    this.key = this.contextKeys.createKey<string>(STUDIO_CONTEXT_KEY, this.context.kind);
    this.selected = this.contextKeys.createKey<boolean>(
      HAS_SELECTION_KEY,
      this.selection.current !== undefined,
    );
    this.products.onChanged(() => this.recompute());
    this.gears.onDidChange(() => this.recompute());
    this.selection.onDidChange((current) => this.selected.set(current !== undefined));
  }

  onStart(): void {
    this.recompute();
    void this.appState.reachedState("ready").then(() => {
      this.layoutReady = true;
      this.recompute();
    });
  }

  /**
   * Resolves once the layout has caught up with the context.
   *
   * For a caller that has just opened something and needs the perspective's
   * `onActivate` to have run before it acts -- `switchPerspective` is a promise
   * this service used to drop on the floor.
   */
  async settled(): Promise<void> {
    // **Loops, because awaiting the field once awaits a *snapshot* of it.** A
    // caller that asks during a product-to-product move, and is still waiting
    // when the next move replaces `switching`, would otherwise return while the
    // switch that matters is still applying its layout -- and a sweep that runs
    // then is the failure `view-contributions.ts` records about closing during
    // `setLayoutData`. Settling means "the latest known switch has finished",
    // not "the one that was pending when I asked".
    for (;;) {
      const pending = this.switching;
      await pending;
      if (pending === this.switching) return;
    }
  }

  /**
   * Recompute from what is open, and act on each of the two things separately.
   *
   * `ProductStore.onChanged` fires for every resolution, every profile switch and
   * every lock fetch, so the *context* is guarded on the identity of the object
   * rather than on the event -- firing `onDidChange` per resolution would have
   * every subscriber rebuild itself for nothing. Gear sessions win over products
   * when both are somehow set: opening either closes the other first.
   *
   * **The layout is reconciled even when the context did not change, and that is
   * the whole point.** `PerspectiveService.switchPerspective` returns early when
   * the target is already active (`perspective-service.js:114`), and
   * `ShellLayoutRestorer` sets `activePerspectiveId` from persisted state before
   * any of this runs (`shell-layout-restorer.js:189`). So a reload with a product
   * open used to leave `gearbox.product` active while this service derived `home`
   * and returned early -- and the *next* open, which does derive `product`, then
   * asked for the perspective that was already nominally active and got nothing:
   * no `onActivate`, no Product widget in the centre, no collapsed left panel.
   * Comparing against the shell's own answer instead of against the previous
   * context is what closes that. The direction is still one-way -- a perspective
   * cannot promote itself into a context -- but a perspective that disagrees with
   * the context is corrected rather than believed.
   */
  protected recompute(): void {
    const gear = this.gears.current;
    const open = this.products.current.open;
    const next: StudioContext =
      gear !== undefined
        ? { kind: "gear", root: gear.root }
        : open === undefined
          ? { kind: "home" }
          : { kind: "product", product: open };
    const changed = !sameContext(this.context, next);
    if (changed) {
      this.context = next;
      this.key.set(next.kind);
    }

    const wanted = perspectiveFor(next);
    if (this.layoutReady && this.perspectives.getActivePerspectiveId() !== wanted) {
      // Swallowed here rather than at every `settled()` call: a failed layout
      // switch is already logged by `PerspectiveService`, and an unhandled
      // rejection on a field nobody happens to await is noise, not a signal.
      this.switching = this.perspectives.switchPerspective(wanted).catch(() => undefined);
    }

    if (changed) {
      this.onDidChangeEmitter.fire(next);
    }
  }
}

/** Which perspective lays out which context. */
export function perspectiveFor(context: StudioContext): string {
  switch (context.kind) {
    case "home":
      return HOME_PERSPECTIVE;
    case "product":
      return PRODUCT_PERSPECTIVE;
    case "gear":
      return GEAR_PERSPECTIVE;
  }
}

/**
 * Whether two contexts are the same piece of work.
 *
 * By path for a product, not by reference: `ProductStore` rebuilds its `open`
 * object on reload, and comparing references would switch the perspective on
 * every re-resolve.
 */
function sameContext(a: StudioContext, b: StudioContext): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "product" && b.kind === "product") return a.product.path === b.product.path;
  if (a.kind === "gear" && b.kind === "gear") return a.root === b.root;
  return true;
}
