// Create or clone a product description — a screen, not a chain of modals.
//
// ADR-0010: a preview is not optional. The right pane shows the exact
// `product.gdl` the engine would write; Create commits only that text.
// ADR-0013 amendment: Blank / Clone Local / Clone Git; clone stamps version
// honestly and does not rewrite sources.

import { ReactWidget } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";
import { FileDialogService } from "@theia/filesystem/lib/browser";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import { GearboxService } from "../../common/protocol";
import { ProductEditService } from "../product-edit-service";
import { EngineConnectionService } from "../shell/engine-connection-service";
import { ProductSessionService } from "../shell/product-session-service";

export type CreateMode = "blank" | "clone-local" | "clone-git";

export interface CreateProductState {
  cloneFrom?: string;
  id?: string;
  name?: string;
  mode?: CreateMode;
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
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService;

  protected mode: CreateMode = "blank";
  protected productId = "new-product";
  protected name = "New Product";
  protected version = "0.1.0";
  protected profileKind = "embedded";
  protected profileId = "dev";
  protected cloneFrom: string | undefined;
  protected gitUrl = "";
  protected gitRef = "";
  /** Editable destination; empty means use the default under the workspace. */
  protected destination = "";
  protected destinationTouched = false;
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
    this.toDispose.push(this.engine.onDidChange(() => this.update()));
    void this.refreshRoots();
  }

  openWith(state?: CreateProductState): void {
    if (state?.cloneFrom !== undefined) {
      this.cloneFrom = state.cloneFrom;
      this.mode = state.mode ?? "clone-local";
      const base = state.id ?? "copy";
      this.productId = base;
      this.name = state.name ?? `${base} copy`;
    } else {
      this.cloneFrom = undefined;
      this.mode = state?.mode ?? "blank";
      this.gitUrl = "";
      this.gitRef = "";
    }
    if (state?.id !== undefined) this.productId = state.id;
    if (state?.name !== undefined) this.name = state.name;
    this.destinationTouched = false;
    this.destination = this.defaultProductPath();
    void this.refreshPreview();
    this.update();
  }

  protected async refreshRoots(): Promise<void> {
    this.roots = this.workspace.tryGetRoots().map((r) => r.resource.path.fsPath());
    this.selectedRoots = new Set(this.roots);
    if (!this.destinationTouched) {
      this.destination = this.defaultProductPath();
    }
    await this.refreshPreview();
    this.update();
  }

  protected workspaceRoot(): string {
    return this.workspace.tryGetRoots()[0]?.resource.path.fsPath() ?? "";
  }

  protected defaultProductPath(): string {
    const root = this.workspaceRoot();
    return `${root}/products/${this.productId}/product.gdl`.replace(/\\/g, "/");
  }

  protected productPath(): string {
    const trimmed = this.destination.trim();
    return trimmed === "" ? this.defaultProductPath() : trimmed.replace(/\\/g, "/");
  }

  protected relativeSource(at: string): string {
    const productDir = `${this.workspaceRoot()}/products/${this.productId}`;
    const from = URI.fromFilePath(productDir);
    const to = URI.fromFilePath(at);
    const relative = from.relative(to);
    return relative !== undefined ? relative.fsPath().replace(/\\/g, "/") : at;
  }

  protected setMode(mode: CreateMode): void {
    this.mode = mode;
    if (mode === "blank") {
      this.cloneFrom = undefined;
    }
    this.schedulePreview();
    this.update();
  }

  protected schedulePreview(): void {
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.refreshPreview(), 200);
  }

  protected createParams(cloneFrom: string | undefined, dryRun: boolean) {
    const sources =
      this.mode === "blank"
        ? [...this.selectedRoots].map((at, index) => ({
            id: `source-${index + 1}`,
            at: this.relativeSource(at),
          }))
        : [];
    return {
      path: this.productPath(),
      id: this.productId,
      name: this.name,
      version: this.version,
      sources,
      profileKind: this.profileKind,
      profileId: this.profileId,
      cloneFrom,
      dryRun,
    };
  }

  protected async refreshPreview(): Promise<void> {
    if (!this.engine.isConnected) {
      this.preview = "";
      this.update();
      return;
    }
    if (this.mode === "clone-git") {
      // Preview needs a local file; git clone runs only on Create.
      this.preview =
        this.gitUrl.trim() === ""
          ? "Enter a git URL. Preview runs after Create clones the repository."
          : `# Clone from ${this.gitUrl.trim()}${this.gitRef.trim() !== "" ? ` @ ${this.gitRef.trim()}` : ""}\n` +
            `# then stamp id/name/version into:\n#   ${this.productPath()}\n` +
            `product(\n    id = "${this.productId}",\n    name = "${this.name}",\n    version = "${this.version}",\n    # sources kept from the cloned file\n)\n`;
      this.update();
      return;
    }
    if (this.mode === "clone-local" && (this.cloneFrom === undefined || this.cloneFrom.trim() === "")) {
      this.preview = "Choose a product.gdl to clone.";
      this.update();
      return;
    }
    try {
      const result = await this.service.createProduct(
        this.createParams(this.mode === "clone-local" ? this.cloneFrom : undefined, true),
      );
      this.preview = result.after;
    } catch (error) {
      this.preview = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  protected async browseCloneSource(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: "Clone from product.gdl",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Product description": ["gdl"] },
    });
    if (uri === undefined) return;
    this.cloneFrom = uri.path.fsPath().replace(/\\/g, "/");
    this.schedulePreview();
    this.update();
  }

  protected render(): React.ReactNode {
    const connected = this.engine.isConnected;
    const cloning = this.mode !== "blank";
    return (
      <div className="gbx-create">
        <div className="gbx-create-form">
          <h2>New product</h2>
          {!connected && (
            <div className="gbx-error" role="alert" data-engine-status="disconnected">
              Engine disconnected: {this.engine.disconnectReason}. Preview and Create need the
              engine.
            </div>
          )}
          <div className="gbx-create-modes" role="tablist" aria-label="Create mode" data-create-modes>
            {(
              [
                ["blank", "Blank"],
                ["clone-local", "Clone Local"],
                ["clone-git", "Clone Git"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                className={this.mode === value ? "theia-button main" : "theia-button secondary"}
                data-create-mode={value}
                aria-selected={this.mode === value}
                disabled={!connected}
                onClick={() => this.setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {this.mode === "clone-local" && (
            <label>
              clone from
              <div className="gbx-create-row">
                <input
                  data-clone-path
                  value={this.cloneFrom ?? ""}
                  disabled={!connected}
                  onChange={(e) => {
                    this.cloneFrom = e.target.value.trim() === "" ? undefined : e.target.value.trim();
                    this.schedulePreview();
                  }}
                />
                <button
                  type="button"
                  className="theia-button secondary"
                  data-clone-browse
                  disabled={!connected}
                  onClick={() => void this.browseCloneSource()}
                >
                  Browse
                </button>
              </div>
            </label>
          )}
          {this.mode === "clone-git" && (
            <>
              <label>
                git URL
                <input
                  data-clone-git-url
                  value={this.gitUrl}
                  disabled={!connected}
                  onChange={(e) => {
                    this.gitUrl = e.target.value;
                    this.schedulePreview();
                  }}
                />
              </label>
              <label>
                ref (optional)
                <input
                  data-clone-git-ref
                  value={this.gitRef}
                  disabled={!connected}
                  placeholder="branch or tag"
                  onChange={(e) => {
                    this.gitRef = e.target.value;
                    this.schedulePreview();
                  }}
                />
              </label>
            </>
          )}
          <label>
            Product ID
            <input
              data-create-id
              value={this.productId}
              disabled={!connected}
              onChange={(e) => {
                this.productId = e.target.value;
                if (!this.destinationTouched) {
                  this.destination = this.defaultProductPath();
                }
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            name
            <input
              data-create-name
              value={this.name}
              disabled={!connected}
              onChange={(e) => {
                this.name = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            version
            <input
              data-create-version
              value={this.version}
              disabled={!connected}
              onChange={(e) => {
                this.version = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            destination
            <input
              data-create-destination
              value={this.destination}
              disabled={!connected}
              onChange={(e) => {
                this.destinationTouched = true;
                this.destination = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          {this.mode === "blank" ? (
            <div className="gbx-create-sources">
              <div>sources</div>
              {this.roots.map((root) => (
                <label key={root}>
                  <input
                    type="checkbox"
                    checked={this.selectedRoots.has(root)}
                    disabled={!connected}
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
          ) : (
            <p className="gbx-create-sources-note" data-clone-sources-note>
              sources kept from the cloned file
            </p>
          )}
          <div className="gbx-create-actions">
            <button
              type="button"
              className="theia-button main"
              data-create-submit
              disabled={!connected || (cloning && this.mode === "clone-local" && !this.cloneFrom)}
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
        <pre className="gbx-create-preview" data-preview-ready={connected ? "true" : "false"}>
          {connected ? this.preview : "Preview unavailable while the engine is disconnected."}
        </pre>
      </div>
    );
  }

  protected async create(): Promise<void> {
    if (!this.engine.isConnected) return;

    let cloneFrom = this.mode === "clone-local" ? this.cloneFrom : undefined;
    if (this.mode === "clone-git") {
      const url = this.gitUrl.trim();
      if (url === "") {
        this.messages.error("Enter a git URL to clone.");
        return;
      }
      const destDir = `${this.workspaceRoot()}/.gearbox/git-clones/${this.productId}`.replace(
        /\\/g,
        "/",
      );
      try {
        cloneFrom = await this.service.gitCloneProduct(
          url,
          this.gitRef.trim() === "" ? undefined : this.gitRef.trim(),
          destDir,
        );
      } catch (error) {
        this.messages.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }

    const params = this.createParams(cloneFrom, false);
    // Dry-run for git after clone so the preview dialog shows real surgery text.
    if (this.mode === "clone-git" && cloneFrom !== undefined) {
      try {
        const dry = await this.service.createProduct({ ...params, dryRun: true });
        this.preview = dry.after;
        this.update();
      } catch (error) {
        this.messages.error(error instanceof Error ? error.message : String(error));
        return;
      }
    }

    const ok = await this.edits.createProduct({
      ...params,
      preview: this.preview,
    });
    if (!ok) return;
    this.close();
  }
}
