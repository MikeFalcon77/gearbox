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
// Home keeps the catalogue visible. Without a product there is exactly one useful
// thing to do -- look at what could go into one -- and an empty main area at boot
// would be worse than what it replaced. The Start screen takes that place later.
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
import { injectable } from "@theia/core/shared/inversify";

import {
  GEAR_PERSPECTIVE,
  HOME_PERSPECTIVE,
  PRODUCT_PERSPECTIVE,
} from "./studio-context-service";
import { CatalogueWidget } from "../catalogue/catalogue-widget";
import { ProductWidget } from "../product/product-widget";


@injectable()
export class GearboxPerspectives implements PerspectiveContribution {

  registerPerspectives(service: PerspectiveService): void {
    service.registerPerspective({
      id: HOME_PERSPECTIVE,
      label: "Home",
      viewPlacements: new Map<string, ApplicationShell.Area>([[CatalogueWidget.ID, "left"]]),
      primaryViews: { left: CatalogueWidget.ID },
      // `primaryViews` runs only on first activation. A later switch restores
      // the snapshot, which may leave Explorer as the current left tab.
      onActivate: (shell) => {
        void shell.activateWidget(CatalogueWidget.ID);
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
