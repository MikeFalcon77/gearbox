// Opening a gear for authoring — the counterpart of ProductSessionService.
//
// A gear session is lighter: initialize with the gear directory as a source
// root so Validate can see it, switch Studio context to `gear`, and keep the
// path for the Gear perspective. Opening a gear clears any open product (after
// the same dirty-description guard ProductSession uses). Product open clears
// the gear session the other way.

import { MessageService } from "@theia/core/lib/common/message-service";
import { Emitter, Event } from "@theia/core/lib/common/event";

import { hasUnsavedEdits } from "./unsaved";
import { MonacoTextModelService } from "@theia/monaco/lib/browser/monaco-text-model-service";
import { inject, injectable } from "@theia/core/shared/inversify";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { CatalogueStore } from "../catalogue-store";
import { ProductStore } from "../product-store";

export interface GearRef {
  /** Absolute path of the gear directory (contains `gear.gdl`). */
  readonly root: string;
  readonly label: string;
}

@injectable()
export class GearSessionService {
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(MonacoTextModelService) protected readonly models!: MonacoTextModelService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;

  protected readonly onDidChangeEmitter = new Emitter<void>();
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  protected openRef: GearRef | undefined;

  get current(): GearRef | undefined {
    return this.openRef;
  }

  async openGear(root: string): Promise<boolean> {
    const normalized = root.replace(/\\/g, "/").replace(/\/$/, "");
    const label = normalized.split("/").filter(Boolean).pop() ?? normalized;

    const openProduct = this.products.current.open;
    if (openProduct !== undefined) {
      if (this.isDirty(openProduct.path)) {
        this.messages.error(
          `${openProduct.label} has unsaved changes. Save or revert them before opening a gear.`,
        );
        return false;
      }
      this.products.clear();
    }

    const workspace = this.workspaceFor(normalized);
    try {
      await this.catalogue.load({ roots: [normalized], workspace });
    } catch (error) {
      this.messages.error(
        `Could not open gear ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    this.openRef = { root: normalized, label };
    this.onDidChangeEmitter.fire();
    return true;
  }

  async close(): Promise<boolean> {
    if (this.openRef === undefined) return true;
    this.openRef = undefined;
    this.onDidChangeEmitter.fire();
    return true;
  }

  /** Absolute path of `gear.gdl` for the open gear, if any. */
  gdlPath(): string | undefined {
    return this.openRef === undefined ? undefined : `${this.openRef.root}/gear.gdl`;
  }

  protected isDirty(path: string): boolean {
    return hasUnsavedEdits(this.models, path);
  }

  protected workspaceFor(gearRoot: string): string {
    const containing = this.workspace
      .tryGetRoots()
      .map((stat) => stat.resource.path.fsPath().replace(/\\/g, "/"))
      .filter((root) => gearRoot === root || gearRoot.startsWith(`${root}/`))
      .sort((a, b) => b.length - a.length);
    return containing[0] ?? gearRoot;
  }
}
