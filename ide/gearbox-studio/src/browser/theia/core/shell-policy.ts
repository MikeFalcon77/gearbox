// What this application offers, declared as a list rather than as exceptions.
//
// The previous version removed three top-level menus by id -- Selection, Go and
// Run -- and left File, Edit, View, Terminal and Help as a general editor built
// them. That is a blacklist, and a blacklist loses: every Theia upgrade and every
// transitive package brings entries nobody chose, and `Type Hierarchy` in the
// bottom panel is what it looks like when one does.
//
// **A whitelist is required here, not merely preferred**, because half of
// ADR-0011's narrowing strategy cannot reach these packages.
// `typehierarchy`, `callhierarchy`, `notebook`, `timeline`, `bulk-edit`,
// `console` and `outline-view` all arrive through `@theia/plugin-ext`, which is
// present so the VS Code git extension can run. They cannot be dropped from the
// dependency set; they can only be suppressed.
//
// Three surfaces, because a menu entry is not the only way in:
//
//   1. the **menu bar** -- pruned to the allowed top-level set;
//   2. **every other menu**, including the editor's context menu, where Call
//      Hierarchy lives and where removing a top-level menu does nothing;
//   3. the **command palette and keybindings** -- reached by unregistering the
//      command itself, since a hidden view with a live command and a saved
//      keybinding is a view one keystroke away.
//
// And it runs again on `onDidChange`, because plugin contributions arrive after
// the frontend has started: a one-shot prune during `registerMenus` is correct
// only until the first extension activates.

import { CommandRegistry } from "@theia/core/lib/common/command";
import {
  CompoundMenuNode,
  MAIN_MENU_BAR,
  MenuContribution,
  MenuModelRegistry,
} from "@theia/core/lib/common/menu";
import { injectable, inject } from "@theia/core/shared/inversify";

import { GearboxMenus, VIEW_ADVANCED } from "../../menus";
import { STUDIO_CONTEXT_KEY } from "../../shell/studio-context-service";

/**
 * Top-level menus this application has.
 *
 * `7_terminal` is absent, and now so is everything behind it: the terminal was to
 * be demoted under `View`, and then it turned out not to work at all -- see
 * `FORBIDDEN_COMMAND_PREFIXES`. What does get demoted rather than removed is the
 * Explorer and git, into `View > Advanced Tools`.
 */
export const ALLOWED_TOP_LEVEL: readonly string[] = [
  "1_file",
  "2_edit",
  GearboxMenus.GEARBOX[GearboxMenus.GEARBOX.length - 1]!,
  "4_view",
  "9_help",
];

/**
 * Commands with no meaning in this domain, removed outright.
 *
 * Matched by prefix on the id, because these are families: `debug.` alone is
 * forty commands. Removing the command -- rather than hiding its view -- is what
 * takes it out of the command palette and disarms a saved keybinding, which is
 * the difference between suppressed and merely tidied.
 *
 * A gear is not run, and a `.gdl` file is not debugged: a product resolves. So
 * debugging, testing, notebooks, timelines and the two hierarchy views are not
 * "hidden for now", they are absent by decision.
 */
