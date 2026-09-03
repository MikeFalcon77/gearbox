// `File`: open a product or gear, reopen a recent one, close the open one.

import { CommandContribution, CommandRegistry } from "@theia/core/lib/common/command";
import { MenuContribution, MenuModelRegistry } from "@theia/core/lib/common/menu";
import { QuickInputService } from "@theia/core/lib/common/quick-pick-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { FileDialogService } from "@theia/filesystem/lib/browser";

import { PendingCreate } from "../create/pending-create";
import { PendingCreateGear } from "../create/pending-create-gear";
import { FILE_PRODUCT } from "../menus";
import { ProductStore } from "../product-store";
import { CreateGearViewContribution, CreateProductViewContribution } from "../view-contributions";
import { EngineConnectionService } from "./engine-connection-service";
import { GearSessionService } from "./gear-session-service";
import { ProductSessionService } from "./product-session-service";
import {
  CLOSE_GEAR,
  CLOSE_PRODUCT,
  NEW_GEAR,
  NEW_PRODUCT,
  OPEN_GEAR,
  OPEN_PRODUCT,
} from "./session-command-ids";
import { STUDIO_CONTEXT_KEY } from "./studio-context-service";

export {
  CLOSE_GEAR,
  CLOSE_PRODUCT,
  NEW_GEAR,
  NEW_PRODUCT,
  OPEN_GEAR,
  OPEN_PRODUCT,
} from "./session-command-ids";

@injectable()
export class SessionCommands implements CommandContribution, MenuContribution {
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(GearSessionService) protected readonly gears!: GearSessionService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(QuickInputService) protected readonly quickInput!: QuickInputService;
  @inject(CreateProductViewContribution) protected readonly create!: CreateProductViewContribution;
  @inject(CreateGearViewContribution) protected readonly createGear!: CreateGearViewContribution;
  @inject(PendingCreate) protected readonly pending!: PendingCreate;
  @inject(PendingCreateGear) protected readonly pendingGear!: PendingCreateGear;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService;

  registerCommands(commands: CommandRegistry): void {
    // `isEnabled` is re-queried when the registry fires `onCommandsChanged` and
    // when the toolbar / Start screen re-render on `engine.onDidChange`. Theia
    // does not watch the predicate itself.
    commands.registerCommand(NEW_PRODUCT, {
      execute: () => {
        const state = this.pending.state;
        this.pending.state = undefined;
        return void this.create.openCreate(state);
      },
      isEnabled: () => this.engine.isConnected,
    });
    commands.registerCommand(OPEN_PRODUCT, {
      execute: () => this.pick(),
    });
    commands.registerCommand(CLOSE_PRODUCT, {
      execute: () => void this.session.close(),
      isEnabled: () => this.products.current.open !== undefined,
    });
    commands.registerCommand(NEW_GEAR, {
      execute: () => {
        const state = this.pendingGear.state;
        this.pendingGear.state = undefined;
        return void this.createGear.openCreate(state);
      },
      isEnabled: () => this.engine.isConnected,
    });
    commands.registerCommand(OPEN_GEAR, {
      execute: () => void this.pickGear(),
    });
    commands.registerCommand(CLOSE_GEAR, {
      execute: () => void this.gears.close(),
      isEnabled: () => this.gears.current !== undefined,
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
      commandId: NEW_GEAR.id,
      label: "New Gear",
      order: "2",
    });
    menus.registerMenuAction(FILE_PRODUCT, {
      commandId: OPEN_GEAR.id,
      label: "Open Gear…",
      order: "2.5",
    });
    menus.registerMenuAction(FILE_PRODUCT, {
      commandId: CLOSE_PRODUCT.id,
      label: "Close Product",
      order: "3",
      when: `${STUDIO_CONTEXT_KEY} == 'product'`,
    });
    menus.registerMenuAction(FILE_PRODUCT, {
      commandId: CLOSE_GEAR.id,
      label: "Close Gear",
      order: "4",
      when: `${STUDIO_CONTEXT_KEY} == 'gear'`,
    });
  }

  protected async pick(): Promise<void> {
    await this.products.ensureDiscovered();
    const found = this.products.current.products;
    const recent = await this.session.recent();

    type Item =
      | { label: string; description?: string; chooseFile: true }
      | {
          label: string;
          description: string;
          ref: { path: string; label: string };
          remembered: boolean;
          chooseFile?: false;
        };

    const items: Item[] = [
      { label: "Choose product.gdl…", chooseFile: true },
      ...found.map((ref) => ({
        label: ref.label,
        description: ref.path,
        ref,
        remembered: false as const,
      })),
      ...recent
        .filter((ref) => !found.some((f) => f.path === ref.path))
        .map((ref) => ({
          label: ref.label,
          description: `${ref.path} (recent)`,
          ref,
          remembered: true as const,
        })),
    ];

    const chosen = await this.quickInput.showQuickPick(items, {
      placeholder: "Open Product",
    });
    if (chosen === undefined) return;
    if (chosen.chooseFile) {
      await this.chooseFile();
      return;
    }
    await (chosen.remembered ? this.session.openRecent(chosen.ref) : this.session.open(chosen.ref));
  }

  protected async chooseFile(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: "Open product.gdl",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Product description": ["gdl"] },
    });
    if (uri === undefined) return;
    const path = uri.path.fsPath().replace(/\\/g, "/");
    const label = uri.path.base || path;
    await this.session.open({ path, label });
  }

  protected async pickGear(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: "Open gear.gdl",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Gear description": ["gdl"] },
    });
    if (uri === undefined) return;
    const path = uri.path.fsPath().replace(/\\/g, "/");
    const root = path.endsWith("/gear.gdl") ? path.slice(0, -"/gear.gdl".length) : parentOf(path);
    await this.gears.openGear(root);
  }
}

function parentOf(file: string): string {
  const at = file.lastIndexOf("/");
  return at <= 0 ? "/" : file.slice(0, at);
}
