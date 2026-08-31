// Frontend wiring: the views, two stores, one proxied service.

import { FrontendApplicationContribution, bindViewContribution } from "@theia/core/lib/browser";
import { PerspectiveContribution } from "@theia/core/lib/browser/perspective-service";
import { WebSocketConnectionProvider } from "@theia/core/lib/browser/messaging";
import { MenuContribution } from "@theia/core/lib/common/menu";
import { ContainerModule } from "@theia/core/shared/inversify";
import { DebugFrontendApplicationContribution } from "@theia/debug/lib/browser/debug-frontend-application-contribution";
import { MonacoEditorProvider } from "@theia/monaco/lib/browser/monaco-editor-provider";
import { TestViewContribution } from "@theia/test/lib/browser/view/test-view-contribution";
import { WorkspaceTrustService } from "@theia/workspace/lib/browser/workspace-trust-service";
import { LanguageGrammarDefinitionContribution } from "@theia/monaco/lib/browser/textmate/textmate-contribution";

import { GEARBOX_SERVICE_PATH, GearboxClient, GearboxService } from "../common/protocol";
import { CatalogueStore } from "./catalogue-store";
import { GenerateService } from "./generate/generate-service";
import { ProductEditService } from "./product-edit-service";
import { ProductStore } from "./product-store";
import { ResolutionMarkers } from "./resolution-markers";
import { bindWidget } from "./contribution";
import { HiddenDebugView } from "./theia/debug/hidden-debug-view";
import { ShellPolicy } from "./theia/core/shell-policy";
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
  GenerateViewContribution,
  GraphViewContribution,
  LockViewContribution,
  ProductViewContribution,
} from "./view-contributions";
import { GearDetailWidget } from "./detail/gear-detail-widget";
import { GraphWidget } from "./graph/graph-widget";
import { ExplainWidget } from "./explain/explain-widget";
import { GenerateWidget } from "./generate/generate-widget";
import { LockWidget } from "./lock/lock-widget";
import { ProductWidget } from "./product/product-widget";
import { GdlLanguageContribution } from "./gdl/gdl-language-contribution";
import { FabricThemeContribution } from "./theme/fabric-theme-contribution";
import { GearboxPerspectives } from "./shell/gearbox-perspectives";
import { ProductSessionService } from "./shell/product-session-service";
import { StudioContextService } from "./shell/studio-context-service";
import { ToolbarContribution } from "./shell/toolbar-contribution";
import { ToolbarWidget } from "./shell/toolbar-widget";

import "../../src/browser/style/index.css";
import "../../src/browser/theme/fabric-fonts.css";

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  // Without this, `.gdl` opens as plaintext: nothing else in the app registers
  // the language with Monaco.
  bind(LanguageGrammarDefinitionContribution)
    .to(GdlLanguageContribution)
    .inSingletonScope();

  // Why: Gearbox Studio is a Constructor Fabric product. The color theme, fonts
  // and favicon come from constructorfabric.org tokens, registered natively
  // (not as a VS Code theme extension) so they ship with the extension and do
  // not depend on `download:plugins`.
  bind(FabricThemeContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(FabricThemeContribution);

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
  // The policy in front of a description edit: a product must be open, its file
  // must have no unsaved changes, the engine must agree, and the person must
  // confirm. A service rather than a widget handler, so the next widget that
  // wants to edit does not reimplement the four checks.
  bind(ProductEditService).toSelf().inSingletonScope();
  // The policy in front of Apply: generate advertised, writes declared, no
  // resolution errors, no conflicts. Named in the UI when they fail.
  bind(GenerateService).toSelf().inSingletonScope();
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

  // Why: what Studio is working on drives the shell, and it has to be derived
  // from what is actually open rather than from a restored layout -- a
  // perspective can come back from a saved snapshot with no product behind it,
  // and a Product menu keyed off that would offer actions with nothing to act
  // on. `StudioContextService` owns the context; perspectives only arrange
  // panels. ADR-0011's own revisit clause asked for this collapse.
  // Why: opening a product decides where the engine looks and where it may
  // write. The backend used to fix both, which made "open a product" mean "open
  // one of the products in this checkout" -- readable anywhere, editable nowhere
  // else, because both write gates measure from the declared workspace.
  bind(ProductSessionService).toSelf().inSingletonScope();

  bind(StudioContextService).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(StudioContextService);

  bind(GearboxPerspectives).toSelf().inSingletonScope();
  bind(PerspectiveContribution).toService(GearboxPerspectives);

  // Why: the switch and the two domain actions belong on the shell, not on a
  // view. `@theia/toolbar` is a user-configurable bar with its own JSON, which
  // is the opposite of the narrowing ADR-0011 is for. A widget in `top` is
  // what `BrowserMenuBarContribution` already does for the menu.
  bind(ToolbarWidget).toSelf().inSingletonScope();
  bind(ToolbarContribution).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toService(ToolbarContribution);

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
        onEngineExit: (reason) => container.get(CatalogueStore).onEngineExit(reason),
      };
      return provider.createProxy<GearboxService>(GEARBOX_SERVICE_PATH, forwarder);
    })
    .inSingletonScope();

  // Bound before the view contributions so it runs last among menu
  // contributions: pruning only works on a tree the contributors have already
  // filled. It also re-prunes on `onDidChange`, because plugin contributions
  // arrive after startup and a one-shot prune is correct only until the first
  // extension activates.
  bind(ShellPolicy).toSelf().inSingletonScope();
  bind(MenuContribution).toService(ShellPolicy);

  bindWidget(bind, CatalogueWidget);
  bindWidget(bind, GearDetailWidget);
  bindWidget(bind, GraphWidget);
  bindWidget(bind, ProductWidget);
  bindWidget(bind, ExplainWidget);
  bindWidget(bind, LockWidget);
  bindWidget(bind, GenerateWidget);

  // `bindViewContribution` already binds `CommandContribution`,
  // `KeybindingContribution` *and* `MenuContribution` -- see
  // `@theia/core/lib/browser/shell/view-contribution.js`. Binding any of them
  // again runs the contribution twice, and `MenuModelRegistry.registerMenuAction`
  // does not deduplicate: it makes a node and appends it. That is what put every
  // Gearbox entry, and every toggle under View > Views, in the menu twice.
  //
  // The command side failed more quietly. `CommandRegistry.registerCommand` on an
  // existing id logs "A command ... is already registered." and returns a no-op
  // disposable, so the *second* handler is discarded. Behaviour survived only
  // because the first registration wins.
  //
  // What still needs binding by hand is `FrontendApplicationContribution`, which
  // `bindViewContribution` does not touch -- and only for the two views that
  // implement something from it.
  bindViewContribution(bind, CatalogueViewContribution);
  bind(FrontendApplicationContribution).toService(CatalogueViewContribution);

  bindViewContribution(bind, DetailViewContribution);
  bind(FrontendApplicationContribution).toService(DetailViewContribution);

  bindViewContribution(bind, GraphViewContribution);

  // No `FrontendApplicationContribution` here: the Product view opens on request,
  // so it has nothing of that interface to implement.
  bindViewContribution(bind, ProductViewContribution);
  bindViewContribution(bind, ExplainViewContribution);
  bindViewContribution(bind, LockViewContribution);
  bindViewContribution(bind, GenerateViewContribution);
});
