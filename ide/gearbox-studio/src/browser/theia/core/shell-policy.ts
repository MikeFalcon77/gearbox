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

import { CommonMenus } from "@theia/core/lib/browser/common-menus";
import { QuickViewService } from "@theia/core/lib/browser/quick-input/quick-view-service";
import { CommandRegistry } from "@theia/core/lib/common/command";
import {
  CompoundMenuNode,
  MAIN_MENU_BAR,
  MenuContribution,
  MenuModelRegistry,
  MenuNode,
  MenuPath,
  RenderedMenuNode,
} from "@theia/core/lib/common/menu";
import { injectable, inject } from "@theia/core/shared/inversify";

import { GearboxMenus, VIEW_ADVANCED } from "../../menus";
import { STUDIO_CONTEXT_KEY, StudioContextService } from "../../shell/studio-context-service";

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
  // `outlineView`, and **not** `outlineView.`: the commands are
  // `outlineView.collapse.all` but the toggle is `outlineView:toggle`, so the dot
  // matched the two that did not matter and missed the one that did. Third time a
  // separator has been guessed in this list; read them out of the package.
  "outlineView",
  // `@theia/console`, which is the debug console's widget and arrives with it.
  "console.",
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
  // The `Plugins` view: a list of the VS Code extensions the plugin host has
  // deployed. There is exactly one, and it is git, which is here so the Explorer
  // can show what changed. A window onto the machinery is not one of the two
  // things this application is about, and it was taking a slot in the left bar.
  //
  // The host stays -- git needs it. Only its shop window goes.
  "pluginsView",
];

/**
 * Families that stay, even though they are Theia's rather than the domain's.
 *
 * ADR-0011 keeps the editor, the Explorer and git on purpose: the work ends in
 * generated crates a person will want to read, diff and build. Listed here so that
 * "kept" is a decision on the page next to "removed", rather than the accident of
 * not having written a prefix down.
 *
 * The terminal used to be on this list and has moved to the other one.
 *
 * `search` is on it, and yesterday a comment here said the opposite -- that
 * `@theia/search-in-workspace` was not installed. It is: the frontend loads it
 * (`browser-app/src-gen/frontend/index.js`), along with twenty-nine other Theia
 * modules. The mistake came from checking `node_modules` for one file rather than
 * the generated module list, which is the only place that says what this
 * application actually loads. Search stays, one level down with the Explorer.
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
 */
export const ADVANCED_VIEWS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "fileNavigator:toggle", label: "Explorer" },
  { id: "search-in-workspace.toggle", label: "Search" },
  { id: "scmView:toggle", label: "Source Control" },
  // Where a generated build prints, and where the engine's own log would go if it
  // were wired to one. A tool, and a rarely opened one.
  { id: "output:toggle", label: "Output" },
];

/**
 * The groups each top-level menu keeps, by **group id** rather than by command.
 *
 * Groups, because a command id is a moving target -- three of them in this file
 * had to be read out of the packages after a guess was wrong -- while the groups
 * are declared once in `@theia/core/lib/browser/common-menus.js` and are what the
 * menu is actually built from. Keeping a group keeps whatever Theia decides
 * belongs in it next year, which is the right default for `Save` and the wrong one
 * for `Open Workspace`; those live in groups of their own, so the distinction is
 * expressible.
 *
 * **File is the product's.** What a person opens here is a *product*, and the
 * workspace is an internal set of source roots that `ProductSessionService` owns
 * (ADR-0011, amendment). `Open Folder`, `Open Workspace` and `Open Recent
 * Workspace` therefore do not merely clutter: they offer to change something the
 * session decides, behind the session's back.
 *
 * `3_save` stays because a description is edited in the editor and
 * `ProductEditService` refuses to write under an unsaved buffer -- without `Save`
 * that refusal is a dead end. `5_settings` stays: themes and preferences are about
 * the tool. `6_close` stays: an editor that opened has to close.
 */
export const MENU_KEEP: readonly { readonly path: MenuPath; readonly groups: readonly string[] }[] = [
  {
    path: CommonMenus.FILE,
    groups: ["0_product", "3_save", "5_settings", "6_close"],
  },
  {
    // `0_primary` is the command palette and `Open View…`; `1_catalogue` is the
    // two acts on the gear catalogue; `2_views` holds the toggles, trimmed to the
    // domain's below; `9_advanced` is where the tools went.
    //
    // `1_catalogue` is ours, and it is here rather than under Product because
    // neither entry is a verb on a product: `Find Gear…` fills the Inspector from
    // the catalogue, and `Reload Catalogue` re-reads the source roots. They sat in
    // the Product menu, which is what made that menu look like it had things to
    // offer with no product open.
    path: CommonMenus.VIEW,
    groups: ["0_primary", "1_catalogue", "2_views", "9_advanced"],
  },
];

