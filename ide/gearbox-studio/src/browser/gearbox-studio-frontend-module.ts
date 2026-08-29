// Frontend wiring: the views, two stores, one proxied service.

import { FrontendApplicationContribution, bindViewContribution } from "@theia/core/lib/browser";
import { WebSocketConnectionProvider } from "@theia/core/lib/browser/messaging";
import { CommandContribution } from "@theia/core/lib/common";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule } from "@theia/core/shared/inversify";
import { DebugFrontendApplicationContribution } from "@theia/debug/lib/browser/debug-frontend-application-contribution";
import { MonacoEditorProvider } from "@theia/monaco/lib/browser/monaco-editor-provider";
import { TestViewContribution } from "@theia/test/lib/browser/view/test-view-contribution";
import { WorkspaceTrustService } from "@theia/workspace/lib/browser/workspace-trust-service";
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";

import { GEARBOX_SERVICE_PATH, GearboxClient, GearboxService } from "../common/protocol";
import { CatalogueStore } from "./catalogue-store";
import { ProductStore } from "./product-store";
import { ResolutionMarkers } from "./resolution-markers";
import { bindWidget } from "./contribution";
import { HiddenDebugView } from "./theia/debug/hidden-debug-view";
import { MenuNarrowing } from "./theia/core/menu-narrowing";
import { ReadOnlyLockEditorProvider } from "./theia/monaco/read-only-lock-editor-provider";
import { DomainWorkspace } from "./theia/workspace/domain-workspace";
import { StudioWorkspaceTrustService } from "./theia/workspace/studio-workspace-trust-service";
import { HiddenTestView } from "./theia/test/hidden-test-view";
import { RevealService } from "./reveal-service";
import { CatalogueWidget } from "./catalogue/catalogue-widget";
import {
  CatalogueViewContribution,
  DetailViewContribution,
  ExplainViewContribution,
  GraphViewContribution,
  LockViewContribution,
  ProductViewContribution,
} from "./view-contributions";
import { GearDetailWidget } from "./detail/gear-detail-widget";
import { DepsGraphWidget } from "./graph/deps-graph-widget";
import { ExplainWidget } from "./explain/explain-widget";
import { LockWidget } from "./lock/lock-widget";
import { ProductWidget } from "./product/product-widget";
import { GdlLanguageContribution } from "./gdl/gdl-language-contribution";

import "../../src/browser/style/index.css";

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // Without this, `.gdl` opens as plaintext: nothing else in the app registers
  // the language with Monaco.
  bind(LanguageGrammarDefinitionContribution)
    .to(GdlLanguageContribution)
    .inSingletonScope();

  // The first rebind in this application, so the discipline ADR 0011 asks for
  // starts here: every rebind says why in place. Arduino IDE's frontend module is
  // a thousand lines of these and is readable only because each one is justified
  // where it sits.
  //
  // Why: `product.lock` must open read-only (`cpt-gearbox-fr-lock-read-only`),
  // and `MonacoEditorProvider.createMonacoEditorOptions` is the only hook that
  // can say so for one filename rather than for a whole URI scheme. The subclass
  // explains the two alternatives it rejected.
  rebind(MonacoEditorProvider).to(ReadOnlyLockEditorProvider).inSingletonScope();

  // Why: `@theia/debug` and `@theia/test` arrive with `@theia/plugin-ext`, which
  // needs them for the VS Code debug and testing APIs, and both open a panel in
  // the left bar on first run. A product resolves; it does not execute, and there
  // is no test explorer for gears. `initializeLayout(): NOOP` keeps the package,
  // the command and the keybinding and changes only the default layout, so a
  // saved layout is still respected and the view is one command away.
  rebind(DebugFrontendApplicationContribution).to(HiddenDebugView).inSingletonScope();
  rebind(TestViewContribution).to(HiddenTestView).inSingletonScope();

  // Why: opening a multi-root workspace makes Theia generate
  // `~/.theia/workspaces/Untitled-NN.theia-workspace`, and its own trust check
  // then demands that *that* file be inside a trusted folder -- so the
  // application starts behind a modal dialog that no trusted-folders setting can
  // dismiss. The subclass drops Theia's own bookkeeping file from the set and
  // leaves the folder rules alone.
  rebind(WorkspaceTrustService).to(StudioWorkspaceTrustService).inSingletonScope();

  bind(CatalogueStore).toSelf().inSingletonScope();
  // Its own store, not a slice of the catalogue's: the two objects of work do not
  // subordinate one another, and their lifecycles differ -- the catalogue loads
  // once and streams, a product is re-resolved on every profile switch.
  bind(ProductStore).toSelf().inSingletonScope();
  bind(RevealService).toSelf().inSingletonScope();
  bind(GearboxClient).toService(CatalogueStore);

  // `@theia/markers` has been a declared dependency and unused since the shell
  // was built. This is what finally uses it: every resolution replaces the
  // Gearbox markers in the Problems view, which is where
  // `cpt-gearbox-fr-editor-diagnostics` says a resolution diagnostic has to end
  // up. Bound as an application contribution because it needs constructing --
  // nothing injects it -- and `onStart` is where it subscribes.
  bind(ResolutionMarkers).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ResolutionMarkers);

  // Opens the directories Studio already knows it works on. Without a workspace
  // the Explorer is empty, a generated `product.lock` cannot be opened at all,
  // and the VS Code git extension finds no repositories -- three failures that
  // none of them look like "no workspace".
  bind(DomainWorkspace).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(DomainWorkspace);

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
  bindWidget(bind, ExplainWidget);
  bindWidget(bind, LockWidget);

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

  bindViewContribution(bind, ExplainViewContribution);
  bind(CommandContribution).toService(ExplainViewContribution);
  bind(MenuContribution).toService(ExplainViewContribution);

  bindViewContribution(bind, LockViewContribution);
  bind(CommandContribution).toService(LockViewContribution);
  bind(MenuContribution).toService(LockViewContribution);
});
