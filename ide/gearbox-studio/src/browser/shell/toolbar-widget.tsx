// The shell-level toolbar: perspective switch plus the two domain actions.
//
// Each action is looked up in `CommandRegistry` -- label, icon, enablement --
// so this panel cannot name a command that does not exist and cannot drift
// from the Gearbox menu. The only thing duplicated is the list of ids, and
// that list is what the regression test reads.
//
// Actions are scoped to the active perspective, which is the honest reading
// of §9's `isVisible` on a panel that has no "own widget". There is no
// profile switch here: §9 keeps that in the Product header so it stays
// reachable while a resolution is in flight.

import { ReactWidget } from "@theia/core/lib/browser";
import { PerspectiveService } from "@theia/core/lib/browser/perspective-service";
import { CommandRegistry } from "@theia/core/lib/common";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import { ProductStore } from "../product-store";
import { RELOAD_CATALOGUE, RESOLVE_PRODUCT } from "../view-contributions";
import { CATALOGUE_PERSPECTIVE, PRODUCT_PERSPECTIVE } from "./gearbox-perspectives";

/**
 * Command ids the toolbar may invoke. Quoted here so the regression test can
 * read them the same way it reads codicon names -- from the source, not from
 * a running registry.
 */
export const TOOLBAR_COMMAND_IDS = [
  "gearbox.catalogue.reload",
  "gearbox.product.resolve",
] as const;

const ACTIONS: Readonly<Record<string, readonly string[]>> = {
  [CATALOGUE_PERSPECTIVE]: [RELOAD_CATALOGUE.id],
  [PRODUCT_PERSPECTIVE]: [RESOLVE_PRODUCT.id],
};

@injectable()
export class ToolbarWidget extends ReactWidget {
  static readonly ID = "gearbox.toolbar";

  @inject(PerspectiveService) protected readonly perspectives!: PerspectiveService;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
  @inject(ProductStore) protected readonly products!: ProductStore;

  @postConstruct()
  protected init(): void {
    this.id = ToolbarWidget.ID;
    this.title.closable = false;
    this.addClass("gearbox-toolbar");
    this.toDispose.push(this.perspectives.onDidChangePerspective(() => this.update()));
    this.toDispose.push(this.commands.onCommandsChanged(() => this.update()));
    // Resolve's enablement depends on a product being open, and that handler
    // does not fire `onDidChangeEnabled`. The store is the fact the handler
    // reads, so a change here is a change of the button.
    this.toDispose.push(this.products.onChanged(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const active = this.perspectives.getActivePerspectiveId();
    const actions = ACTIONS[active] ?? [];
    return (
      <div className="gbx-toolbar" data-active-perspective={active}>
        <div className="gbx-toolbar-switch" role="group" aria-label="Perspective">
          {this.perspectiveButton(CATALOGUE_PERSPECTIVE, "Catalogue", active)}
          {this.perspectiveButton(PRODUCT_PERSPECTIVE, "Product", active)}
        </div>
        <div className="gbx-toolbar-actions">
          {actions.map((id) => this.actionButton(id, id))}
        </div>
      </div>
    );
  }

  protected perspectiveButton(
    id: string,
    label: string,
    active: string,
  ): React.ReactNode {
    const on = active === id;
    const klass =
      id === PRODUCT_PERSPECTIVE ? "gbx-perspective-product" : "gbx-perspective-catalogue";
    return (
      <button
        type="button"
        className={`gbx-choice ${on ? "gbx-choice-on" : ""} ${klass}`}
        data-perspective={id}
        aria-pressed={on}
        onClick={() => void this.perspectives.switchPerspective(id)}
      >
        {label}
      </button>
    );
  }

  protected actionButton(id: string, key: string): React.ReactNode {
    const command = this.commands.getCommand(id);
    if (command === undefined) return undefined;
    const enabled = this.commands.isEnabled(id);
    return (
      <button
        key={key}
        type="button"
        className="gbx-choice"
        data-command={id}
        disabled={!enabled}
        title={command.label}
        onClick={() => void this.commands.executeCommand(id)}
      >
        {command.iconClass !== undefined && <span className={command.iconClass} />}
        {command.shortTitle ?? command.label ?? id}
      </button>
    );
  }
}
