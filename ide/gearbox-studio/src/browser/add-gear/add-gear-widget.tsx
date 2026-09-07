// Add a gear to the open product: one panel with overview, options, what the
// addition would change, and a dry-run preview of the description write.
//
// Replaces the catalogue's immediate `+` toggle for *adding*. Removal still goes
// through `ProductEditService.toggle` (preview dialog + confirm). Features and
// config are collected here and applied after `addGear`, in that order.
//
// **The panel shows consequences before the write.** Section 6 resolves the
// product as it would be and subtracts the resolution on screen from it, so the
// closure, the processes and the bindings a gear brings with it are visible while
// the choice is still reversible. Section 7 stays the literal text diff -- the two
// answer different questions and neither replaces the other.
//
// **Errors warn, they do not block.** A resolution that fails after adding is a
// normal waypoint: building a product is add-a-gear-then-bind-it, and refusing the
// first step until the second is done makes the intermediate state unreachable.
// The count sits beside the button; the button stays live.

import { ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { ConfigValue } from "../../common/generated/ConfigValue";
import type { Diagnostic } from "../../common/generated/Diagnostic";
import type { EditGearResult } from "../../common/generated/EditGearResult";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { ProductEdit } from "../../common/generated/ProductEdit";
import { configKeyProblem, unknownConfigKeyNote } from "../../common/config-keys";
import { pluginsByPoint, pointKey, pointsOf } from "../../common/extension-points";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { ConfigFields } from "./config-fields";
import { type Impact, impactOf, isEmpty } from "./impact";
import type { ContextIdentity, OwnedWidget } from "../shell/screens";

/**
 * How long the panel waits before asking the engine what a change would do.
 *
 * A resolution is not free and every keystroke in a config value would ask for
 * one. Long enough that typing does not queue resolutions, short enough that the
 * answer arrives before attention moves on.
 */
const IMPACT_DEBOUNCE_MS = 400;

export interface AddGearState {
  /** Preselected gear id when opened from the catalogue `+`. */
  gearId?: string;
}

@injectable()
export class AddGearWidget extends ReactWidget implements OwnedWidget {
  static readonly ID = "gearbox.add-gear";
  static readonly LABEL = "Add Gear";
  /**
   * Which subject opened this wizard.
   *
   * Stamped by the contribution's `open*` path, read by the withdrawal sweep:
   * a proposal composed for one product must not survive into another, because
   * `ProductEditService` resolves the target at commit time and would otherwise
   * write it to whatever is open then. Undefined until something opens it.
   */
  ownerIdentity?: ContextIdentity;

  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;

  protected gearId: string | undefined;
  protected features: string[] = [];
  protected plugins: string[] = [];
  protected newFeature = "";
  protected newPlugin = "";
  protected config: Array<{ key: string; value: string }> = [];
  /**
   * Typed values the operator actually changed.
   *
   * Only touched keys, because the panel writes only what it holds: a form that
   * submitted every field would rewrite values nobody edited, normalising an
   * operator's `0x1F` or `8_087` on the way through.
   */
  protected typed = new Map<string, ConfigValue>();
  protected newConfigKey = "";
  protected newConfigValue = "";
  protected preview: EditGearResult | undefined;
  protected previewError: string | undefined;
  protected previewing = false;
  protected applying = false;
  protected impact: Impact | undefined;
  protected impactDiagnostics: readonly Diagnostic[] = [];
  protected impactError: string | undefined;
  protected impactPending = false;
  protected impactTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Which impact request is the current one.
   *
   * Answers arrive out of order once a person edits while one is in flight, and a
   * superseded answer describes a product they are no longer proposing.
   */
  protected impactToken = 0;
  /**
   * Same race as `impactToken`, for the text preview.
   *
   * `refreshImpact` already discarded stale resolutions; `refreshPreview` did not.
   * Staging while a dry-run is in flight let an older `after` overwrite a newer
   * one, and Apply trusts the panel -- so the review could disagree with the
   * batch about to be written.
   */
  protected previewToken = 0;
  protected openSections = new Set<string>([
    "overview",
    "compatibility",
    "features",
    "config",
    "plugins",
    "changes",
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
    this.toDispose.push({
      dispose: () => {
        if (this.impactTimer !== undefined) clearTimeout(this.impactTimer);
        // Anything already in flight belongs to a panel that is gone.
        this.impactToken += 1;
        this.previewToken += 1;
      },
    });
  }

  openWith(state?: AddGearState): void {
    this.gearId = state?.gearId;
    this.features = [];
    this.plugins = [];
    this.config = [];
    this.typed = new Map();
    this.newFeature = "";
    this.newPlugin = "";
    this.newConfigKey = "";
    this.newConfigValue = "";
    this.preview = undefined;
    this.previewError = undefined;
    this.previewing = false;
    this.applying = false;
    this.resetImpact();
    this.openSections = new Set([
      "overview",
      "compatibility",
      "features",
      "config",
      "plugins",
      "changes",
      "closure",
    ]);
    this.title.label = this.gearId !== undefined ? `Add ${this.gearId}` : AddGearWidget.LABEL;
    void this.refreshPreview();
    // Explicit, since `refreshPreview` stopped scheduling it: the two halves of
    // the answer are now driven by one debounce, and opening the panel is the
    // one path that is not a control change.
    this.scheduleImpact();
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
      this.previewToken += 1;
      this.preview = undefined;
      this.previewError = undefined;
      this.previewing = false;
      this.update();
      return;
    }
    const token = (this.previewToken += 1);
    const gearId = gear.id;
    this.previewing = true;
    this.update();
    const result = await this.edits.previewStagedAdd(
      this.stagedEdits(gear.id, gear.source),
      this.ownerIdentity,
    );
    if (token !== this.previewToken || this.gearId !== gearId) return;
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

  /** Forget the impact on screen: it described a proposal that no longer stands. */
  protected resetImpact(): void {
    if (this.impactTimer !== undefined) clearTimeout(this.impactTimer);
    this.impactTimer = undefined;
    this.impactToken += 1;
    this.previewToken += 1;
    this.impact = undefined;
    this.impactDiagnostics = [];
    this.impactError = undefined;
    this.impactPending = false;
  }

  /**
   * Ask again, after the debounce, what the current proposal would do **and**
   * what it would write.
   *
   * Called from every control that changes the proposal. `plugins` is the one that
   * genuinely moves the closure -- a plugin is itself a gear -- but features and
   * config go through the same batch, and a section that updated for some edits
   * and not others would teach the wrong thing about which edits matter.
   *
   * Both halves, since the addition and the follow-ups became one batch: the text
   * in section 7 is now the fold of everything staged, so it goes stale on
   * exactly the changes the impact does. Two debounces would have let the two
   * sections disagree about which proposal they were describing.
   */
  protected scheduleImpact(): void {
    if (this.impactTimer !== undefined) clearTimeout(this.impactTimer);
    // The proposal changed: anything already in flight describes the previous
    // one. Bump here, not only when the debounced run starts -- otherwise a
    // dry-run that finishes during the debounce window overwrites with stale
    // text (and Apply trusts that panel).
    this.impactToken += 1;
    this.previewToken += 1;
    this.impactPending = true;
    this.impactTimer = setTimeout(() => {
      this.impactTimer = undefined;
      void this.refreshPreview();
      void this.refreshImpact();
    }, IMPACT_DEBOUNCE_MS);
  }

  protected async refreshImpact(): Promise<void> {
    const gear = this.descriptor();
    if (gear === undefined) {
      this.resetImpact();
      this.update();
      return;
    }
    const token = (this.impactToken += 1);
    this.impactPending = true;
    this.update();

    const result = await this.edits.previewResolution(
      gear.id,
      gear.source,
      this.followUps(gear.id),
    );
    if (token !== this.impactToken) return;

    this.impactPending = false;
    if (result === undefined) {
      this.impact = undefined;
      this.impactDiagnostics = [];
      this.impactError = "Could not resolve the product with this gear added.";
      this.update();
      return;
    }
    this.impactError = undefined;
    this.impactDiagnostics = result.diagnostics ?? [];
    const current = this.products.current.resolution?.product ?? undefined;
    const proposed = result.product ?? undefined;
    if (proposed === null || proposed === undefined) {
      // The description did not evaluate at all. There is no "after" to subtract
      // the "before" from, and the diagnostics are the whole answer.
      this.impact = undefined;
      this.update();
      return;
    }
    this.impact = impactOf(
      current ?? undefined,
      proposed,
      this.products.current.diagnostics,
      this.impactDiagnostics,
    );
    this.update();
  }

  /** Errors the product does not have today and would have after this add. */
  protected newErrors(): readonly Diagnostic[] {
    const introduced = this.impact?.newDiagnostics ?? this.impactDiagnostics;
    return introduced.filter((diagnostic) => diagnostic.severity === "error");
  }

  /**
   * The whole proposal as one ordered batch, addition first.
   *
   * **Order is the point.** Every edit after the first names a gear, and until
   * the first has been folded onto the text that gear is not in the description
   * -- which is why the panel used to send the addition separately and could
   * preview only that. `apply_product_edits` folds these onto the same text in
   * order, so the batch is both the exact preview and the atomic write.
   */
  protected stagedEdits(gearId: string, source: string): ProductEdit[] {
    return [{ kind: "add_gear", gear: gearId, source }, ...this.followUps(gearId)];
  }

  protected followUps(gearId: string): ProductEdit[] {
    const edits: ProductEdit[] = [];
    if (this.features.length > 0) {
      edits.push({ kind: "set_features", gear: gearId, features: [...this.features] });
    }
    if (this.plugins.length > 0) {
      edits.push({ kind: "set_plugins", gear: gearId, plugins: [...this.plugins] });
    }
    for (const [key, value] of this.typed) {
      edits.push({ kind: "set_config", gear: gearId, key, value });
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
    const ok = await this.edits.commitAddGear(
      gear.id,
      this.stagedEdits(gear.id, gear.source),
      this.ownerIdentity,
    );
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
    const errors = this.newErrors();

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
                {this.renderSection("features", "3. Features", this.renderFeatures(gear))}
                {this.renderSection("config", "4. Configuration", this.renderConfig())}
                {this.renderSection("plugins", "5. Plugins", this.renderPlugins(gear))}
                {this.renderSection("changes", "6. What changes", this.renderChanges())}
                {this.renderSection("closure", "7. What will be written", this.renderClosure())}
              </>
            )}

            <div className="gbx-add-gear-actions">
              <button
                type="button"
                className="gbx-choice"
                data-add-gear-submit
                // Deliberately **not** disabled by resolution errors: adding a
                // gear before binding it is a normal step, and blocking here would
                // make that state unreachable. Disabled only when there is nothing
                // to write, or a write is already going on.
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
              {errors.length > 0 && (
                <span className="gbx-add-gear-warning" role="status" data-add-gear-error-warning>
                  <span className="codicon codicon-warning" />
                  {errors.length === 1
                    ? "1 new error after adding"
                    : `${errors.length} new errors after adding`}
                  {" — you can still add it and fix them next."}
                </span>
              )}
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
              // **Everything staged was staged about the previous gear.** A
              // feature name belongs to one crate's `[features]` table, a config
              // key to one struct, and a plugin to one host's extension point --
              // so carrying them across a change of subject would produce edits
              // for a gear that never asked for them, and the plugin list could
              // survive into a host that declares no point at all.
              this.features = [];
              this.plugins = [];
              this.config = [];
              this.typed.clear();
              this.newFeature = "";
              this.newPlugin = "";
              this.newConfigKey = "";
              this.newConfigValue = "";
              this.resetImpact();
              void this.refreshPreview();
              this.scheduleImpact();
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
            this.resetImpact();
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

  /**
   * The crate's own `[features]` table, as checkboxes, plus a way in for a name
   * the scan could not see.
   *
   * `use_gear(..., features = [...])` writes **Cargo** feature names. Nothing
   * projected the set of real ones, so this was a text box -- where a typo
   * becomes a feature that does not exist and a build failure two steps later,
   * and where "No features yet" could not be told from "this gear has none".
   * `GearDescriptor.available_features` answers both.
   *
   * **The list is uncurated, and the label says so.** `types-registry`'s only
   * feature is `integration`, which gates tests needing a Docker daemon; which
   * features an integrator should be offered is a declaration nobody has written
   * (ADR `cpt-gearbox-adr-create-product`, amendment 2026-09-07). Presenting the
   * projected list as if it were curated would be the drift ADR
   * `cpt-gearbox-adr-macro-projected-catalogue` exists to prevent.
   */
  protected renderFeatures(gear: GearDescriptor): React.ReactNode {
    const available = gear.available_features ?? [];
    const chosen = new Set(this.features);
    // A staged name the crate does not declare: kept and shown, because the scan
    // reads one manifest and a feature can come from a workspace-level table or
    // from a rename this projector does not follow. Marked, not hidden.
    const extra = this.features.filter((feature) => !available.includes(feature));
    return (
      <div className="gbx-features-list" data-add-gear-features>
        {available.length === 0 ? (
          <div className="gbx-empty" data-add-gear-features-none>
            This crate declares no Cargo features.
          </div>
        ) : (
          <>
            <p className="gbx-add-gear-note">
              Cargo features <code>{gear.package.crate_name}</code> declares. Some may exist for
              the crate&apos;s own tests rather than for a product.
            </p>
            <div className="gbx-feature-choices">
              {available.map((feature) => (
                <label
                  className="gbx-feature-choice"
                  key={feature}
                  data-add-gear-feature-option={feature}
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(feature)}
                    onChange={(e) => {
                      this.features = e.target.checked
                        ? [...this.features, feature]
                        : this.features.filter((f) => f !== feature);
                      this.scheduleImpact();
                      this.update();
                    }}
                  />
                  <code>{feature}</code>
                </label>
              ))}
            </div>
          </>
        )}
        {extra.map((feature) => (
          <span className="gbx-badge gbx-downgraded" key={feature} data-feature={feature}>
            {feature}
            <button
              type="button"
              className="gbx-feature-remove"
              aria-label={`Remove ${feature}`}
              onClick={() => {
                this.features = this.features.filter((f) => f !== feature);
                this.scheduleImpact();
                this.update();
              }}
            >
              ×
            </button>
          </span>
        ))}
        {/* Advanced, and deliberately last: a name outside the table is either a
            feature this projector could not see or a mistake, and the two look
            identical from here. */}
        <details className="gbx-advanced">
          <summary>Advanced: a feature name not in the table</summary>
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
              disabled={this.newFeature.trim() === ""}
              onClick={() => {
                const feature = this.newFeature.trim();
                if (feature === "" || this.features.includes(feature)) return;
                this.features = [...this.features, feature];
                this.newFeature = "";
                this.scheduleImpact();
                this.update();
              }}
            >
              Add feature
            </button>
          </label>
        </details>
      </div>
    );
  }

  protected renderConfig(): React.ReactNode {
    // The schema's fields as typed controls, then the untyped rows for anything
    // it does not cover -- a curated `exposes` is a subset, so a key outside it
    // may still be one the gear reads.
    const schema = this.descriptor()?.config_schema;
    const fields = schema?.fields ?? [];
    const keyProblem = configKeyProblem(this.newConfigKey);
    const keyNote =
      this.newConfigKey === ""
        ? undefined
        : unknownConfigKeyNote(this.newConfigKey.trim(), schema);
    return (
      <div className="gbx-config-list" data-add-gear-config>
        {fields.length > 0 && (
          <ConfigFields
            fields={fields}
            values={this.typed}
            onChange={(key, value) => {
              if (value === undefined) this.typed.delete(key);
              else this.typed.set(key, value);
              this.scheduleImpact();
              this.update();
            }}
          />
        )}
        {fields.length > 0 && (
          <p className="gbx-add-gear-note">
            Other keys, including anything nested, can be set as text below.
          </p>
        )}
        {this.config.length === 0 && fields.length === 0 && (
          <div className="gbx-empty">No configuration keys yet.</div>
        )}
        {this.config.map((entry, index) => (
          <label key={`${entry.key}-${index}`} className="gbx-config-row" data-config-key={entry.key}>
            <input
              value={entry.key}
              aria-label="config key"
              onChange={(e) => {
                this.config = this.config.map((row, i) =>
                  i === index ? { ...row, key: e.target.value } : row,
                );
                this.scheduleImpact();
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
                this.scheduleImpact();
                this.update();
              }}
            />
            <button
              type="button"
              className="gbx-choice"
              onClick={() => {
                this.config = this.config.filter((_, i) => i !== index);
                this.scheduleImpact();
                this.update();
              }}
            >
              Remove
            </button>
          </label>
        ))}
        {keyProblem !== undefined && this.newConfigKey !== "" && (
          <div className="gbx-inline-error" role="alert" data-config-key-error>
            {keyProblem}
          </div>
        )}
        {keyNote !== undefined && (
          <div className="gbx-inline-note" data-config-key-note>
            {keyNote}
          </div>
        )}
        <label className="gbx-config-row">
          <span className="gbx-sr-only">new config key</span>
          <input
            placeholder="key"
            aria-label="new config key"
            data-add-gear-config-key
            aria-invalid={keyProblem !== undefined && this.newConfigKey !== "" ? true : undefined}
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
            // Disabled on a key that could not be a field, rather than accepted
            // and reported after a resolve. `bad key = ...` used to write
            // cleanly, because a config key is a quoted dict key in the
            // description -- see `common/config-keys.ts`.
            disabled={this.newConfigKey === "" || keyProblem !== undefined}
            onClick={() => {
              const key = this.newConfigKey.trim();
              if (key === "" || configKeyProblem(key) !== undefined) return;
              this.config = [...this.config, { key, value: this.newConfigValue }];
              this.newConfigKey = "";
              this.newConfigValue = "";
              this.scheduleImpact();
              this.update();
            }}
          >
            Add key
          </button>
        </label>
      </div>
    );
  }

  /**
   * The plugins this host can actually take, grouped by the point they fill.
   *
   * **Unfiltered, this section offered a semantically impossible edit.** Every
   * gear in the catalogue that fills *any* point was in the list, so
   * `types-registry` -- three lines under the sentence "Extension points: none
   * declared." -- could be given `oidc-authn-plugin`, and section 6 then reported
   * it joining the closure as a "plugin of types-registry". Neither side refused
   * it: `set_gear_plugins` writes the list it is given, and the engine's check
   * asks whether *some* selected gear expects the point rather than whether this
   * host does (GBX0518 is the answer to that half).
   *
   * A choice that cannot be right is not offered here at all, rather than offered
   * and then reported as an error: this is a configurator, and the eCos lesson
   * the Conflicts screen already follows is that a tool which proposes states it
   * will later refuse teaches people to distrust it.
   */
  protected renderPlugins(gear: GearDescriptor): React.ReactNode {
    const points = pointsOf(gear);
    const rows = this.catalogue.current.rows
      .filter((row): row is { kind: "projected"; gear: GearDescriptor } => row.kind === "projected")
      .map((row) => row.gear);
    const groups = pluginsByPoint(gear, rows);
    const candidates = groups.flatMap((group) => group.plugins);
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
            Configured by <code>{gear.config_schema.rust}</code>, which exposes{" "}
            {(gear.config_schema.fields ?? []).length} setting
            {(gear.config_schema.fields ?? []).length === 1 ? "" : "s"}.
          </p>
        )}
        {points.length === 0 && (
          <div className="gbx-empty" data-add-gear-plugins-none>
            This gear declares no extension point, so there is nothing to plug into it.
          </div>
        )}
        {points.length > 0 && this.plugins.length === 0 && (
          <div className="gbx-empty">None selected yet.</div>
        )}
        {this.plugins.map((plugin) => (
          <span className="gbx-badge" key={plugin} data-add-gear-plugin={plugin}>
            {plugin}
            <button
              type="button"
              className="gbx-feature-remove"
              aria-label={`Remove ${plugin}`}
              onClick={() => {
                this.plugins = this.plugins.filter((p) => p !== plugin);
                this.scheduleImpact();
                this.update();
              }}
            >
              ×
            </button>
          </span>
        ))}
        {points.length > 0 && candidates.length === 0 && (
          <div className="gbx-empty" data-add-gear-plugins-unfilled>
            Nothing in the catalogue fills{" "}
            {points.map((point) => point.trait_ident).join(" or ")}.
          </div>
        )}
        {points.length > 0 && candidates.length > 0 && (
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
            {/* Grouped when the host declares several points -- `mini-chat`
                declares an audit point and a model-policy point, and a flat list
                would leave the reader to work out which of its plugins goes
                where. `optgroup` rather than a prefix in the label, so the
                grouping survives a screen reader. */}
            {groups.map((group) => (
              <optgroup key={pointKey(group.point)} label={group.point.trait_ident}>
                {group.plugins.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.display_name} ({candidate.id})
                  </option>
                ))}
              </optgroup>
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
              this.scheduleImpact();
              this.update();
            }}
          >
            Add plugin
          </button>
        </label>
        )}
      </div>
    );
  }

  /**
   * Section 6: what the product becomes, not what the file says.
   *
   * The rows are the difference between the resolution on screen and the one the
   * engine computed for the proposed description. Nothing here is derived from
   * rules this widget knows -- the closure and the binding modes are the engine's
   * answers, subtracted (`cpt-gearbox-fr-studio: no resolution logic`).
   */
  protected renderChanges(): React.ReactNode {
    if (this.impactError !== undefined) {
      return (
        <div className="gbx-error" role="alert" data-add-gear-impact-error>
          {this.impactError}
        </div>
      );
    }
    if (this.impact === undefined && this.impactPending) {
      return <div className="gbx-progress">working out what this changes…</div>;
    }
    const introduced = this.impact?.newDiagnostics ?? this.impactDiagnostics;
    if (this.impact === undefined) {
      if (introduced.length > 0) {
        return (
          <div data-add-gear-impact>
            <p className="gbx-add-gear-note">
              The product does not resolve with this gear added.
            </p>
            {this.renderImpactDiagnostics(introduced)}
          </div>
        );
      }
      return <div className="gbx-empty">Select a gear to see what it changes.</div>;
    }

    const impact = this.impact;
    return (
      <div data-add-gear-impact aria-busy={this.impactPending}>
        {this.impactPending && <div className="gbx-progress">recomputing…</div>}
        {isEmpty(impact) ? (
          <div className="gbx-empty" data-add-gear-impact-none>
            Nothing else changes: no new gears, processes or bindings.
          </div>
        ) : (
          <>
            {impact.arriving.length > 0 && (
              <div className="gbx-impact-group" data-add-gear-impact-closure>
                <div className="gbx-impact-title">
                  {impact.arriving.length === 1
                    ? "1 gear joins the closure"
                    : `${impact.arriving.length} gears join the closure`}
                </div>
                {impact.arriving.map((gear) => (
                  <div className="gbx-kv" key={gear.id} data-impact-gear={gear.id}>
                    <span className="gbx-id">{gear.id}</span>
                    <span>{gear.why}</span>
                  </div>
                ))}
              </div>
            )}

            {(impact.processesAdded.length > 0 ||
              impact.processesRemoved.length > 0 ||
              impact.moved.length > 0) && (
              <div className="gbx-impact-group" data-add-gear-impact-processes>
                <div className="gbx-impact-title">Processes</div>
                {impact.processesAdded.map((name) => (
                  <div className="gbx-kv" key={`+${name}`} data-impact-process-added={name}>
                    <span>new</span>
                    <span className="gbx-id">{name}</span>
                  </div>
                ))}
                {impact.processesRemoved.map((name) => (
                  <div className="gbx-kv" key={`-${name}`} data-impact-process-removed={name}>
                    <span>gone</span>
                    <span className="gbx-id">{name}</span>
                  </div>
                ))}
                {impact.moved.map((move) => (
                  <div className="gbx-kv" key={move.gear} data-impact-moved={move.gear}>
                    <span className="gbx-id">{move.gear}</span>
                    <span>
                      moves from {move.from} to {move.to}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {(impact.bindingsAdded.length > 0 || impact.bindingsChanged.length > 0) && (
              <div className="gbx-impact-group" data-add-gear-impact-bindings>
                <div className="gbx-impact-title">Contracts</div>
                {impact.bindingsAdded.map((binding) => (
                  <div
                    className="gbx-kv"
                    key={`+${binding.consumer}|${binding.contract}`}
                    data-impact-binding-added={binding.contract}
                  >
                    <span className="gbx-id">
                      {binding.consumer} → {binding.contract}
                    </span>
                    <span>new, {binding.after}</span>
                  </div>
                ))}
                {impact.bindingsChanged.map((binding) => (
                  <div
                    className="gbx-kv"
                    key={`~${binding.consumer}|${binding.contract}`}
                    data-impact-binding-changed={binding.contract}
                  >
                    <span className="gbx-id">
                      {binding.consumer} → {binding.contract}
                    </span>
                    <span>
                      was {binding.before}, becomes {binding.after}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {introduced.length > 0 && this.renderImpactDiagnostics(introduced)}
          </>
        )}
      </div>
    );
  }

  protected renderImpactDiagnostics(diagnostics: readonly Diagnostic[]): React.ReactNode {
    return (
      <div className="gbx-impact-group" data-add-gear-impact-diagnostics>
        <div className="gbx-impact-title">
          {diagnostics.length === 1 ? "1 new diagnostic" : `${diagnostics.length} new diagnostics`}
        </div>
        {diagnostics.map((diagnostic, index) => (
          <div
            className="gbx-kv"
            key={`${diagnostic.code}-${index}`}
            data-impact-diagnostic={diagnostic.severity}
          >
            <span className="gbx-id">{diagnostic.code}</span>
            <span>
              {diagnostic.message}
              {diagnostic.help !== null && diagnostic.help !== undefined && (
                <span className="gbx-add-gear-note"> {diagnostic.help}</span>
              )}
            </span>
          </div>
        ))}
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
          This is the text that will be written to the product description. What it
          does to the product is section 6.
        </p>
      </div>
    );
  }
}
