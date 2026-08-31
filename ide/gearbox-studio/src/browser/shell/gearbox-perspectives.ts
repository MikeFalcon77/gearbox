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
} from "./studio-context-service";
import { CatalogueWidget } from "../catalogue/catalogue-widget";
import { ProductWidget } from "../product/product-widget";
import { StartWidget } from "../start/start-widget";
import { StartViewContribution } from "../view-contributions";


@injectable()
export class GearboxPerspectives implements PerspectiveContribution {
  // Reached for one reason: `onActivate` gets a shell, and a shell can activate a
  // widget but not create one. Coming back to Home after closing a product has to
  // *open* the Start screen, because `applyViewPlacements` runs on a perspective's
  // first activation only -- so on the second visit the placement is a no-op and
  // an `activateWidget` on a widget nobody built does nothing at all, silently.
  @inject(StartViewContribution) protected readonly start!: StartViewContribution;

  registerPerspectives(service: PerspectiveService): void {
    service.registerPerspective({
      id: HOME_PERSPECTIVE,
      label: "Home",
      // The Start screen in the main area, the catalogue beside it. Home used to
      // be the catalogue and an empty main area, which read as an application
      // that had failed to load something rather than as a tool waiting to be
      // told what to work on.
      viewPlacements: new Map<string, ApplicationShell.Area>([
        [StartWidget.ID, "main"],
        [CatalogueWidget.ID, "left"],
      ]),
      primaryViews: { main: StartWidget.ID, left: CatalogueWidget.ID },
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
          .then(() => this.start.openView({ activate: true, reveal: true }));
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
      viewPlacements: new Map<string, ApplicationShell.Area>([[ProductWidget.ID, "main"]]),
      primaryViews: { main: ProductWidget.ID },
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
      onActivate: (shell) => {
        void shell.activateWidget(ProductWidget.ID);
      },
    });

    // Registered empty, and nothing enters it until gear authoring lands.
    //
    // Declared anyway so that `perspectiveFor` is a total mapping rather than a
    // claim: `switchPerspective` on an unregistered id returns silently, so the
    // alternative is a context whose layout never applies and never says why.
    service.registerPerspective({
      id: GEAR_PERSPECTIVE,
      label: "Gear",
      viewPlacements: new Map<string, ApplicationShell.Area>(),
    });
  }


}
