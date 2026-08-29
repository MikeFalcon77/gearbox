// Removing the menus a general-purpose editor contributes and this one does not
// want.
//
// Lives under `theia/` because that directory mirrors Theia's own package
// layout: an override sits at the path of the thing it overrides, so a reader
// looking for "what did we do to Theia's menus" finds it without searching.
// Arduino IDE uses the same arrangement across roughly seventy overrides, and it
// is the only reason a module that size stays navigable.
//
// This one does not subclass anything. It runs *after* the contributors because
// Theia calls every `MenuContribution` in binding order and ours is bound last,
// so `registerMenus` here sees a tree that already has Selection and Go in it.
// Subclassing `CommonFrontendContribution` and calling `super.registerMenus()`
// would be needed only to remove entries that `@theia/core` itself adds.

import { MAIN_MENU_BAR, MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { injectable } from "@theia/core/shared/inversify";

import { GearboxMenus, REMOVED_TOP_LEVEL_MENUS, removeMenuNode } from "../../menus";

@injectable()
export class MenuNarrowing implements MenuContribution {
  registerMenus(registry: MenuModelRegistry): void {
    for (const id of REMOVED_TOP_LEVEL_MENUS) {
      removeMenuNode(registry, MAIN_MENU_BAR, id);
    }

    // Registered here rather than alongside the commands that fill it, so the
    // menu exists even when a feature that would populate it is disabled.
    //
    // Note that Theia 1.75 *does* render an empty submenu: "Gearbox" is in the
    // menu bar today with nothing under it, and the conformance suite asserts
    // that exact bar. An earlier version of this comment claimed the opposite
    // and used it as the justification for registering the submenu separately.
    // The separation is still right -- a menu that appears when its first
    // command lands is worse than one that is always there -- but the cost is
    // not zero, and the empty dropdown is tracked as a `test.fixme`.
    registry.registerSubmenu(GearboxMenus.GEARBOX, "Gearbox");
  }
}
