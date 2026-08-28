// Frontend wiring: two views, one store, one proxied service.

import {
  FrontendApplicationContribution,
  WidgetFactory,
  bindViewContribution,
} from "@theia/core/lib/browser";
import { WebSocketConnectionProvider } from "@theia/core/lib/browser/messaging";
import { CommandContribution } from "@theia/core/lib/common";
import { ContainerModule } from "@theia/core/shared/inversify";
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";

import { GEARBOX_SERVICE_PATH, GearboxClient, GearboxService } from "../common/protocol";
import { CatalogueStore } from "./catalogue-store";
import { RevealService } from "./reveal-service";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import {
  CatalogueViewContribution,
  DetailViewContribution,
  GraphViewContribution,
} from "./view-contributions";
import { GearDetailWidget } from "./detail/gear-detail-widget";
import { DepsGraphWidget } from "./graph/deps-graph-widget";
import { GdlLanguageContribution } from "./gdl/gdl-language-contribution";

import "../../src/browser/style/index.css";

export default new ContainerModule((bind) => {
  // Without this, `.gdl` opens as plaintext: nothing else in the app registers
  // the language with Monaco.
  bind(LanguageGrammarDefinitionContribution)
    .to(GdlLanguageContribution)
    .inSingletonScope();

  bind(CatalogueStore).toSelf().inSingletonScope();
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

  bind(CatalogueWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: CatalogueWidget.ID,
      createWidget: () => container.get<CatalogueWidget>(CatalogueWidget),
    }))
    .inSingletonScope();

  bind(GearDetailWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: GearDetailWidget.ID,
      createWidget: () => container.get<GearDetailWidget>(GearDetailWidget),
    }))
    .inSingletonScope();

  bind(DepsGraphWidget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: DepsGraphWidget.ID,
      createWidget: () => container.get<DepsGraphWidget>(DepsGraphWidget),
    }))
    .inSingletonScope();

  bindViewContribution(bind, CatalogueViewContribution);
  bind(FrontendApplicationContribution).toService(CatalogueViewContribution);
  bind(CommandContribution).toService(CatalogueViewContribution);

  bindViewContribution(bind, DetailViewContribution);
  bind(FrontendApplicationContribution).toService(DetailViewContribution);
  bind(CommandContribution).toService(DetailViewContribution);

  bindViewContribution(bind, GraphViewContribution);
  bind(CommandContribution).toService(GraphViewContribution);
});
