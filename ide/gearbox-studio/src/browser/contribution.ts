// One base class for every Gearbox feature, and one line to bind it.
//
// Theia asks a feature to implement up to five separate contribution
// interfaces, and each has to be bound to its own symbol. Written out per
// feature that is six lines of DI in a shared module, and a shared module is
// the file every parallel change collides in. Arduino IDE solved this with a
// base class plus a `configure` helper before it wrote any feature, and the
// order matters: retrofitting it later means touching every feature again.
//
// The base implements all five as no-ops, so a feature overrides only what it
// actually contributes and the reader can see at a glance which of the five it
// is. The services every feature turned out to need are injected here rather
// than repeated: a command service to invoke, a message service to complain, a
// store to read, and the state service that `onReady` is built on.

import { FrontendApplicationContribution, WidgetFactory } from "@theia/core/lib/browser";
import { FrontendApplicationStateService } from "@theia/core/lib/browser/frontend-application-state";
import { KeybindingContribution, KeybindingRegistry } from "@theia/core/lib/browser/keybinding";
import { TabBarToolbarContribution } from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import type { TabBarToolbarRegistry } from "@theia/core/lib/browser/shell/tab-bar-toolbar";
import { CommandContribution, CommandRegistry, CommandService } from "@theia/core/lib/common";
import { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import type { interfaces } from "@theia/core/shared/inversify";

import { CatalogueStore } from "./catalogue-store";

@injectable()
export abstract class Contribution
  implements
    CommandContribution,
    MenuContribution,
    KeybindingContribution,
    TabBarToolbarContribution
{
  @inject(CommandService) protected readonly commands!: CommandService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(CatalogueStore) protected readonly store!: CatalogueStore;
  @inject(FrontendApplicationStateService)
  protected readonly appState!: FrontendApplicationStateService;

  /**
   * Called once the application has finished starting.
   *
   *
   * Distinct from `onStart`, which runs before the shell is attached -- a
   * distinction this project has already paid for once: a view opened from
   * `onStart` ended up collapsed with its widget still in the DOM, queryable
   * and invisible, and the UI check passed against a blank screen.
   *
   * The hook fires from `@postConstruct`, so it depends on the object having
   * been constructed at all. That is what the `FrontendApplicationContribution`
   * binding in `configure` is for: the interface itself is entirely optional
   * members, so there is nothing to implement, but Theia resolves every
   * contribution bound to it at startup and that resolution is what builds the
   * feature.
   */
  protected onReady(): void {
    // Nothing by default.
  }

  @postConstruct()
  protected init(): void {
    void this.appState.reachedState("ready").then(() => this.onReady());
  }

  registerCommands(_registry: CommandRegistry): void {
    // Nothing by default.
  }

  registerMenus(_registry: MenuModelRegistry): void {
    // Nothing by default.
  }

  registerKeybindings(_registry: KeybindingRegistry): void {
    // Nothing by default.
  }

  registerToolbarItems(_registry: TabBarToolbarRegistry): void {
    // Nothing by default.
  }
}

export namespace Contribution {
  /**
   * Bind one feature to all five contribution points.
   *
   * Binding all five unconditionally, rather than only the ones a feature
   * overrides, is deliberate: the alternative is a per-feature list that drifts
   * out of date silently the first time someone adds a `registerMenus` and
   * forgets to widen the binding. An empty contribution costs one call into a
   * no-op at startup.
   */
  export function configure(
    bind: interfaces.Bind,
    identifier: interfaces.Newable<Contribution> & interfaces.ServiceIdentifier<Contribution>,
  ): void {
    bind(identifier).toSelf().inSingletonScope();
    bind(CommandContribution).toService(identifier);
    bind(MenuContribution).toService(identifier);
    bind(KeybindingContribution).toService(identifier);
    bind(TabBarToolbarContribution).toService(identifier);
    bind(FrontendApplicationContribution).toService(identifier);
  }
}

/**
 * Bind a widget and the factory that builds it.
 *
 * The three-line `WidgetFactory` `toDynamicValue` shape is identical for every
 * widget and differs only in the class, so writing it out per widget puts three
 * near-identical blocks in the module that every parallel change edits. The
 * widget's own `ID` is the factory key, which keeps the two from drifting apart
 * -- a factory registered under a different id than its widget answers nothing
 * and reports nothing.
 */
export function bindWidget<T extends object>(
  bind: interfaces.Bind,
  widget: interfaces.Newable<T> & interfaces.ServiceIdentifier<T> & { readonly ID: string },
): void {
  bind(widget).toSelf();
  bind(WidgetFactory)
    .toDynamicValue(({ container }) => ({
      id: widget.ID,
      createWidget: () => container.get<T>(widget),
    }))
    .inSingletonScope();
}