export const FORBIDDEN_COMMAND_PREFIXES: readonly string[] = [
  // Read out of the installed packages, not guessed. The first version of this
  // list said `typeHierarchy` and `callHierarchy` in camelCase and matched
  // nothing at all: the real ids are `typehierarchy:toggle` and
  // `callhierarchy:open`, lowercase. The conformance claim below is what caught
  // it, which is the argument for asserting the rendered menu rather than
  // trusting a list.
  "debug.",
  "debug:",
  "debug-console",
  // **`workbench.action.*`, and this is the second time a list of prefixes has
  // been wrong about the ids it was written for.** The first was camelCase
  // (`typeHierarchy` against a real `typehierarchy`); this one assumed every
  // command in a package shares the package's prefix. It does not: Theia gives its
  // VS Code-compatible commands VS Code's ids, so `Debug: Start Debugging` is
  // `workbench.action.debug.start` and `Terminal: Toggle Terminal` is
  // `workbench.action.terminal.toggleTerminal`. Both were still in the palette
  // after the sweep, and the new claim that reads the palette is what said so.
  //
  // Read out of the installed packages -- `@theia/debug` and `@theia/terminal`
  // between them are the only `workbench.action.*` families here apart from
  // `workbench.action.show*`, which belongs to core and stays.
  "workbench.action.debug",
  "workbench.action.terminal",
  // `Debug: Select and Start Debugging`, which is `select.debug.configuration` --
  // not under any of the three prefixes a reader would predict. Third id in this
  // list that had to be read out of the package rather than guessed, which is the
  // argument for the claim that reads the palette back.
  "select.debug.configuration",
  // A list of terminals is terminal surface. `workbench.action.show*` otherwise
  // belongs to core -- `showAllEditors` and the rest -- so this is named rather
  // than matched by a `show` prefix that would take the editor commands with it.
  "workbench.action.showAllTerminals",
  "testing.",
  "typehierarchy",
  "typeHierarchy",
  "callhierarchy",
  "callHierarchy",
  "references-view",
  "notebook.",
  "notebook:",
  "cellOutput.",
  "timeline-",
  "timeline.",
  "bulk-edit",
  "bulkEdit.",
  "outline-view",
  "outlineView.",
  // **The terminal, and this one is a withdrawal rather than a tidy-up.**
  // ADR-0011 kept a live shell in the bottom panel on purpose. It turned out that
  // the only terminal that ever worked was the one nobody asked for: with the boot
  // terminal suppressed, `Terminal: Create New Terminal` creates nothing at all --
  // measured by command and by keybinding, on a build with the suppression removed
  // (the boot terminal returns, creating still does nothing) and against
  // `node-pty` (present, and the boot terminal did attach a pty). So the promise
  // is withdrawn rather than left as a menu entry that does nothing.
  //
  // Suppressed and not removed: `@theia/terminal` is a dependency of
  // `@theia/plugin-ext`, `@theia/task` and `@theia/debug`, so it cannot leave the
  // dependency set -- the same reason the whitelist exists at all.
  "terminal:",
  "terminal.",
];

/**
 * Families that stay, even though they are Theia's rather than the domain's.
 *
 * ADR-0011 keeps the editor, the Explorer and git on purpose: the work ends in
 * generated crates a person will want to read, diff and build. Listed here so that
 * "kept" is a decision on the page next to "removed", rather than the accident of
 * not having written a prefix down.
 *
 * The terminal used to be on this list and has moved to the other one. Search is
 * absent from both because `@theia/search-in-workspace` is not installed, and a
 * prefix for a package that is not there would be a rule about nothing.
 */
export const KEPT_COMMAND_PREFIXES: readonly string[] = [
  "core.",
  "workspace.",
  "navigator.",
  "filesystem.",
  "file.",
  "search",
  "git.",
  "scm.",
  "editor.",
  "monaco.",
  "problems.",
  "preferences",
  "gearbox.",
];

/**
 * Views that stay, one level down.
 *
 * ADR-0011 keeps the Explorer and git because the work ends in generated crates
 * someone will read and diff. But they are *tools*, not one of the two things this
 * application is about, so they sit in a submenu instead of competing with the
 * domain's own views in a flat list.
 *
 * `AbstractViewContribution.registerMenus` puts every toggle in
 * `CommonMenus.VIEW_VIEWS`, so this is a move: unregister there, register here.
 * Search is not in the list because `@theia/search-in-workspace` is not installed
 * -- an entry for a package that is absent would be worse than no submenu.
 */
export const ADVANCED_VIEWS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "fileNavigator:toggle", label: "Explorer" },
  { id: "scmView:toggle", label: "Source Control" },
];

@injectable()
export class ShellPolicy implements MenuContribution {
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  /** Guards the re-prune against the change event its own removals emit. */
  protected pruning = false;

  /** The same guard for the command sweep, which also emits a change event. */
  protected sweeping = false;

