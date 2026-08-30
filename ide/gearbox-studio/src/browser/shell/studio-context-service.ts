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
import { PerspectiveService } from "@theia/core/lib/browser/perspective-service";
import { Emitter, Event } from "@theia/core/lib/common/event";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";

import type { ProductRef } from "../../common/protocol";
import { ProductStore } from "../product-store";

/**
 * The kinds of work Studio supports, named after the PRD's actors rather than
 * after its own panels: `cpt-gearbox-actor-integrator` composes a product,
 * `cpt-gearbox-actor-gear-author` writes a gear.
 *
 * `gear` is in the type although nothing enters it yet. Declaring it now means
 * every `switch` over a context is already exhaustive, and the compiler will
 * find the ones that need a branch when gear authoring lands -- rather than
 * leaving them to be discovered by a wrong default.
 */
export type StudioContext =
  | { readonly kind: "home" }
  | { readonly kind: "product"; readonly product: ProductRef }
  | { readonly kind: "gear"; readonly root: string };

/** The context key clauses key off. Values are the `kind`s above. */
export const STUDIO_CONTEXT_KEY = "gearbox.context";

export const HOME_PERSPECTIVE = "gearbox.home";
export const PRODUCT_PERSPECTIVE = "gearbox.product";
export const GEAR_PERSPECTIVE = "gearbox.gear";

@injectable()
export class StudioContextService implements FrontendApplicationContribution {
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(PerspectiveService) protected readonly perspectives!: PerspectiveService;
  @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;

  protected readonly onDidChangeEmitter = new Emitter<StudioContext>();
  readonly onDidChange: Event<StudioContext> = this.onDidChangeEmitter.event;

  protected context: StudioContext = { kind: "home" };

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

  get current(): StudioContext {
    return this.context;
  }

  @postConstruct()
  protected init(): void {
    this.key = this.contextKeys.createKey<string>(STUDIO_CONTEXT_KEY, this.context.kind);
    this.products.onChanged(() => this.recompute());
  }

  onStart(): void {
    this.recompute();
  }

  /**
   * Recompute from what is open, and act only if it changed.
   *
   * `ProductStore.onChanged` fires for every resolution, every profile switch and
   * every lock fetch; switching a perspective on each of those would fight the
   * person's own layout. The guard is on the *identity of the object*, not on the
   * event.
   */
  protected recompute(): void {
    const open = this.products.current.open;
    const next: StudioContext =
      open === undefined ? { kind: "home" } : { kind: "product", product: open };
    if (sameContext(this.context, next)) {
      return;
    }
    this.context = next;
    this.key.set(next.kind);
    void this.perspectives.switchPerspective(perspectiveFor(next));
    this.onDidChangeEmitter.fire(next);
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
