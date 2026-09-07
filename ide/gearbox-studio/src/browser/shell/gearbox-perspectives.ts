// Three layouts, and nothing more. Which one is active is decided elsewhere, and
// so is what comes forward inside it.
//
// This file used to also *be* the context: two perspectives, Catalogue and
// Product, switched by buttons in the toolbar. ADR-0011's own revisit clause
// called that a cheap mistake to correct, and it was made: the words duplicated
// two Gearbox menu entries while meaning something else. Perspectives now only
// arrange panels, and `StudioContextService` decides which arrangement applies --
// because a perspective can be restored from a saved layout with no domain object
// behind it, and a menu keyed off that would offer product actions with no product.
//
// **And they no longer activate anything, which is the 2026-09-08 change.** Each
// `onActivate` used to open its context's primary view, guarded on the context
// so it could decline. The guard was not the problem; being a second owner was.
// `onActivate` is fire-and-forget and its chain is slow in a way nothing here can
// see -- `ApplicationShell.activateWidget` waits on `waitForRevealed` (polls, no
// timeout) and `waitForActivation` (2.25 s) -- so a switch's activation could
// land seconds after the interaction that started it, measured at 2.5 s, long
// enough to bring Home in front of a product opened in the meantime and then the
// product in front of the Add Gear panel. `ScreenScopeService.reassertPrimary`
// now does that job once, after the layout has settled, through the contribution
// that owns each view's "may I take the front" rule.
//
// `viewPlacements` stays empty for a related reason: `applyViewPlacements` does
// not only place, it `activateWidget`s every entry inside the switch's own
// promise chain. Every widget already declares its area in
// `defaultWidgetOptions`, so an empty map changes no placement --
// `WidgetAreaResolverImpl.resolveArea` returns `undefined` and
// `ApplicationShell.resolveWidgetArea` keeps the requested area.
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


@injectable()
export class GearboxPerspectives implements PerspectiveContribution {
  registerPerspectives(service: PerspectiveService): void {
    service.registerPerspective({
      id: HOME_PERSPECTIVE,
      label: "Home",
      viewPlacements: new Map<string, ApplicationShell.Area>(),
    });
    service.registerPerspective({
      id: PRODUCT_PERSPECTIVE,
      label: "Product",
      viewPlacements: new Map<string, ApplicationShell.Area>(),
      // The catalogue is a source of components, not the subject of this context.
      // Collapsing rather than closing: it stays one click away, and the Explorer
      // and git fold with it.
      //
      // Due to be replaced by the per-context layout preset, and **not removed
      // ahead of it**: `collapseAreas` applies on a perspective's first
      // activation only (`perspective-service.js:130-144` runs the chrome loop in
      // the branch where no saved layout exists), so it is already a no-op for
      // anyone returning to a context they have visited -- but removing it before
      // the preset exists would leave the first visit uncollapsed as well, which
      // is a regression on the way to a fix.
      chromeOptions: { collapseAreas: ["left"] },
    });
    service.registerPerspective({
      id: GEAR_PERSPECTIVE,
      label: "Gear",
      viewPlacements: new Map<string, ApplicationShell.Area>(),
      chromeOptions: { collapseAreas: ["left"] },
    });
  }
}