  registerMenus(registry: MenuModelRegistry): void {
    // **Named after the task, not after the application.** `Gearbox` described
    // the tool; `Product` describes what the person is doing, which is the whole
    // point of the two contexts. And it is scoped: with nothing open there is no
    // Product menu, so the top level never offers verbs for a subject that is not
    // there. A `Gear` menu belongs beside it and is deliberately not registered
    // until the gear context works -- a menu promising what does not exist is
    // worse than a missing one.
    //
    // Registered here rather than beside the commands that fill it, so the menu
    // exists even when a feature that would populate it does not.
    registry.registerSubmenu(GearboxMenus.GEARBOX, "Product", {
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });

    // Declared before the prune, so the submenu exists when the moved entries are
    // registered into it. An empty submenu renders in Theia 1.75, which is why the
    // label is only registered when there is something to put under it.
    if (ADVANCED_VIEWS.length > 0) {
      registry.registerSubmenu(VIEW_ADVANCED, "Advanced Tools");
    }

    this.prune(registry);
    this.sweepCommands();

    // Plugin contributions arrive after startup. Without this, the first VS Code
    // extension to activate can put back anything the prune removed, and the
    // menu bar would be correct only until then.
    registry.onDidChange(() => {
      if (this.pruning) return;
      this.pruning = true;
      try {
        this.prune(registry);
      } finally {
        this.pruning = false;
      }
    });

    // And commands arrive late too, from the same place. A command registered
    // after startup is a command in the palette and a live keybinding, whether or
    // not any menu names it.
    this.commands.onCommandsChanged(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      try {
        this.sweepCommands();
      } finally {
        this.sweeping = false;
      }
    });
  }

  /**
   * Unregister the forbidden commands outright.
   *
   * The header of this file has always claimed that a forbidden command leaves the
   * palette and its keybinding goes dead. It did not: `prune` removes *menu*
   * nodes, and the palette does not read menus -- `QuickCommandService` filters
   * `commands.getAllCommands()` by `isVisible && isEnabled`
   * (`quick-command-service.js:191`). So a suppressed view was one `Ctrl+Shift+P`
   * away, and a saved keybinding still opened it.
   *
   * `CommandRegistry.unregisterCommand` disposes the registration, which is what
   * takes it out of `getAllCommands` -- and therefore out of the palette -- and
   * leaves any keybinding pointing at an id that no longer resolves.
   */
  protected sweepCommands(): void {
    for (const command of [...this.commands.commands]) {
      if (isForbidden(command.id)) {
        this.commands.unregisterCommand(command.id);
      }
    }
  }

  /**
   * Remove every top-level menu that is not declared, and every forbidden
   * command wherever it appears.
   */
  protected prune(registry: MenuModelRegistry): void {
    const bar = registry.getMenu(MAIN_MENU_BAR);
    if (bar !== undefined) {
      for (const id of topLevelIds(bar)) {
        if (!ALLOWED_TOP_LEVEL.includes(id)) {
          registry.unregisterMenuAction(id, MAIN_MENU_BAR);
        }
      }
    }

    // Not scoped to the menu bar: the same command sits in the editor's context
    // menu, and a top-level removal does not touch it. `unregisterMenuAction`
    // with no path removes every match in the whole tree, which is exactly what
    // is wanted for a command that should not exist anywhere.
    for (const command of this.commands.commands) {
      if (isForbidden(command.id)) {
        registry.unregisterMenuAction(command.id);
      }
    }

    this.demote(registry);
  }

  /**
   * Move the tools one level down, into `View > Advanced Tools`.
   *
   * Unregister-then-register rather than a `when` clause: the entry is not
   * conditional, it is somewhere else. Both calls are idempotent enough to run on
   * every re-prune -- `unregisterMenuAction` removes every match tree-wide, so the
   * second run removes the copy the first run made before putting it back, which
   * is why the registration follows rather than precedes it.
   */
  protected demote(registry: MenuModelRegistry): void {
    for (const view of ADVANCED_VIEWS) {
      if (this.commands.getCommand(view.id) === undefined) {
        // The package is not installed in this build. Registering an entry for a
        // command that does not exist would put a dead item in the menu.
        continue;
      }
      registry.unregisterMenuAction(view.id);
      registry.registerMenuAction(VIEW_ADVANCED, {
        commandId: view.id,
        label: view.label,
      });
    }
  }
}

/**
 * Whether a command id belongs to a forbidden family.
 *
 * `KEPT_COMMAND_PREFIXES` wins, so a kept family can start with a forbidden
 * fragment without being caught by it -- `test.` would otherwise sweep up
 * anything a future `testable.` command was called.
 */
export function isForbidden(id: string): boolean {
  if (KEPT_COMMAND_PREFIXES.some((prefix) => id.startsWith(prefix))) return false;
  return FORBIDDEN_COMMAND_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** The ids of the menu bar's direct children. */
function topLevelIds(bar: CompoundMenuNode): string[] {
  return bar.children.map((child) => child.id).filter((id): id is string => id !== undefined);
}