/**
 * Commands that stay in the menu bar even though their whole group does not, and
 * ones that go even though their group stays.
 *
 * Two exceptions, both worth the extra line. `Save All` sits in `3_save` beside
 * `Save`, and saving everything is a general-editor habit -- there is one
 * description open, and "all" invites the question of what else there was.
 * `New File…`'s submenu is registered at `['file','newFile']`, outside `1_file`
 * entirely, so trimming groups cannot reach it.
 */
export const MENU_DROP: readonly { readonly path: MenuPath; readonly id: string }[] = [
  { path: CommonMenus.FILE, id: "core.saveAll" },
  // `Save As...` shares `3_save` with `Save`. Saving a description under another
  // name makes a second description that no product names -- a file, not a
  // product, and the tool has nothing to say about it afterwards.
  { path: CommonMenus.FILE, id: "file.saveAs" },
  // `Close Workspace` shares `6_close` with `Close Editor`, and it is the same
  // mistake as `Open Workspace` in the other direction: the workspace is the
  // session's, and closing it behind the session's back leaves an engine pointing
  // at roots nobody can see.
  { path: CommonMenus.FILE, id: "workspace:close" },
];

/** A submenu that moves whole, label and all, into `View > Advanced Tools`. */
export const RELOCATED: readonly { readonly from: MenuPath; readonly label: string }[] = [
  // `Appearance` (toggle the bottom panel, the status bar, the menu bar,
  // maximise) and `Editor Layout` (four ways to split). Both are real, and both
  // are about the window rather than about the product.
  { from: CommonMenus.VIEW_APPEARANCE, label: "Appearance" },
];

/**
 * Views hidden from `Open View…`.
 *
 * The **fourth** surface, after the menu bar, every other menu, and the palette.
 * `AbstractViewContribution.registerCommands` registers each view with
 * `QuickViewService` (`view-contribution.js:114`), and that list is not built from
 * menus or from commands -- so a view removed from both was still one
 * `Open View…` away. `hideItem` takes a label, which is why these are labels.
 *
 * The pattern by now is unmistakable: every time a surface is discovered, it is
 * discovered because something suppressed everywhere else still showed up. There
 * is no reason to believe this is the last one, which is why the claims read what
 * is rendered rather than what was declared.
 */
export const HIDDEN_QUICK_VIEWS: readonly string[] = [
  "Plugins",
  // The Start screen. `AbstractViewContribution` registers a quick-view item for
  // every view whether or not it has a toggle command, so dropping the toggle left
  // it here -- the one place that reads neither menus nor commands, demonstrating
  // its own point.
  "Gearbox Studio",
  "Debug",
  "Debug Console",
  "Testing",
  "Test Runs",
  "Outline",
  "Timeline",
  "Notebook",
  "Call Hierarchy",
  "Type Hierarchy",
  "Bulk Edit",
];

@injectable()
export class ShellPolicy implements MenuContribution {
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(QuickViewService) protected readonly quickViews!: QuickViewService;
  // Read only, and only to know when the bar has to be rebuilt.
  @inject(StudioContextService) protected readonly contexts!: StudioContextService;

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
    this.hideQuickViews();

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

