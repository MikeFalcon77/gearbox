// New Gear wizard — id / name / version / destination with a live FilePlan preview.
//
// ADR-0010: a preview is not optional. The right pane is `.gbx-file-plan`, the
// same shape generate uses, before any write.

import { ReactWidget } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";
import { WorkspaceService } from "@theia/workspace/lib/browser/workspace-service";

import type { GeneratePlanResult } from "../../common/generated/GeneratePlanResult";
import { GearboxService } from "../../common/protocol";
import { EngineConnectionService } from "../shell/engine-connection-service";
import { GearSessionService } from "../shell/gear-session-service";

export interface CreateGearState {
  id?: string;
  name?: string;
  version?: string;
  /** Parent folder; gear lands in `{destination}/{id}/`. */
  destinationDir?: string;
  /** After scaffold, offer to add this gear to the open product. */
  offerAddToProduct?: boolean;
}

@injectable()
export class CreateGearWidget extends ReactWidget {
  static readonly ID = "gearbox.gear.create";
  static readonly LABEL = "New Gear";

  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(GearSessionService) protected readonly gears!: GearSessionService;
  @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
  @inject(MessageService) protected readonly messages!: MessageService;
  @inject(EngineConnectionService) protected readonly engine!: EngineConnectionService;

  protected gearId = "new-gear";
  protected name = "New Gear";
  protected version = "0.1.0";
  protected destination = "";
  protected destinationTouched = false;
  protected plan: GeneratePlanResult | undefined;
  protected planError = "";
  protected previewTimer: ReturnType<typeof setTimeout> | undefined;
  protected offerAddToProduct = false;
  protected applying = false;

  @postConstruct()
  protected init(): void {
    this.id = CreateGearWidget.ID;
    this.title.label = CreateGearWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-create-gear");
    this.toDispose.push(this.engine.onDidChange(() => this.update()));
    this.destination = this.defaultDestination();
    void this.refreshPreview();
  }

  openWith(state?: CreateGearState): void {
    if (state?.id !== undefined) this.gearId = state.id;
    if (state?.name !== undefined) this.name = state.name;
    if (state?.version !== undefined) this.version = state.version;
    this.offerAddToProduct = state?.offerAddToProduct === true;
    this.destinationTouched = state?.destinationDir !== undefined;
    this.destination = state?.destinationDir ?? this.defaultDestination();
    void this.refreshPreview();
    this.update();
  }

  protected workspaceRoot(): string {
    return this.workspace.tryGetRoots()[0]?.resource.path.fsPath().replace(/\\/g, "/") ?? "";
  }

  protected defaultDestination(): string {
    const root = this.workspaceRoot();
    return root === "" ? "" : `${root}/gears`;
  }

  protected destinationDir(): string {
    const trimmed = this.destination.trim();
    return (trimmed === "" ? this.defaultDestination() : trimmed).replace(/\\/g, "/");
  }

  protected schedulePreview(): void {
    if (this.previewTimer !== undefined) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.refreshPreview(), 200);
  }

  protected async refreshPreview(): Promise<void> {
    if (!this.engine.isConnected) {
      this.plan = undefined;
      this.planError = "";
      this.update();
      return;
    }
    try {
      this.plan = await this.service.scaffoldGear({
        id: this.gearId,
        name: this.name,
        version: this.version,
        destinationDir: this.destinationDir(),
        dryRun: true,
      });
      this.planError = "";
    } catch (error) {
      this.plan = undefined;
      this.planError = error instanceof Error ? error.message : String(error);
    }
    this.update();
  }

  protected render(): React.ReactNode {
    const connected = this.engine.isConnected;
    const plans = this.plan?.plans ?? [];
    return (
      <div className="gbx-create gbx-create-gear">
        <div className="gbx-create-form">
          <h2>New gear</h2>
          {!connected && (
            <div className="gbx-error" role="alert" data-engine-status="disconnected">
              Engine disconnected: {this.engine.disconnectReason}. Preview and Create need the
              engine.
            </div>
          )}
          <label>
            Gear ID
            <input
              data-create-gear-id
              value={this.gearId}
              disabled={!connected}
              onChange={(e) => {
                this.gearId = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            name
            <input
              data-create-gear-name
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
              data-create-gear-version
              value={this.version}
              disabled={!connected}
              onChange={(e) => {
                this.version = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <label>
            destination folder
            <input
              data-create-gear-destination
              value={this.destination}
              disabled={!connected}
              onChange={(e) => {
                this.destinationTouched = true;
                this.destination = e.target.value;
                this.schedulePreview();
              }}
            />
          </label>
          <p className="gbx-create-sources-note">
            Writes <code>{this.destinationDir()}/{this.gearId}/</code> (gear.gdl, Cargo.toml,
            src/lib.rs). Must stay under the workspace and outside source roots.
          </p>
          <div className="gbx-create-actions">
            <button
              type="button"
              className="theia-button main"
              data-create-gear-submit
              disabled={!connected || this.applying || this.plan === undefined}
              onClick={() => void this.create()}
            >
              Create
            </button>
            <button
              type="button"
              className="theia-button secondary"
              data-create-gear-cancel
              onClick={() => this.close()}
            >
              Cancel
            </button>
          </div>
        </div>
        <div
          className="gbx-file-plan gbx-create-preview"
          data-preview-ready={connected && this.plan !== undefined ? "true" : "false"}
        >
          {!connected && "Preview unavailable while the engine is disconnected."}
          {connected && this.planError !== "" && <div className="gbx-error">{this.planError}</div>}
          {connected && this.planError === "" && plans.length === 0 && "Planning…"}
          {connected &&
            plans.map((plan) => (
              <div
                key={plan.path}
                className="gbx-row"
                data-plan-path={plan.path}
                data-action={plan.action}
                data-ownership={plan.ownership}
              >
                <span className="gbx-badge" data-action={plan.action}>
                  {plan.action}
                </span>
                <span className="gbx-row-name">{plan.path}</span>
                <span className="gbx-badge" data-ownership={plan.ownership}>
                  {plan.ownership}
                </span>
              </div>
            ))}
          {connected && this.plan?.out_root !== undefined && (
            <div className="gbx-id" style={{ marginTop: 8 }}>
              → {this.plan.out_root}
            </div>
          )}
        </div>
      </div>
    );
  }

  protected async create(): Promise<void> {
    if (!this.engine.isConnected || this.applying) return;
    this.applying = true;
    this.update();
    try {
      const result = await this.service.scaffoldGear({
        id: this.gearId,
        name: this.name,
        version: this.version,
        destinationDir: this.destinationDir(),
        dryRun: false,
      });
      const root = result.out_root;
      const offerAdd = this.offerAddToProduct;
      this.messages.info(`Created gear at ${root}`);
      this.close();
      if (offerAdd) {
        // Stay with the product session: Create Gear for Product should land
        // back on Add Gear, not replace the open product with a gear session.
        this.messages.info(
          `Gear ${this.gearId} is ready under ${root}. Use Add Gear to select it once the catalogue includes that folder.`,
        );
        return;
      }
      await this.gears.openGear(root);
    } catch (error) {
      this.messages.error(error instanceof Error ? error.message : String(error));
    } finally {
      this.applying = false;
      this.update();
    }
  }
}
