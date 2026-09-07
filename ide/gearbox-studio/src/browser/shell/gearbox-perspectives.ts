// Three layouts, and nothing more. Which one is active is decided elsewhere.
//
// This file used to also *be* the context: two perspectives, Catalogue and
// Product, switched by buttons in the toolbar. ADR-0011's own revisit clause
// called that a cheap mistake to correct, and it was made: the words duplicated
// two Gearbox menu entries while meaning something else. Perspectives now only
// arrange panels, and `StudioContextService` decides which arrangement applies --
// because a perspective can be restored from a saved layout with no domain object
// behind it, and a menu keyed off that would offer product actions with no product.
//
// Home is the Start screen in the main area with the catalogue beside it. Without
// a product there are two useful things: choose one to work on, and look at what a
// product could be made of. It used to be the catalogue and an *empty* main area,
// which reads as an application that failed to load rather than as a tool waiting
// to be told what to work on.
//
// Lock, Generate and Graph are deliberately absent from the maps. Belonging is
// the saved layout, not a forced open: a switch that fires four requests to show
// two panels nobody asked for is worse than one that opens the two the context
// is for.

import { ApplicationShell } from "@theia/core/lib/browser";
import {
  PerspectiveContribution,
  PerspectiveService,
} from "@theia/core/lib/browser/perspective-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import {
  GEAR_PERSPECTIVE,
  HOME_PERSPECTIVE,
  PRODUCT_PERSPECTIVE,
  StudioContextService,
} from "./studio-context-service";
import { CatalogueWidget } from "../catalogue/catalogue-widget";
import {
  GearAuthorViewContribution,
  ProductViewContribution,
  StartViewContribution,
} from "../view-contributions";


@injectable()
export class GearboxPerspectives implements PerspectiveContribution {
  // Reached for one reason: `onActivate` gets a shell, and a shell can activate a
  // widget but not create one. Coming back to Home after closing a product has to
  // *open* the Start screen, because `applyViewPlacements` runs on a perspective's
  // first activation only -- so on the second visit the placement is a no-op and
  // an `activateWidget` on a widget nobody built does nothing at all, silently.
  @inject(StartViewContribution) protected readonly start!: StartViewContribution;
  // Same reason as Start: Product's `primaryViews` runs on first activation only,
  // and a later switch that only `activateWidget`s leaves the centre empty when
  // nobody has built the Product widget yet (or a restored layout buried it).
  @inject(ProductViewContribution) protected readonly product!: ProductViewContribution;
  @inject(GearAuthorViewContribution) protected readonly gear!: GearAuthorViewContribution;
  // Read, never written: a perspective arranges panels, and the context decides
  // which arrangement applies. What this buys is the right to *decline* -- see
  // the Home `onActivate`.
  @inject(StudioContextService) protected readonly contexts!: StudioContextService;

