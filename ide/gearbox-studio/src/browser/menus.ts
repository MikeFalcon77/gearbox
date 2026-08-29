// Every menu path in one place, and the two helpers removal needs.
//
// Collected rather than scattered because a menu path is a string array whose
// last element is a node id, and the same id appearing in two files is how a
// removal silently stops matching. Arduino IDE keeps one `arduino-menus.ts` for
// exactly this reason.

import { MAIN_MENU_BAR, MenuModelRegistry } from "@theia/core/lib/common/menu";
import type { MenuPath } from "@theia/core/lib/common/menu";

export namespace GearboxMenus {
  /**
   * The domain menu, between Edit (`2_`) and View (`4_`).
   *
   * Slot `3_` is the one Monaco's Selection menu occupies, and Selection is
   * removed -- so this takes the place a general editor would have used, which
   * is the whole point of the exercise.
   */
  export const GEARBOX: MenuPath = [...MAIN_MENU_BAR, "3_gearbox"];

  /** Reload the catalogue, validate: things that read. */
  export const GEARBOX_INSPECT: MenuPath = [...GEARBOX, "1_inspect"];
  /** Resolve, explain: things that compute. */
  export const GEARBOX_RESOLVE: MenuPath = [...GEARBOX, "2_resolve"];
  /** Restart the engine: things that act on the tool itself. */
  export const GEARBOX_ENGINE: MenuPath = [...GEARBOX, "9_engine"];
}

/**
 * Top-level menus this application removes, by node id.
 *
 * Both come from packages the editor needs, which is why removing the package
 * is not an option: Selection is contributed by `@theia/monaco` and Go by
 * `@theia/editor`. Neither has anything to do with composing gears.
 *
 * The ids are the last path segment, verified against the contributing source:
 * `monaco-menu.js` registers `[...MAIN_MENU_BAR, '3_selection']`,
 * `editor-menu.js` registers `[...MAIN_MENU_BAR, '5_go']`, and
 * `debug-commands.js` registers `[...MAIN_MENU_BAR, '6_debug']` -- which the menu
 * bar labels "Run".
 */
export const REMOVED_TOP_LEVEL_MENUS: readonly string[] = [
  "3_selection",
  "5_go",
  // Rendered as "Run". Contributed by `@theia/debug`, which arrives with
  // `@theia/plugin-ext` rather than by choice, and there is nothing here to run
  // or debug: a product resolves, it does not execute. The package stays -- the
  // plugin host needs it for the VS Code debug API -- and only its presentation
  // goes, which is the same trade as `HiddenDebugView`.
  "6_debug",
];

/**
 * Remove a node from a menu, by id.
 *
 * Theia 1.75 has no `unregisterSubmenu`. `unregisterMenuAction` reaches a
 * submenu anyway, because removal matches on node id regardless of node kind --
 * but **the path argument is not optional in practice**: it defaults to the
 * root and then removes every match in the entire tree, which for a common id
 * would take unrelated entries with it.
 */
export function removeMenuNode(
  registry: MenuModelRegistry,
  parent: MenuPath,
  id: string,
): void {
  registry.unregisterMenuAction(id, parent);
}
