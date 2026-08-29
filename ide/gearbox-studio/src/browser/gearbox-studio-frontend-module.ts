// Frontend wiring: the views, two stores, one proxied service.

import { FrontendApplicationContribution, bindViewContribution } from "@theia/core/lib/browser";
import { WebSocketConnectionProvider } from "@theia/core/lib/browser/messaging";
import { CommandContribution } from "@theia/core/lib/common";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule } from "@theia/core/shared/inversify";
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";

import { GEARBOX_SERVICE_PATH, GearboxClient, GearboxService } from "../common/protocol";
import { CatalogueStore } from "./catalogue-store";
import { ProductStore } from "./product-store";
import { bindWidget } from "./contribution";
import { MenuNarrowing } from "./theia/core/menu-narrowing";
import { RevealService } from "./reveal-service";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import {
  CatalogueViewContribution,
  DetailViewContribution,
  GraphViewContribution,
  ProductViewContribution,
} from "./view-contributions";
import { GearDetailWidget } from "./detail/gear-detail-widget";
import { DepsGraphWidget } from "./graph/deps-graph-widget";
import { ProductWidget } from "./product/product-widget";
import { GdlLanguageContribution } from "./gdl/gdl-language-contribution";

import "../../src/browser/style/index.css";

export default new ContainerModule((bind) => {
  // Without this, `.gdl` opens as plaintext: nothing else in the app registers
  // the language with Monaco.
  bind(LanguageGrammarDefinitionContribution)
    .to(GdlLanguageContribution)
    .inSingletonScope();

  bind(CatalogueStore).toSelf().inSingletonScope();
  // Its own store, not a slice of the catalogue's: the two objects of work do not
  // subordinate one another, and their lifecycles differ -- the catalogue loads
  // once and streams, a product is re-resolved on every profile switch.
  bind(ProductStore).toSelf().inSingletonScope();
  bind(RevealService).toSelf().inSingletonScope();
  bind(GearboxClient).toService(CatalogueStore);

  bind(GearboxService)
    .toDynamicValue(({ container }) => {
      const provider = container.get(WebSocketConnectionProvider);
      // The proxy is two-way: the backend calls the client back with each
      // projection, which is what makes the tree fill in rather than reload.
      //
      // The client is reached through a forwarder rather than resolved here,
      // because the store injects the service and the service needs a client --
      // a cycle inversify reports as "circular dependency in one of the
      // toDynamicValue bindings". One of the two edges has to be deferred, and
      // this is the safe one: a notification cannot arrive before the store has
      // asked for the service and started a load.
      const forwarder: GearboxClient = {
        onCatalogueChanged: (event) => container.get(CatalogueStore).onCatalogueChanged(event),
        onCatalogueDiagnostics: (event) =>
          container.get(CatalogueStore).onCatalogueDiagnostics(event),
        onProgress: (event) => container.get(CatalogueStore).onProgress(event),
        onLog: (message) => container.get(CatalogueStore).onLog(message),
      };
      return provider.createProxy<GearboxService>(GEARBOX_SERVICE_PATH, forwarder);
    })
    .inSingletonScope();

  // Bound before the view contributions so it runs last among menu
  // contributions: removal only works on a tree the contributors have already
  // filled.
  bind(MenuNarrowing).toSelf().inSingletonScope();
  bind(MenuContribution).toService(MenuNarrowing);

  bindWidget(bind, CatalogueWidget);
  bindWidget(bind, GearDetailWidget);
  bindWidget(bind, DepsGraphWidget);
  bindWidget(bind, ProductWidget);

  bindViewContribution(bind, CatalogueViewContribution);
  bind(FrontendApplicationContribution).toService(CatalogueViewContribution);
  bind(CommandContribution).toService(CatalogueViewContribution);
  bind(MenuContribution).toService(CatalogueViewContribution);

  bindViewContribution(bind, DetailViewContribution);
  bind(FrontendApplicationContribution).toService(DetailViewContribution);
  bind(CommandContribution).toService(DetailViewContribution);

  bindViewContribution(bind, GraphViewContribution);
  bind(CommandContribution).toService(GraphViewContribution);

  // No `FrontendApplicationContribution` here: the Product view opens on
  // request, so it has no `initializeLayout` to run. `MenuContribution` is what
  // finally puts commands under the Gearbox menu, which until now rendered as an
  // empty dropdown.
  bindViewContribution(bind, ProductViewContribution);
  bind(CommandContribution).toService(ProductViewContribution);
  bind(MenuContribution).toService(ProductViewContribution);
});
