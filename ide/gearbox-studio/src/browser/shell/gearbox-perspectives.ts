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
import { GearDetailWidget } from "../detail/gear-detail-widget";
import { ExplainWidget } from "../explain/explain-widget";
import { ProductWidget } from "../product/product-widget";


@injectable()
export class GearboxPerspectives implements PerspectiveContribution {

  registerPerspectives(service: PerspectiveService): void {
    service.registerPerspective({
      id: HOME_PERSPECTIVE,
      label: "Home",
      viewPlacements: new Map<string, ApplicationShell.Area>([
        [CatalogueWidget.ID, "left"],
        [GearDetailWidget.ID, "bottom"],
      ]),
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
      viewPlacements: new Map<string, ApplicationShell.Area>([
        [ProductWidget.ID, "main"],
        [ExplainWidget.ID, "bottom"],
      ]),
      primaryViews: { main: ProductWidget.ID },
      // Same gap on the other side: opening a file parks an editor on top of
      // Product, and restoring that snapshot would hide the view the switch
      // is for. `onActivate` is the hook Theia calls after either path.
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
