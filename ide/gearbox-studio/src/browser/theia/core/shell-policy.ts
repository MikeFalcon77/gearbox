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

import { GearboxMenus } from "../../menus";
import { STUDIO_CONTEXT_KEY } from "../../shell/studio-context-service";

/**
 * Top-level menus this application has.
 *
 * `7_terminal` is absent: a terminal is a tool, not one of the two things this
 * application is about, and it moves under `View`. Its commands survive -- see
 * `KEPT_COMMAND_PREFIXES` -- so nothing is taken away, only demoted.
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
];

/**
 * Families that stay, even though they are Theia's rather than the domain's.
 *
 * ADR-0011 keeps the editor, the Explorer, Search, git and the terminal on
 * purpose: the work ends in generated crates a person will want to read, diff and
 * build. Listed here so that "kept" is a decision on the page next to "removed",
 * rather than the accident of not having written a prefix down.
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
  "terminal:",
  "terminal.",
  "editor.",
  "monaco.",
  "problems.",
  "preferences",
  "gearbox.",
];

@injectable()
export class ShellPolicy implements MenuContribution {
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  /** Guards the re-prune against the change event its own removals emit. */
  protected pruning = false;

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

    this.prune(registry);

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
