// `File`: open a product, reopen a recent one, close the open one.

import { CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import { inject, injectable } from "@theia/core/shared/inversify";

import { PendingCreate } from "../create/pending-create";
import { FILE_PRODUCT } from "../menus";
import { ProductStore } from "../product-store";
import { CreateProductViewContribution } from "../view-contributions";
import { ProductSessionService } from "./product-session-service";
import { CLOSE_PRODUCT, NEW_PRODUCT, OPEN_PRODUCT } from "./session-command-ids";
import { STUDIO_CONTEXT_KEY } from "./studio-context-service";

export { CLOSE_PRODUCT, NEW_PRODUCT, OPEN_PRODUCT } from "./session-command-ids";

@injectable()
export class SessionCommands implements CommandContribution, MenuContribution {
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
  @inject(CreateProductViewContribution) protected readonly create!: CreateProductViewContribution;
  @inject(PendingCreate) protected readonly pending!: PendingCreate;

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(NEW_PRODUCT, {
      execute: () => {
        const state = this.pending.state;
        this.pending.state = undefined;
        return void this.create.openCreate(state);
      },
    });
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
      commandId: NEW_PRODUCT.id,
      label: "New Product…",
      order: "0",
    });
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
    await (chosen.remembered ? this.session.openRecent(chosen.ref) : this.session.open(chosen.ref));
  }
}
