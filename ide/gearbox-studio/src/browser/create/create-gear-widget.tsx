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
import { gearIdProblem, gearVersionProblem } from "../../common/gear-identity";
import { CommandRegistry } from "@theia/core/lib/common";

import type { GearKind } from "../../common/generated/GearKind";

import { SHOW_PRODUCT } from "../shell/session-command-ids";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { GearSessionService } from "../shell/gear-session-service";

export interface CreateGearState {
  /**
   * The product this gear is being created for, when there is one.
   *
   * A path and a label: after scaffold the panel declares the new folder as a
   * source and adds the gear in one batch. A bare flag used to travel instead,
   * which is why the flow ended in a notification telling the person to add the
   * gear themselves.
   */
  id?: string;
  name?: string;
  version?: string;
  /** Parent folder; gear lands in `{destination}/{id}/`. */
  destinationDir?: string;
  readonly product?: { readonly path: string; readonly label: string };
  /** Which shape to preselect, when the caller has an opinion. */
  readonly kind?: GearKind;
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
  // Reached for the last step of a create-for-a-product: the batch that declares
  // the new folder as a source and adds the gear.
  @inject(ProductEditService) protected readonly edits!: ProductEditService;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(CommandRegistry) protected readonly commands!: CommandRegistry;

  /**
   * Which shape to scaffold.
   *
   * `service` by default rather than `minimal`, and the corpus is the reason: of
   * the fourteen described gears, none is a bare crate with a name -- every one
   * either does something on its own or fills another gear's extension point. The
   * minimal shape is what this panel wrote before there were kinds, and it stays
   * for a crate that is being described before it does anything.
   */
  protected kind: GearKind = "service";

  protected gearId = "new-gear";
  protected name = "New Gear";
  protected version = "0.1.0";
  protected destination = "";
  protected destinationTouched = false;
  protected plan: GeneratePlanResult | undefined;
  protected planError = "";
  protected previewTimer: ReturnType<typeof setTimeout> | undefined;
  protected product: { path: string; label: string } | undefined;
  protected applying = false;

  @postConstruct()
  protected init(): void {
    this.id = CreateGearWidget.ID;
    this.title.label = CreateGearWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-create-gear");
    this.toDispose.push(this.engine.onDidChange(() => this.update()));
    // **The workspace may not be open yet, and the destination comes from it.**
    // `DomainWorkspace` opens the source roots asynchronously at startup, so a
    // widget built before that read `tryGetRoots()[0]` as `undefined`, defaulted
    // the destination to the empty string, and the scaffold dry run refused --
    // presenting as a New Gear screen with an error and no file plan. It used to
    // be hidden by timing: boot opened a product, which took long enough for the
    // roots to land first. Nothing about the destination should depend on that.
    this.toDispose.push(
      this.workspace.onWorkspaceChanged(() => {
        if (this.destinationTouched) return;
        const next = this.defaultDestination();
        if (next === this.destination) return;
        this.destination = next;
        void this.refreshPreview();
      }),
    );
    this.destination = this.defaultDestination();
    void this.refreshPreview();
  }