    // **The menu bar is rebuilt when the context changes, because nothing else
    // rebuilds it.** `BrowserMainMenuFactory.createMenuBar` refreshes on a
    // preference change, a keybinding change and a *menu model* change -- and not
    // on a context-key change (`browser-menu-plugin.js:45-54`). An open menu does
    // re-evaluate `when` and `isEnabled` as it opens, which is why the entries
    // inside `Product` were always correct; the top-level label was not, because
    // its enabled state is decided when the bar is built. So with no product open
    // at boot the label was right, and it stayed right after a product opened --
    // which is the same staleness the UX pass saw from the other side, when every
    // entry was ungated and the label was always live.
    //
    // A throwaway registration is the trigger: the registry has no public
    // "refresh", and `registerMenuAction` fires `onDidChange` for its path. Two
    // events per context switch, which happens when a person opens or closes a
    // product -- exactly when a rebuild is wanted.
    this.contexts.onDidChange(() => {
      const touch = registry.registerMenuAction([...GearboxMenus.GEARBOX, "0_refresh"], {
        commandId: "gearbox.context.refresh.noop",
        label: "",
      });
      touch.dispose();
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
    this.relocate(registry);
    this.trim(registry);
  }

  /**
   * Keep the declared groups of each top-level menu, and nothing else.
   *
   * A whitelist again, and for the reason the head of this file gives: every Theia
   * upgrade and every transitive package adds entries nobody chose, and `File`
   * offering `Open Workspace` is what that looks like in a tool whose documents are
   * products.
   *
   * Scoped removals -- `unregisterMenuAction(id, path)` searches only that menu's
   * subtree (`menu-model-registry.js:197`). That matters here in a way it did not
   * for the forbidden families: `Save` is in `File` *and* in the editor's context
   * menu, and only the first is this method's business.
   *
   * Runs after `relocate`, so a group that has moved is already gone from its old
   * home and its removal here is a no-op rather than a race between the two.
   */
  protected trim(registry: MenuModelRegistry): void {
    for (const { path, groups } of MENU_KEEP) {
      const menu = registry.getMenu(path);
      if (menu === undefined) continue;
      for (const child of [...menu.children]) {
        const id = child.id;
        if (id !== undefined && !groups.includes(id)) {
          registry.unregisterMenuAction(id, path);
        }
      }
    }
    for (const { path, id } of MENU_DROP) {
      registry.unregisterMenuAction(id, path);
    }
  }

  /**
   * Move a submenu, whole, into `View > Advanced Tools`.
   *
   * Theia has no "move": a menu node belongs to the parent that registered it. So
   * this takes a **snapshot** of the subtree, removes the original, and registers
   * the snapshot one level down -- in that order, and the order is the whole
   * difference between working and not.
   *
   * Copying first and removing second is what the obvious version does, and it
   * silently undid itself: `unregisterMenuAction(id, path)` removes every node
   * with that id **anywhere in that path's subtree**
   * (`menu-model-registry.js:202`), and `Advanced Tools` is inside `View`. So
   * removing `1_appearance` from `View` also removed the `1_appearance` that had
   * just been registered under `View > Advanced Tools`. The probe said the source
   * had two children and the destination stayed empty, which is what that looks
   * like from outside.
   *
   * A snapshot is plain data, so nothing the registry does afterwards can reach
   * it. What it carries is what `MenuNode` exposes -- label, icon, `when`, order --
   * and nothing else; anything else a node knows is lost in the move, which is why
   * only declared submenus travel and why a claim reads the result.
   */
  protected relocate(registry: MenuModelRegistry): void {
    for (const { from } of RELOCATED) {
      const source = registry.getMenu(from);
      const id = from[from.length - 1];
      if (source === undefined || id === undefined) continue;

      const taken = snapshot(source);
      registry.unregisterMenuAction(id, from.slice(0, -1));
      this.replant(registry, taken, [...VIEW_ADVANCED, id]);
    }
  }

  /**
   * Register a snapshot under `target`.
   *
   * A **group** -- a compound node with no label -- becomes a path segment and
   * nothing more, which is what a group is: `registerSubmenu` on one would turn
   * `3_appearance_submenu_bar` into a menu item spelling its own id. A **submenu**
   * -- a compound node that has a label -- is registered as one.
   */
  protected replant(registry: MenuModelRegistry, node: Snapshot, target: MenuPath): void {
    if (node.children !== undefined) {
      if (node.label !== undefined) {
        registry.registerSubmenu(target, node.label);
      }
      for (const child of node.children) {
        this.replant(registry, child, [...target, child.id]);
      }
      return;
    }
    registry.registerMenuAction(target.slice(0, -1), {
      commandId: node.id,
      label: node.label,
      icon: node.icon,
      when: node.when,
      order: node.order,
    });
  }

  /**
   * Hide from `Open View…` what the menus and the palette no longer offer.
   *
   * `QuickViewService` is its own registry, filled by every
   * `AbstractViewContribution` (`view-contribution.js:114`), and it reads neither
   * menus nor commands. Suppressing a view everywhere else and leaving this list
   * alone is how `Plugins` would have stayed one `Open View…` away -- the same
   * shape of miss as the palette, one surface further along.
   */
  protected hideQuickViews(): void {
    for (const label of HIDDEN_QUICK_VIEWS) {
      this.quickViews.hideItem(label);
    }
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

/**
 * A menu subtree as plain data.
 *
 * Plain because the registry is about to be told to forget the nodes this came
 * from, and a live node would go with them. `children` is what distinguishes a
 * compound node from an action: `undefined` means an action, present means a group
 * or a submenu, and `label` then distinguishes those two.
 */
interface Snapshot {
  readonly id: string;
  readonly label?: string;
  readonly icon?: string;
  readonly when?: string;
  readonly order: string;
  readonly children?: readonly Snapshot[];
}

function snapshot(node: MenuNode): Snapshot {
  const rendered = RenderedMenuNode.is(node) ? node : undefined;
  const base = {
    id: node.id,
    label: rendered?.label,
    icon: rendered?.icon,
    when: node.when,
    order: node.sortString,
  };
  return CompoundMenuNode.is(node)
    ? { ...base, children: node.children.map(snapshot) }
    : base;
}

/** The ids of the menu bar's direct children. */
function topLevelIds(bar: CompoundMenuNode): string[] {
  return bar.children.map((child) => child.id).filter((id): id is string => id !== undefined);
}
