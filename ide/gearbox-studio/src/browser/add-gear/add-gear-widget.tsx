// Add a gear to the open product: one panel with overview, options, and a
// dry-run preview of the description write.
//
// Replaces the catalogue's immediate `+` toggle for *adding*. Removal still goes
// through `ProductEditService.toggle` (preview dialog + confirm). Features and
// config are collected here and applied after `addGear`, in that order.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { EditGearResult } from "../../common/generated/EditGearResult";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { ProductEdit } from "../../common/generated/ProductEdit";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";

export interface AddGearState {
  /** Preselected gear id when opened from the catalogue `+`. */
  gearId?: string;
}

@injectable()
export class AddGearWidget extends ReactWidget {
  static readonly ID = "gearbox.add-gear";
  static readonly LABEL = "Add Gear";

  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;

  protected gearId: string | undefined;
  protected features: string[] = [];
  protected plugins: string[] = [];
  protected newFeature = "";
  protected newPlugin = "";
  protected config: Array<{ key: string; value: string }> = [];
  protected newConfigKey = "";
  protected newConfigValue = "";
  protected preview: EditGearResult | undefined;
  protected previewError: string | undefined;
  protected previewing = false;
  protected applying = false;
  protected openSections = new Set<string>([
    "overview",
    "compatibility",
    "features",
    "config",
    "plugins",
    "closure",
  ]);

  @postConstruct()
  protected init(): void {
    this.id = AddGearWidget.ID;
    this.title.label = AddGearWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-add-gear");
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.toDispose.push(this.products.onChanged(() => this.update()));
  }

  openWith(state?: AddGearState): void {
    this.gearId = state?.gearId;
    this.features = [];
    this.plugins = [];
    this.config = [];
    this.newFeature = "";
    this.newPlugin = "";
    this.newConfigKey = "";
    this.newConfigValue = "";
    this.preview = undefined;
    this.previewError = undefined;
    this.previewing = false;
    this.applying = false;
    this.openSections = new Set([
      "overview",
      "compatibility",
      "features",
      "config",
      "plugins",
      "closure",
    ]);
    this.title.label = this.gearId !== undefined ? `Add ${this.gearId}` : AddGearWidget.LABEL;
    void this.refreshPreview();
    this.update();
  }

  protected descriptor(): GearDescriptor | undefined {
    if (this.gearId === undefined) return undefined;
    const row = this.catalogue.current.rows.find(
      (candidate) => candidate.kind === "projected" && candidate.gear.id === this.gearId,
    );
    return row?.kind === "projected" ? row.gear : undefined;
  }