  openWith(state?: CreateGearState): void {
    if (state?.id !== undefined) this.gearId = state.id;
    if (state?.name !== undefined) this.name = state.name;
    if (state?.version !== undefined) this.version = state.version;
    this.kind = state?.kind ?? "service";
    this.product = state?.product === undefined ? undefined : { ...state.product };
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
        kind: this.kind,
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
    // Checked at the field, not only by the dry run. The engine refuses both --
    // and stays the boundary -- but its refusal arrived in the preview pane on
    // the other side of the screen, 400 ms after the keystroke, with no
    // indication of which field it was about.
    const idProblem = gearIdProblem(this.gearId);
    const versionProblem = gearVersionProblem(this.version);
    return (
      <div className="gbx-create gbx-create-gear">
        <div className="gbx-create-form">
          <h2>New gear</h2>
          {/* **Whose product this is for.** The panel is reached two ways -- from
              Home, where a gear is a thing in its own right, and from a product,
              where it is a component of that product -- and it looked identical
              either way. What follows from the difference is the whole flow
              below: a gear created for a product is declared as a source and
              added to it, in one batch, and the panel returns there. */}
          {this.product !== undefined && (
            <p className="gbx-create-banner" data-create-gear-for={this.product.label}>
              Creating a gear for <strong>{this.product.label}</strong>. It will be added to that
              product when you create it.
            </p>
          )}
          {!connected && (
            <div className="gbx-error" role="alert" data-engine-status="disconnected">
              Engine disconnected: {this.engine.disconnectReason}. Preview and Create need the
              engine.
            </div>
          )}
          {/* First, because it decides what the rest of the file will say. Three
              shapes, and what differs is which declarations the description
              offers -- the preview on the right is the whole answer, which is
              why this control re-previews rather than explaining itself. */}
          <label>
            Kind
            <select
              data-create-gear-kind
              value={this.kind}
              disabled={!connected}
              onChange={(e) => {
                this.kind = e.target.value as GearKind;
                this.schedulePreview();
                this.update();
              }}
            >
              <option value="service">Service — a gear that does something</option>
              <option value="plugin">Plugin — fills another gear&apos;s extension point</option>
              <option value="minimal">Minimal — a crate and a name</option>
            </select>
          </label>
          <label>
            Gear id
            <input
              data-create-gear-id
              value={this.gearId}
              disabled={!connected}
              aria-invalid={idProblem !== undefined ? true : undefined}
              onChange={(e) => {
                this.gearId = e.target.value;
                this.schedulePreview();
              }}
            />
            {idProblem !== undefined && (
              <span className="gbx-inline-error" role="alert" data-create-gear-id-error>
                {idProblem}
              </span>
            )}
          </label>
          <label>
            Name
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
            Version
            <input
              data-create-gear-version
              value={this.version}
              disabled={!connected}
              aria-invalid={versionProblem !== undefined ? true : undefined}
              onChange={(e) => {
                this.version = e.target.value;
                this.schedulePreview();
              }}
            />
            {versionProblem !== undefined && (
              <span className="gbx-inline-error" role="alert" data-create-gear-version-error>
                {versionProblem}
              </span>
            )}
          </label>
          <label>
            Destination folder
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
              disabled={
              !connected ||
              this.applying ||
              this.plan === undefined ||
              idProblem !== undefined ||
              versionProblem !== undefined
            }
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
          {/* A skeleton rather than the word "Planning…": three rows is what a
              scaffold always writes, so the shape of the answer is known before
              the answer is, and a pane that reserves the space does not jump when
              it arrives. `aria-busy` is what says it is not the answer yet. */}
          {connected && this.planError === "" && plans.length === 0 && (
            <div className="gbx-skeleton" aria-busy="true" data-create-gear-planning>
              <span className="gbx-skeleton-row" />
              <span className="gbx-skeleton-row" />
              <span className="gbx-skeleton-row" />
            </div>
          )}
          {connected &&
            plans.map((plan) => (
              <div
                key={plan.path}
                className="gbx-row"
                data-plan-path={plan.path}
                data-plan-blake3={plan.blake3}
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

  /**
   * Declare the new gear's folder as a source of `product`, and add the gear.
   *
   * **Two edits, one batch, and the first one is not optional.** A scaffold
   * cannot land inside an existing source root -- `writable_out_root` refuses
   * that, because ADR `cpt-gearbox-adr-authoring-ownership-tiers` tier 5 keeps
   * the tool out of a corpus somebody else owns -- so a gear created for a
   * product is always in a directory that product does not read yet, and
   * `use_gear` cannot reach it. That is why this flow used to end in a
   * notification asking the person to fix the description by hand.
   *
   * The source id is derived from the folder rather than asked for: it is a
   * key inside one description, the folder is what it names, and one more
   * question in a form is one more thing to get wrong. `add_source` is
   * idempotent, so creating a second gear in the same folder adds only the gear.
   */
  protected async addToProduct(
    product: { path: string; label: string },
    gearId: string,
  ): Promise<void> {
    const at = relativeTo(product.path, this.destinationDir());
    if (at === undefined) {
      // Outside the description's own directory: `path(at = ...)` is resolved
      // against that directory, and a `../..` chain to somewhere unrelated is a
      // description nobody would have written. Said rather than guessed at.
      this.messages.warn(
        `${gearId} was created outside ${product.label}'s folder, so it was not added. ` +
          `Declare its directory as a source in the description to use it.`,
      );
      return;
    }
    const sourceId = sourceIdFor(at);
    const added = await this.edits.applyProductEdits(product, [
      { kind: "add_source", id: sourceId, at },
      { kind: "add_gear", gear: gearId, source: sourceId },
    ]);
    if (!added) return;
    // Back where the flow started. The audit's phrasing: "after creating --
    // `Add this gear to Payments Demo` -- and a return to the Product
    // workspace". This is the return.
    void this.commands.executeCommand(SHOW_PRODUCT.id);
    // The catalogue has to read the new source root before the gear can be
    // resolved: `initialize` respawns the engine, and nothing watches the
    // filesystem (§9.1, "what is not watched").
    await this.catalogue.load();
    await this.products.reload();
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
        kind: this.kind,
        destinationDir: this.destinationDir(),
        dryRun: false,
      });
      const root = result.out_root;
      const product = this.product;
      const gearId = this.gearId;
      this.messages.info(`Created gear at ${root}`);
      this.close();
      if (product !== undefined) {
        await this.addToProduct(product, gearId);
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

/**
 * `to` expressed relative to the directory holding `descriptionPath`.
 *
 * `undefined` when `to` is not inside that directory: `path(at = ...)` resolves
 * against the description's own folder, and this is the one case where writing a
 * `../..` chain would be describing a layout nobody chose.
 *
 * Hand-rolled because the browser has no `path`, and the inputs are POSIX
 * absolute paths -- the same reason `resolveFrom` in `ProductSessionService` is.
 */
function relativeTo(descriptionPath: string, to: string): string | undefined {
  const directory = descriptionPath.replace(/\/[^/]+$/, "");
  const normalise = (value: string): string => value.replace(/\/+$/, "");
  const base = normalise(directory);
  const target = normalise(to);
  if (target === base) return ".";
  if (!target.startsWith(`${base}/`)) return undefined;
  return target.slice(base.length + 1);
}

/**
 * A source id for a folder: its last segment, kebab-cased.
 *
 * `SourceId` is kebab-case (`gears-rust` is the corpus's own), and the engine
 * refuses anything else -- so this produces a name the description can hold and
 * a person can recognise, rather than asking for one.
 */
function sourceIdFor(at: string): string {
  const segment = at.split("/").filter((part) => part !== "" && part !== ".").pop() ?? "local";
  const kebab = segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab === "" || !/^[a-z]/.test(kebab) ? `local-${kebab || "gears"}` : kebab;
}
