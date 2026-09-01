// Create or clone a product description — a screen, not a chain of modals.
//
// ADR-0010: a preview is not optional. The right pane shows the exact
// `product.gdl` the engine would write; Create commits only that text.

import { ReactWidget } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { GearboxService } from "../../common/protocol";
import { ProductEditService } from "../product-edit-service";
import { ProductSessionService } from "../shell/product-session-service";

export interface CreateProductState {
  cloneFrom?: string;
  id?: string;
  name?: string;
}

@injectable()
export class CreateProductWidget extends ReactWidget {
  static readonly ID = "gearbox.create";
  static readonly LABEL = "New Product";

  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(ProductSessionService) protected readonly session!: ProductSessionService;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(MessageService) protected readonly messages!: MessageService;

  protected productId = "new-product";
  protected name = "New Product";
  protected version = "0.1.0";
  protected profileKind = "embedded";
  protected profileId = "dev";
  protected cloneFrom: string | undefined;
  protected preview = "";
  protected previewTimer: ReturnType<typeof setTimeout> | undefined;
  protected roots: string[] = [];
  protected selectedRoots = new Set<string>();

  @postConstruct()
  protected init(): void {
    this.id = CreateProductWidget.ID;
    this.title.label = CreateProductWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-create");
    void this.refreshRoots();
  }

  openWith(state?: CreateProductState): void {
    if (state?.cloneFrom !== undefined) {
      this.cloneFrom = state.cloneFrom;
      const base = state.id ?? "copy";
      this.productId = base;
      this.name = state.name ?? `${base} copy`;
    } else {
      this.cloneFrom = undefined;
    }
    if (state?.id !== undefined) this.productId = state.id;
    if (state?.name !== undefined) this.name = state.name;
    void this.refreshPreview();
    this.update();
  }

  protected async refreshRoots(): Promise<void> {
    this.roots = this.workspace.tryGetRoots().map((r) => r.resource.path.fsPath());
    this.selectedRoots = new Set(this.roots);
    await this.refreshPreview();
    this.update();
  }

  protected productPath(): string {
    const root = this.workspace.tryGetRoots()[0]?.resource.path.fsPath() ?? "";
    return `${root}/products/${this.productId}/product.gdl`.replace(/\\/g, "/");
  }

  protected relativeSource(at: string): string {
    const productDir = `${this.workspace.tryGetRoots()[0]?.resource.path.fsPath() ?? ""}/products/${this.productId}`;
    const from = URI.fromFilePath(productDir);
    const to = URI.fromFilePath(at);
    const relative = from.relative(to);
    return relative !== undefined ? relative.fsPath().replace(/\\/g, "/") : at;
  }

  protected schedulePreview(): void {
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.refreshPreview(), 200);
  }

  protected async refreshPreview(): Promise<void> {
    const sources = [...this.selectedRoots].map((at, index) => ({
      id: `source-${index + 1}`,
      at: this.relativeSource(at),
    }));
    try {
      const result = await this.service.createProduct({
        path: this.productPath(),
        id: this.productId,
        name: this.name,
        version: this.version,
        sources,
        profileKind: this.profileKind,
        profileId: this.profileId,
        cloneFrom: this.cloneFrom,
        dryRun: true,
      });
      this.preview = result.after;
    } catch (error) {
      this.preview = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  protected render(): React.ReactNode {
    return (
      <div className="gbx-create">
        <div className="gbx-create-form">
          <h2>{this.cloneFrom !== undefined ? "Clone product" : "New product"}</h2>
          <label>
            clone from
            <input
              data-clone-path
              value={this.cloneFrom ?? ""}
              onChange={(e) => {
                this.cloneFrom = e.target.value.trim() === "" ? undefined : e.target.value.trim();
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            <input
              data-create-id
              value={this.productId}
              onChange={(e) => {
                this.productId = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            name
            <input
              data-create-name
              value={this.name}
              onChange={(e) => {
                this.name = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            version
            <input
              value={this.version}
              onChange={(e) => {
                this.version = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <div className="gbx-create-sources">
            <div>sources</div>
            {this.roots.map((root) => (
              <label key={root}>
                <input
                  type="checkbox"
                  checked={this.selectedRoots.has(root)}
                  onChange={() => {
                    if (this.selectedRoots.has(root)) this.selectedRoots.delete(root);
                    else this.selectedRoots.add(root);
                    this.schedulePreview();
                  }}
                />
                {root}
              </label>
            ))}
          </div>
          <div className="gbx-create-actions">
            <button
              type="button"
              className="theia-button main"
              data-create-submit
              onClick={() => void this.create()}
            >
              Create
            </button>
            <button
              type="button"
              className="theia-button secondary"
              data-create-cancel
              onClick={() => this.close()}
            >
              Cancel
            </button>
          </div>
        </div>
        <pre className="gbx-create-preview">{this.preview}</pre>
      </div>
    );
  }

  protected async create(): Promise<void> {
    const ok = await this.edits.createProduct({
      path: this.productPath(),
      id: this.productId,
      name: this.name,
      version: this.version,
      sources: [...this.selectedRoots].map((at, index) => ({
        id: `source-${index + 1}`,
        at: this.relativeSource(at),
      })),
      profileKind: this.profileKind,
      profileId: this.profileId,
      cloneFrom: this.cloneFrom,
      preview: this.preview,
    });
    if (!ok) return;
    this.close();
  }
}