  registerPerspectives(service: PerspectiveService): void {
    service.registerPerspective({
      id: HOME_PERSPECTIVE,
      label: "Home",
      // The Start screen in the main area, the catalogue beside it. Home used to
      // be the catalogue and an empty main area, which read as an application
      // that had failed to load something rather than as a tool waiting to be
      // told what to work on.
      //
      // Inspector is opened in `onActivate`, not listed here: putting it in
      // `viewPlacements` on a first Home activation (no saved layout) is fine,
      // but a boot-time perspective switch that *only* named Gearbox widgets
      // made Explorer / SCM look like strays once a saved Home layout existed.
      // **Empty, and the areas come from the view contributions instead.**
      // `applyViewPlacements` does not only place: it `activateWidget`s every
      // entry, inside the switch's own promise chain, and that chain is slow in
      // a way nothing here can see -- `activateWidget` waits on
      // `waitForRevealed` (polls, no timeout) and `waitForActivation` (2.25 s),
      // so the last activation of a switch can land seconds after the
      // interaction that started it. Measured at 2.5 s, which was long enough to
      // bring Home in front of a product that had been opened in the meantime,
      // and then to bring the product in front of the Add Gear panel the person
      // had just opened. Every widget here already declares the same area in its
      // `defaultWidgetOptions`, so an empty map changes no placement -- with the
      // map empty, `WidgetAreaResolverImpl.resolveArea` returns `undefined` and
      // `ApplicationShell.resolveWidgetArea` keeps the requested area -- and it
      // leaves *when* a view comes forward to `onActivate`, which can decline.
      // `chromeOptions.collapseAreas` still applies: it runs after the loops.
      viewPlacements: new Map<string, ApplicationShell.Area>(),
      // **No `primaryViews`, and this is not a simplification.** Theia activates
      // them at the end of `applyViewPlacements`, inside the switch's own
      // promise chain -- and that chain is slow in a way that is invisible from
      // here: `activateWidget` waits on `waitForRevealed` (polls, no timeout)
      // and `waitForActivation` (gives up after 2.25 s), so a widget that never
      // becomes visible costs that much, and this map is activated after up to
      // four such waits. Measured: a boot switch to Home brought Start to the
      // front 2.5 s after a product had been opened and Add Gear opened on top
      // of it, hiding both. `onActivate` below does the same job and can decline
      // when the context has moved on, which a descriptor field cannot.
      onActivate: (shell) => {
        // Sequenced, not fired together: the catalogue is brought to the front of
        // the left panel -- a restored snapshot may have left Explorer there --
        // and *then* the Start screen takes the focus, because its first action is
        // the one a person came here for. The other order leaves the caret in the
        // catalogue's filter box.
        //
        // Opened, not merely activated -- see the field above. `openView` is
        // idempotent, so the ordinary case costs one lookup.
        void shell
          .activateWidget(CatalogueWidget.ID)
          .then(() => {
            // **Checked again here, and this is the whole reason the guard
            // exists.** `onActivate` is fire-and-forget and this chain can land
            // seconds late: `ApplicationShell.activateWidget` waits on
            // `waitForRevealed`, which polls with no timeout, and on
            // `waitForActivation`, which gives up after 2.25 s -- so a widget
            // that never becomes visible costs that much per activation, and
            // `applyViewPlacements` activates up to four. Measured: a boot switch
            // to Home landed its `onActivate` 2.5 s after a product had been
            // opened and the person had opened Add Gear, and activating Start
            // then put the Home screen in front of both. A perspective cannot
            // promote itself into a context, and neither may its callbacks act
            // against one.
            if (this.contexts.current.kind !== "home") return undefined;
            return this.start.openView({ activate: true, reveal: true });
          });
        // The Inspector is **not** opened here any more. On Home nothing is
        // selected, so it rendered a panel whose whole content is "select
        // something" -- which §9.1 already calls worse than an absent one -- and
        // now that it lives in the right panel, opening it would expand a side
        // panel over the Start screen. It arrives on the first selection, which
        // is what fills it.
      },
    });
    service.registerPerspective({
      id: PRODUCT_PERSPECTIVE,
      label: "Product",
      // **The product, and nothing else.** Explain used to be placed here and it
      // opened empty -- "Select a process..." -- which is a panel asking to be
      // given a job. An empty domain panel is worse than an absent one: it takes
      // room in the bottom bar and teaches the reader that panels here are
      // decorative. Explain, Lock, Generate and the Graph are all one command
      // away and are remembered per context once opened.
      // Empty, for the reason the Home perspective's map records.
      viewPlacements: new Map<string, ApplicationShell.Area>(),
      // The catalogue is a source of components, not the subject of this context,
      // and it had been dominating the left while the product sat in a secondary
      // tab. Collapsing rather than closing: it is still one click away, the
      // Explorer and git go with it into the same fold, and the person can reopen
      // any of them freely -- `collapseAreas` applies on first activation only.
      chromeOptions: { collapseAreas: ["left"] },
      // `primaryViews` runs only on first activation. A later switch restores the
      // snapshot, which may have parked an editor on top of Product -- opening a
      // gear's source from the product tree does exactly that -- and restoring
      // that would hide the view the context is for.
      //
      // Opened, not merely activated -- see the Product field above. `openView` is
      // idempotent, so the ordinary case costs one lookup.
      // One call, and it is the view contribution's own: the rule about *when* a
      // view may take the front lives with the view, so this callback and the
      // session's signal cannot disagree about it.
      onActivate: () => {
        if (this.contexts.current.kind !== "product") return;
        void this.product.openIfProduct();
      },
    });

    service.registerPerspective({
      id: GEAR_PERSPECTIVE,
      label: "Gear",
      viewPlacements: new Map<string, ApplicationShell.Area>(),
      chromeOptions: { collapseAreas: ["left"] },
      onActivate: () => {
        if (this.contexts.current.kind !== "gear") return;
        void this.gear.openView({ activate: true, reveal: true });
      },
    });
  }
}