  protected candidates(): GearDescriptor[] {
    return this.catalogue.current.rows
      .filter((row): row is { kind: "projected"; gear: GearDescriptor } => row.kind === "projected")
      .map((row) => row.gear)
      .filter((gear) => !this.edits.inProduct(gear.id))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  protected inclusionNote(id: string): string | undefined {
    const gear = this.products.current.resolution?.product?.gears[id];
    if (gear === undefined) return undefined;
    if (gear.selected_by.some((reason) => reason.reason === "selected")) {
      return `${id} is already named by this product.`;
    }
    return `${id} is already pulled into the closure (not named directly). Adding it makes the product ask for it explicitly.`;
  }

  protected async refreshPreview(): Promise<void> {
    const gear = this.descriptor();
    if (gear === undefined) {
      this.preview = undefined;
      this.previewError = undefined;
      this.update();
      return;
    }
    this.previewing = true;
    this.update();
    const result = await this.edits.previewAddGear(gear.id, gear.source);
    this.previewing = false;
    if (result === undefined) {
      this.preview = undefined;
      this.previewError = "Could not preview this add.";
    } else {
      this.preview = result;
      this.previewError = result.changed
        ? undefined
        : `${gear.id} is already named by the product.`;
    }
    this.update();
  }

  protected followUps(gearId: string): ProductEdit[] {
    const edits: ProductEdit[] = [];
    if (this.features.length > 0) {
      edits.push({ kind: "set_features", gear: gearId, features: [...this.features] });
    }
    if (this.plugins.length > 0) {
      edits.push({ kind: "set_plugins", gear: gearId, plugins: [...this.plugins] });
    }
    for (const { key, value } of this.config) {
      const trimmed = key.trim();
      if (trimmed === "") continue;
      edits.push({ kind: "set_config", gear: gearId, key: trimmed, value });
    }
    return edits;
  }

  protected async apply(): Promise<void> {
    const gear = this.descriptor();
    if (gear === undefined || this.applying) return;
    this.applying = true;
    this.update();
    const ok = await this.edits.commitAddGear(gear.id, gear.source, this.followUps(gear.id));
    this.applying = false;
    if (ok) {
      this.close();
      return;
    }
    this.update();
  }

  protected render(): React.ReactNode {
    const gear = this.descriptor();
    const open = this.products.current.open;

    return (
      <div className="gbx-add-gear" data-add-gear-flow>
        <div className="gbx-add-gear-head">
          <div className="gbx-detail-title">Add Gear</div>
          <div className="gbx-add-gear-sub">
            {open !== undefined
              ? `Configure a gear for ${open.label}, then write it into the description.`
              : "Open a product before adding a gear."}
          </div>
        </div>

        {open === undefined ? (
          <div className="gbx-empty">No product is open.</div>
        ) : (
          <>
            {this.renderSection(
              "overview",
              "1. Overview",
              gear === undefined ? this.renderPicker() : this.renderOverview(gear),
            )}
            {gear !== undefined && (
              <>
                {this.renderSection(
                  "compatibility",
                  "2. Compatibility",
                  this.renderCompatibility(gear.id),
                )}
                {this.renderSection("features", "3. Features", this.renderFeatures())}
                {this.renderSection("config", "4. Configuration", this.renderConfig())}
                {this.renderSection("plugins", "5. Plugins", this.renderPlugins(gear))}
                {this.renderSection("closure", "6. What will be written", this.renderClosure())}
              </>
            )}

            <div className="gbx-add-gear-actions">
              <button
                type="button"
                className="gbx-choice"
                data-add-gear-submit
                disabled={
                  gear === undefined ||
                  this.applying ||
                  this.previewing ||
                  this.preview?.changed !== true
                }
                onClick={() => void this.apply()}
              >
                {this.applying ? "Adding…" : "Add to Product"}
              </button>
              <button
                type="button"
                className="gbx-choice"
                data-add-gear-cancel
                onClick={() => this.close()}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  protected renderSection(id: string, title: string, body: React.ReactNode): React.ReactNode {
    const open = this.openSections.has(id);
    return (
      <div className="gbx-add-gear-section" data-add-gear-section={id}>
        <button
          type="button"
          className="gbx-add-gear-section-head"
          aria-expanded={open}
          onClick={() => {
            if (!this.openSections.delete(id)) this.openSections.add(id);
            this.update();
          }}
        >
          <span className={`codicon codicon-chevron-${open ? "down" : "right"}`} />
          {title}
        </button>
        {open && <div className="gbx-add-gear-section-body">{body}</div>}
      </div>
    );
  }

  protected renderPicker(): React.ReactNode {
    const candidates = this.candidates();
    if (candidates.length === 0) {
      return <div className="gbx-empty">Every projected gear is already named by this product.</div>;
    }
    return (
      <div className="gbx-add-gear-picker" data-add-gear-picker>
        <label>
          Gear
          <select
            data-add-gear-select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id === "") return;
              this.gearId = id;
              this.title.label = `Add ${id}`;
              void this.refreshPreview();
              this.update();
            }}
          >
            <option value="">Select a gear…</option>
            {candidates.map((gear) => (
              <option key={gear.id} value={gear.id}>
                {gear.display_name} ({gear.id})
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  protected renderOverview(gear: GearDescriptor): React.ReactNode {
    return (
      <div className="gbx-kv-block" data-add-gear-overview={gear.id}>
        <div className="gbx-kv">
          <span>name</span>
          <span>
            {gear.display_name} <span className="gbx-id">{gear.id}</span>
          </span>
        </div>
        <div className="gbx-kv">
          <span>category</span>
          <span>{gear.category ?? "—"}</span>
        </div>
        <div className="gbx-kv">
          <span>source</span>
          <span>{gear.source}</span>
        </div>
        <div className="gbx-kv">
          <span>description</span>
          <span>{gear.description ?? "—"}</span>
        </div>
        {(gear.runtime_caps ?? []).length > 0 && (
          <div className="gbx-kv">
            <span>capabilities</span>
            <span>
              {(gear.runtime_caps ?? []).map((cap) => (
                <span className="gbx-badge" key={cap}>
                  {cap}
                </span>
              ))}
            </span>
          </div>
        )}
        <button
          type="button"
          className="gbx-choice"
          data-add-gear-change
          onClick={() => {
            this.gearId = undefined;
            this.preview = undefined;
            this.title.label = AddGearWidget.LABEL;
            this.update();
          }}
        >
          Choose a different gear
        </button>
      </div>
    );
  }

  protected renderCompatibility(id: string): React.ReactNode {
    const note = this.inclusionNote(id);
    if (note === undefined) {
      return <div className="gbx-empty">Not yet in this product or its closure.</div>;
    }
    return (
      <div className="gbx-add-gear-note" data-add-gear-compat>
        {note}
      </div>
    );
  }

  protected renderFeatures(): React.ReactNode {
    return (
      <div className="gbx-features-list" data-add-gear-features>
        {this.features.length === 0 && <div className="gbx-empty">No features yet.</div>}
        {this.features.map((feature) => (
          <span className="gbx-badge" key={feature} data-feature={feature}>
            {feature}
            <button
              type="button"
              className="gbx-feature-remove"
              aria-label={`Remove ${feature}`}
              onClick={() => {
                this.features = this.features.filter((f) => f !== feature);
                this.update();
              }}
            >
              ×
            </button>
          </span>
        ))}
        <label className="gbx-config-row">
          <span className="gbx-sr-only">new feature</span>
          <input
            placeholder="feature"
            aria-label="new feature"
            data-add-gear-feature-input
            value={this.newFeature}
            onChange={(e) => {
              this.newFeature = e.target.value;
              this.update();
            }}
          />
          <button
            type="button"
            className="gbx-choice"
            data-add-gear-feature-add
            onClick={() => {
              const feature = this.newFeature.trim();
              if (feature === "" || this.features.includes(feature)) return;
              this.features = [...this.features, feature];
              this.newFeature = "";
              this.update();
            }}
          >
            Add feature
          </button>
        </label>
      </div>
    );
  }

  protected renderConfig(): React.ReactNode {
    return (
      <div className="gbx-config-list" data-add-gear-config>
        {this.config.length === 0 && <div className="gbx-empty">No configuration keys yet.</div>}
        {this.config.map((entry, index) => (
          <label key={`${entry.key}-${index}`} className="gbx-config-row" data-config-key={entry.key}>
            <input
              value={entry.key}
              aria-label="config key"
              onChange={(e) => {
                this.config = this.config.map((row, i) =>
                  i === index ? { ...row, key: e.target.value } : row,
                );
                this.update();
              }}
            />
            <input
              value={entry.value}
              aria-label="config value"
              onChange={(e) => {
                this.config = this.config.map((row, i) =>
                  i === index ? { ...row, value: e.target.value } : row,
                );
                this.update();
              }}
            />
            <button
              type="button"
              className="gbx-choice"
              onClick={() => {
                this.config = this.config.filter((_, i) => i !== index);
                this.update();
              }}
            >
              Remove
            </button>
          </label>
        ))}
        <label className="gbx-config-row">
          <span className="gbx-sr-only">new config key</span>
          <input
            placeholder="key"
            aria-label="new config key"
            data-add-gear-config-key
            value={this.newConfigKey}
            onChange={(e) => {
              this.newConfigKey = e.target.value;
              this.update();
            }}
          />
          <span className="gbx-sr-only">new config value</span>
          <input
            placeholder="value"
            aria-label="new config value"
            data-add-gear-config-value
            value={this.newConfigValue}
            onChange={(e) => {
              this.newConfigValue = e.target.value;
              this.update();
            }}
          />
          <button
            type="button"
            className="gbx-choice"
            data-add-gear-config-add
            onClick={() => {
              const key = this.newConfigKey.trim();
              if (key === "") return;
              this.config = [...this.config, { key, value: this.newConfigValue }];
              this.newConfigKey = "";
              this.newConfigValue = "";
              this.update();
            }}
          >
            Add key
          </button>
        </label>
      </div>
    );
  }

  protected renderPlugins(gear: GearDescriptor): React.ReactNode {
    const points = gear.extension_points ?? [];
    const candidates = this.catalogue.current.rows
      .filter((row): row is { kind: "projected"; gear: GearDescriptor } => row.kind === "projected")
      .map((row) => row.gear)
      .filter((candidate) => (candidate.fills ?? undefined) !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
    return (
      <div className="gbx-features-list" data-add-gear-plugins>
        <p className="gbx-add-gear-note">
          Extension points:{" "}
          {points.length === 0
            ? "none declared."
            : points.map((point) => `${point.trait_ident} (${point.sdk_lib})`).join(", ")}
        </p>
        {gear.config_schema !== null && gear.config_schema !== undefined && (
          <p data-add-gear-schema>
            Config schema: <code>{gear.config_schema}</code> (typed fields not projected yet —
            use string keys in Configuration).
          </p>
        )}
        {this.plugins.length === 0 && <div className="gbx-empty">No plugins selected.</div>}
        {this.plugins.map((plugin) => (
          <span className="gbx-badge" key={plugin} data-add-gear-plugin={plugin}>
            {plugin}
            <button
              type="button"
              className="gbx-feature-remove"
              aria-label={`Remove ${plugin}`}
              onClick={() => {
                this.plugins = this.plugins.filter((p) => p !== plugin);
                this.update();
              }}
            >
              ×
            </button>
          </span>
        ))}
        <label className="gbx-config-row">
          <select
            data-add-gear-plugin-pick
            value={this.newPlugin}
            onChange={(e) => {
              this.newPlugin = e.target.value;
              this.update();
            }}
          >
            <option value="">Select a plugin…</option>
            {candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.display_name} ({candidate.id})
              </option>
            ))}
          </select>
          <button
            type="button"
            className="gbx-choice"
            data-add-gear-plugin-add
            onClick={() => {
              const plugin = this.newPlugin.trim();
              if (plugin === "" || this.plugins.includes(plugin)) return;
              this.plugins = [...this.plugins, plugin];
              this.newPlugin = "";
              this.update();
            }}
          >
            Add plugin
          </button>
        </label>
      </div>
    );
  }

  protected renderClosure(): React.ReactNode {
    if (this.previewing) {
      return <div className="gbx-progress">previewing…</div>;
    }
    if (this.previewError !== undefined) {
      return (
        <div className="gbx-error" role="alert">
          {this.previewError}
        </div>
      );
    }
    if (this.preview === undefined) {
      return <div className="gbx-empty">Select a gear to preview the description write.</div>;
    }
    return (
      <div data-add-gear-closure>
        <pre className="gbx-edit-preview">{this.edits.formatDiff(this.preview)}</pre>
        <p className="gbx-add-gear-note">
          This is what will be written to the product description. The full resolution
          closure appears after Add.
        </p>
      </div>
    );
  }
}
