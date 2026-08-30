// Two switchable perspectives, carried by Theia 1.75's PerspectiveService.
//
// ADR-0011 left the mechanism open (`PERSPECTIVE_LAYOUTS_STORAGE_KEY` or
// `ApplicationShell.createLayout`). The installed 1.75 already binds
// `PerspectiveContribution` -- see `@theia/core/lib/browser/perspective-service`
// and `frontend-application-module.js` -- so this file is one contribution,
// not a homemade switch.
//
// Lock, Generate and Graph are deliberately absent from the maps. Belonging
// is the saved layout, not a forced open: a switch that fires four requests
// to show two panels nobody asked for is worse than one that opens the two
// the perspective is for.

import { ApplicationShell, FrontendApplicationContribution } from "@theia/core/lib/browser";
import { FrontendApplicationStateService } from "@theia/core/lib/browser/frontend-application-state";
import {
  PerspectiveContribution,
  PerspectiveService,
  PerspectiveServiceImpl,
} from "@theia/core/lib/browser/perspective-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import { CatalogueWidget } from "../catalogue/catalogue-widget";
import { GearDetailWidget } from "../detail/gear-detail-widget";
import { ExplainWidget } from "../explain/explain-widget";
import { ProductWidget } from "../product/product-widget";

export const CATALOGUE_PERSPECTIVE = "gearbox.catalogue";
export const PRODUCT_PERSPECTIVE = "gearbox.product";

@injectable()
export class GearboxPerspectives
  implements PerspectiveContribution, FrontendApplicationContribution
{
  @inject(PerspectiveService) protected readonly perspectives!: PerspectiveService;
  @inject(FrontendApplicationStateService)
  protected readonly appState!: FrontendApplicationStateService;

  registerPerspectives(service: PerspectiveService): void {
    service.registerPerspective({
      id: CATALOGUE_PERSPECTIVE,
      label: "Catalogue",
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
  }

  /**
   * `PerspectiveServiceImpl.initialize` registers `default` and makes it
   * active before contributions run. Landing on Catalogue means the switch
   * always shows one of the two sides, never a third unnamed state.
   *
   * The switch waits for `ready`. `onStart` itself runs before the shell is
   * attached; opening widgets then left them collapsed in the DOM -- queryable
   * and invisible -- which this project has already paid for once.
   */
  onStart(): void {
    void this.appState.reachedState("ready").then(() => {
      if (
        this.perspectives.getActivePerspectiveId() ===
        PerspectiveServiceImpl.DEFAULT_PERSPECTIVE_ID
      ) {
        void this.perspectives.switchPerspective(CATALOGUE_PERSPECTIVE);
      }
    });
  }
}
