// `File`: open a product, reopen a recent one, close the open one.
//
// In `File` rather than under `Gearbox`, because these are the verbs that decide
// *what* is being worked on -- the same place a person looks for them in every
// other application. `Gearbox` holds the verbs that act on what is already open.
//
// `New Product` is absent, and that is a decision rather than an omission: it
// needs a skeleton -- which sources, which profiles, what the first `product.gdl`
// says -- and a menu entry promising a product it cannot create is worse than no
// entry. `Open` and `Recent` are what work today, so they are what is offered.
//
// `Close` is under the same `when` clause as the Product menu: with nothing open
// there is nothing to close, and an always-visible `Close Product` that reports
// "no product open" is a control that exists to say no.

import { CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import { FILE_PRODUCT } from "../menus";
import { ProductStore } from "../product-store";
import { ProductSessionService } from "./product-session-service";
import { STUDIO_CONTEXT_KEY } from "./studio-context-service";

export const OPEN_PRODUCT = {
  id: "gearbox.product.open",
  label: "Gearbox: Open Product…",
};

export const CLOSE_PRODUCT = {
  id: "gearbox.product.close",
  label: "Gearbox: Close Product",
};

@injectable()
export class SessionCommands implements CommandContribution, MenuContribution {
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(OPEN_PRODUCT, {
      execute: () => this.pick(),
    });
    commands.registerCommand(CLOSE_PRODUCT, {
      execute: () => void this.session.close(),
      isEnabled: () => this.products.current.open !== undefined,
    });
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(FILE_PRODUCT, {
      commandId: OPEN_PRODUCT.id,
      label: "Open Product…",
      order: "1",
    });
    menus.registerMenuAction(FILE_PRODUCT, {
      commandId: CLOSE_PRODUCT.id,
      label: "Close Product",
      order: "3",
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });
  }

  /**
   * Offer what can be opened: the products found, and the ones opened before.
   *
   * One list rather than two menus. A person looking for a product does not care
   * whether it was discovered or remembered, and the label says which so that the
   * distinction is available without being structural.
   *
   * Discovery runs first because a session that has just started has no list yet,
   * and offering only Recent would hide every product in the workspace.
   */
  protected async pick(): Promise<void> {
    await this.products.ensureDiscovered();
    const found = this.products.current.products;
    const recent = await this.session.recent();

    const items = [
      ...found.map((ref) => ({ label: ref.label, description: ref.path, ref, remembered: false })),
      ...recent
        .filter((ref) => !found.some((f) => f.path === ref.path))
        .map((ref) => ({
          label: ref.label,
          description: `${ref.path} (recent)`,
          ref,
          remembered: true,
        })),
    ];

    if (items.length === 0) {
      // Said rather than shown as an empty list, which reads as a failure to load.
      this.quickInput.showQuickPick(
        [{ label: "No products found", description: "nothing in the workspace declares a product" }],
        { placeholder: "Open Product" },
      );
      return;
    }

    const chosen = await this.quickInput.showQuickPick(items, {
      placeholder: "Open Product",
    });
    if (chosen === undefined) return;
    // A remembered path may have rotted, and `openRecent` is what forgets it.
    await (chosen.remembered ? this.session.openRecent(chosen.ref) : this.session.open(chosen.ref));
  }
}
