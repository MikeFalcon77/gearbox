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
import type { ExtensionPointDecl } from "../../common/generated/ExtensionPointDecl";
import type { HostStanding } from "../create/gear-edits";
import { DiagnosticsList } from "../diagnostics/diagnostics-list";
import { RevealService } from "../reveal-service";
import { CatalogueStore } from "../catalogue-store";
import { ProductEditService } from "../product-edit-service";
import { ProductStore } from "../product-store";
import { ConfigFields, valueProblem } from "./config-fields";
import { stagedEditsFor } from "./staged-edits";
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
  // A diagnostic row can open the line that causes it, which is the half of a
  // diagnostic this panel used to drop.
  @inject(RevealService) protected readonly reveals!: RevealService;

  protected gearId: string | undefined;
  protected features: string[] = [];

  /**
   * The host a chosen *plugin* will be attached to.
   *
   * Empty until decided, and a plugin cannot be added until it is: the only form
   * a plugin takes in a description is an entry inside a host's `use_gear`.
   */
  protected host = "";
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
    // The plugin path's own section, in place of features/config/plugins.
    "host",
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
    // The same reset a change of gear does, because opening the panel *is* one:
    // the previous visit staged its edits about whatever it was told to add.
    this.resetProposal();
    this.preview = undefined;
    this.previewError = undefined;
    this.previewing = false;
    this.applying = false;
    this.resetImpact();
    this.openSections = new Set([
      "overview",
      "compatibility",
      "host",
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

  /**
   * Why there is nothing to resolve or write yet, if there is nothing.
   *
   * **A plugin with no host stages no edits at all**, and asking the engine
   * about an empty proposal produced the worst of both: the section said "choose
   * a host" while the impact pane described a top-level addition nobody had
   * asked for. Repeating the reason in both places is the honest answer -- the
   * question they answer has no answer yet.
   */
  protected proposalProblem(): string | undefined {
    const point = this.fillsPoint();
    if (point === undefined) return undefined;
    const hosts = this.hostsForPlugin();
    if (hosts.length === 0) {
      return (
        `Nothing in this product declares ${point.trait_ident}, so there is nothing for ` +
        `this plugin to fill. Add a gear that declares it first.`
      );
    }
    if (this.host === "") {
      return `Choose the gear ${this.descriptor()?.id ?? "this plugin"} fills, above.`;
    }
    return undefined;
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
    // Same rule as the impact: nothing is sent while the proposal is not one.
    const blocking = this.proposalProblem();
    if (blocking !== undefined) {
      this.previewToken += 1;
      this.preview = undefined;
      this.previewError = blocking;
      this.previewing = false;
      this.update();
      return;
    }
    // And a value that cannot be written is not sent to be written: the engine's
    // refusal would arrive as a failure of the whole proposal, beside a field
    // that already says what is wrong with it.
    const problem = this.stagedProblem();
    if (problem !== undefined) {
      this.previewToken += 1;
      this.preview = undefined;
      this.previewError = problem;
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
      // A plugin is attached and a gear is named, so an unchanged description
      // means two different things -- and saying "already named" about a plugin
      // describes a form the corpus never uses.
      this.previewError = result.changed
        ? undefined
        : this.fillsPoint() !== undefined
          ? `${gear.id} is already attached to ${this.host === "" ? "that gear" : this.host}.`
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
  /**
   * The staged value that will not do, before anything is sent.
   *
   * **A dry run is not sent while a field is locally invalid**, and the reason is
   * not saving a round trip: the engine's answer to an invalid value is a refusal
   * about the whole proposal, which lands in the impact pane and reads as "this
   * gear cannot be added" -- next to a field that already says what is wrong with
   * it. Two answers to one question, the less useful one louder.
   */
  protected stagedProblem(): string | undefined {
    const fields = this.descriptor()?.config_schema?.fields ?? [];
    for (const field of fields) {
      const problem = valueProblem(field, this.typed.get(field.name));
      if (problem !== undefined) return problem;
    }
    return undefined;
  }

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

  /**
   * The impact, unless a field already says why it cannot be computed.
   *
   * The guard is here rather than in `scheduleImpact` so the *pane* still says
   * something: a person who has just made a field invalid should see why the
   * answer is missing, not an answer that quietly stopped updating.
   */
  /**
   * Forget everything staged about the gear that was the subject.
   *
   * **One method, used by every change of subject**, because the list had grown
   * to eight fields and the two places that change the subject had drifted: the
   * host a plugin was to be attached to survived a change of plugin, so
   * `OIDC -> authn-resolver -> another plugin` reported the new plugin as
   * "already attached to authn-resolver" while the section above correctly said
   * `authn-resolver` declares no point it fills.
   *
   * Everything here belongs to one gear and to no other: a feature name to one
   * crate's `[features]` table, a config key to one struct, a plugin list to one
   * host's extension point, and a host to one plugin's point.
   */
  protected resetProposal(): void {
    // **Seeded, not emptied, when the gear declares features for this kind.**
    // `k8s-auth` is what a Kubernetes deployment needs rather than something it
    // may have, so starting unchecked would make the ordinary path the one that
    // has to be remembered. Still a checkbox: unticking it is a choice the
    // description then records, which is why the resolver does not add it back.
    this.features = this.defaultFeatures();
    this.plugins = [];
    this.config = [];
    this.typed.clear();
    this.host = "";
    this.newFeature = "";
    this.newPlugin = "";
    this.newConfigKey = "";
    this.newConfigValue = "";
    this.resetImpact();
  }

  protected async refreshImpact(): Promise<void> {
    const blocking = this.proposalProblem();
    if (blocking !== undefined) {
      this.impactToken += 1;
      this.impactPending = false;
      this.impact = undefined;
      this.impactDiagnostics = [];
      this.impactError = blocking;
      this.update();
      return;
    }
    const problem = this.stagedProblem();
    if (problem !== undefined) {
      this.impactToken += 1;
      this.impactPending = false;
      this.impact = undefined;
      this.impactDiagnostics = [];
      this.impactError = problem;
      this.update();
      return;
    }
    await this.refreshImpactGuarded();
  }

  protected async refreshImpactGuarded(): Promise<void> {
    const gear = this.descriptor();
    if (gear === undefined) {
      this.resetImpact();
      this.update();
      return;
    }
    const token = (this.impactToken += 1);
    this.impactPending = true;
    this.update();

    // **The same array the dry run and the write get.** It used to pass the gear
    // and its source as a separate `add`, which is a second description of the
    // proposal -- and the two disagreed as soon as a proposal stopped being a
    // top-level addition. For a plugin the write was `add_plugin` while this went
    // on asking what a top-level `use_gear` would do, so the panel reported "1
    // gear joins the closure" next to its own refusal to add it that way.
    const result = await this.edits.previewResolution(this.stagedEdits(gear.id, gear.source));
    if (token !== this.impactToken) return;

    this.impactPending = false;
    if (!result.ok) {
      // **The engine's own reason, not a sentence invented here.** This used to
      // read "Could not resolve the product with this gear added", which is true
      // of every failure and useful for none of them -- while the engine had
      // said what was wrong. A whole-proposal failure belongs here, beside the
      // proposal; a failure about one key is reported at that key.
      this.impact = undefined;
      this.impactDiagnostics = [];
      this.impactError = result.reason;
      this.update();
      return;
    }
    this.impactError = undefined;
    this.impactDiagnostics = result.resolution.diagnostics ?? [];
    const current = this.products.current.resolution?.product ?? undefined;
    const proposed = result.resolution.product ?? undefined;
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
  /**
   * Which host in this product the plugin will be attached to.
   *
   * Restricted to hosts the product already has *and* that declare the point
   * this plugin fills: attaching needs a `use_gear` to attach to, and the point
   * has to match or the resolver is being told something untrue. A host the
   * closure pulled in is promoted to an explicit selection in the same batch,
   * which is a visible change to the description and is previewed as one.
   */
  protected renderHostChoice(): React.ReactNode {
    const point = this.fillsPoint();
    if (point === undefined) return undefined;
    const hosts = this.hostsForPlugin();
    return (
      <div data-add-gear-host>
        <div className="gbx-kv">
          <span>fills</span>
          <span>
            <code>{pointKey(point)}</code>
          </span>
        </div>
        {hosts.length === 0 ? (
          <div className="gbx-empty" data-add-gear-host-none>
            Nothing in this product declares <code>{point.trait_ident}</code>, so there is nothing
            for this plugin to fill. Add a gear that declares it first.
          </div>
        ) : (
          <label className="gbx-config-row">
            <span>Attach to</span>
            <select
              data-add-gear-host-pick
              value={this.host}
              onChange={(e) => {
                this.host = e.target.value;
                this.scheduleImpact();
                this.update();
              }}
            >
              <option value="">— choose the gear it fills —</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.id}
                  {host.standing === "closure-only" ? " (will be named explicitly)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    );
  }

  /**
   * The gear this panel is about, when it is a plugin rather than a gear.
   *
   * `fills` is what says so, and it is projected from the plugin-API trait the
   * SDK declares -- so this is reading the catalogue rather than guessing from a
   * name.
   */
  protected fillsPoint(): ExtensionPointDecl | undefined {
    return this.descriptor()?.fills?.point ?? undefined;
  }

  /**
   * The hosts in this product that declare the point the chosen plugin fills.
   *
   * Restricted to the product, because attaching needs a host the description
   * has -- and to the *matching* point, because `fillsPointOf` is the predicate
   * that stops `types-registry` being given an authentication plugin.
   */
  protected hostsForPlugin(): { id: string; source: string; standing: HostStanding }[] {
    const point = this.fillsPoint();
    if (point === undefined) return [];
    const wanted = pointKey(point);
    const state = this.products.current;
    const resolved = state.resolution?.product;
    const rows = this.catalogue.current.rows;
    const out: { id: string; source: string; standing: HostStanding }[] = [];
    for (const row of rows) {
      if (row.kind !== "projected") continue;
      if (!pointsOf(row.gear).some((p) => pointKey(p) === wanted)) continue;
      const id = row.gear.id;
      const named = state.intent?.selected_gears?.some((sel) => sel.gear === id) === true;
      const inClosure = resolved !== null && resolved !== undefined && id in resolved.gears;
      if (!named && !inClosure) continue;
      out.push({ id, source: row.gear.source, standing: named ? "named" : "closure-only" });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * The proposal, as edits.
   *
   * **A plugin is attached, not selected**, and this used to be the one place
   * that did not know it: the batch always began with `add_gear`, so choosing
   * `oidc-authn-plugin` from the catalogue wrote
   * `use_gear("oidc-authn-plugin", ...)` -- a form the corpus never uses, which
   * makes the plugin a gear the product selected in its own right and leaves it
   * filling nothing.
   *
   * Attaching also means the follow-ups do not apply. `set_config` and
   * `set_features` are span surgery on a `use_gear` entry, and a plugin has
   * none; per-plugin `config` and `profiles` live inside the `plugin(...)` entry,
   * which no edit on this protocol can write yet. So the panel does not offer
   * them for a plugin -- a choice that cannot be right is not offered, which is
   * the rule ADR-0013 already states.
   */
  protected stagedEdits(gearId: string, source: string): ProductEdit[] {
    const isPlugin = this.fillsPoint() !== undefined;
    const host = this.hostsForPlugin().find((entry) => entry.id === this.host);
    return [
      ...stagedEditsFor({
        gearId,
        source,
        ...(isPlugin ? { plugin: { ...(host === undefined ? {} : { host }) } } : {}),
        followUps: this.followUps(gearId),
      }),
    ];
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
    // Again here, and not only on the button: a keybinding, a stale render or a
    // click landing in the same tick as a keystroke all reach this without the
    // button having been re-evaluated. The rule is about what may be written,
    // so it belongs where the write happens.
    const problem = this.stagedProblem();
    if (problem !== undefined) {
      this.impactError = problem;
      this.update();
      return;
    }
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
                {/* **A plugin is attached, and the rest does not apply to it.**
                    `set_config` and `set_features` are span surgery on a
                    `use_gear` entry and a plugin has none; per-plugin `config`
                    and `profiles` live inside the `plugin(...)` entry, which no
                    edit on this protocol writes yet. Offering them would be
                    offering a choice that cannot be right, which is the rule
                    ADR-0013 states -- and the one the plugin filter already
                    follows one section down. */}
                {this.fillsPoint() !== undefined
                  ? this.renderSection("host", "3. What it fills", this.renderHostChoice())
                  : (
                      <>
                        {this.renderSection("features", "3. Features", this.renderFeatures(gear))}
                        {this.renderSection("config", "4. Configuration", this.renderConfig())}
                        {this.renderSection("plugins", "5. Plugins", this.renderPlugins(gear))}
                      </>
                    )}
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
                // And on a field that already says it cannot be written. That
                // check used to live only in the debounce, so for the 400 ms
                // before the next preview the button was live over a value the
                // panel had already refused -- a window in which Add wrote
                // something the field was complaining about.
                disabled={
                  gear === undefined ||
                  this.applying ||
                  this.previewing ||
                  this.stagedProblem() !== undefined ||
                  // A plugin with no host chosen produces no edits at all, so
                  // there is nothing to add -- said by the control rather than
                  // by a refusal after the click.
                  (this.fillsPoint() !== undefined && this.host === "") ||
                  this.preview?.changed !== true
                }
                data-add-gear-apply
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
              this.resetProposal();
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
            this.title.label = AddGearWidget.LABEL;
            this.resetProposal();
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
  /** The deployment kind this product is resolving for, when it has resolved. */
  protected profileKind(): string | undefined {
    return this.products.current.resolution?.product?.product.profile_kind;
  }

  /**
   * Which features to offer, and which of those belong to this deployment kind.
   *
   * `cargo_features` is the curated half, and when a gear has one it replaces
   * the projected table rather than filtering it: curation is a judgement about
   * what an integrator should see, and showing the rest beside it would undo
   * the judgement. A gear nobody has curated falls back to the projected list,
   * which is why both fields exist.
   */
  protected featureChoices(gear: GearDescriptor): {
    offered: string[];
    elsewhere: { name: string; kinds: string[] }[];
    curated: boolean;
  } {
    // `null`/absent is "nobody curated this"; an empty list is a curation that
    // offers nothing. Only the first falls back to the projected table.
    const curated = gear.cargo_features;
    if (curated === undefined || curated === null) {
      return { offered: [...(gear.available_features ?? [])], elsewhere: [], curated: false };
    }
    const kind = this.profileKind();
    const offered: string[] = [];
    const elsewhere: { name: string; kinds: string[] }[] = [];
    for (const feature of curated) {
      const kinds = feature.kinds ?? [];
      // An empty `kinds` is "every kind", and an unresolved profile is not a
      // reason to hide anything: offering it and letting GBX0316 answer is
      // better than a panel that silently shrinks while a resolution is in
      // flight.
      if (kinds.length === 0 || kind === undefined || kinds.includes(kind)) {
        offered.push(feature.name);
      } else {
        elsewhere.push({ name: feature.name, kinds: [...kinds] });
      }
    }
    return { offered, elsewhere, curated: true };
  }

  /** Curated features this deployment kind is the reason for, ticked to begin with. */
  protected defaultFeatures(): string[] {
    const gear = this.descriptor();
    const kind = this.profileKind();
    if (gear === undefined || kind === undefined) return [];
    return (gear.cargo_features ?? [])
      .filter((feature) => (feature.kinds ?? []).includes(kind))
      .map((feature) => feature.name);
  }

  protected renderFeatures(gear: GearDescriptor): React.ReactNode {
    const { offered: available, elsewhere, curated } = this.featureChoices(gear);
    const chosen = new Set(this.features);
    // A staged name the crate does not declare: kept and shown, because the scan
    // reads one manifest and a feature can come from a workspace-level table or
    // from a rename this projector does not follow. Marked, not hidden.
    const extra = this.features.filter((feature) => !available.includes(feature));
    return (
      <div className="gbx-features-list" data-add-gear-features>
        {available.length === 0 && elsewhere.length === 0 ? (
          <div className="gbx-empty" data-add-gear-features-none>
            {curated
              ? "This gear offers no Cargo features."
              : "This crate declares no Cargo features."}
          </div>
        ) : (
          <>
            <p className="gbx-add-gear-note">
              {curated ? (
                <>
                  Cargo features <code>{gear.package.crate_name}</code> offers for this
                  deployment.
                </>
              ) : (
                <>
                  Cargo features <code>{gear.package.crate_name}</code> declares. Some may exist
                  for the crate&apos;s own tests rather than for a product.
                </>
              )}
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
        {/* Named, not hidden. Someone looking for `k8s-auth` on a local profile
            needs to be told it exists and why it is not here; a list that
            silently omits it reads as a missing feature. */}
        {elsewhere.length > 0 && (
          <p className="gbx-add-gear-note" data-add-gear-features-elsewhere>
            Not for this deployment:{" "}
            {elsewhere.map((feature, index) => (
              <span key={feature.name} data-add-gear-feature-elsewhere={feature.name}>
                {index > 0 && ", "}
                <code>{feature.name}</code> ({feature.kinds.join(", ")})
              </span>
            ))}
          </p>
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
        {fields.length === 0 && (
          <div className="gbx-empty" data-add-gear-config-none>
            {schema === null || schema === undefined
              ? "This gear exposes no configuration. Anything typed below is a key the description will carry and the resolver will report as unknown (GBX0115)."
              : "This gear's schema exposes no fields yet."}
          </div>
        )}
        {/* **Free keys under Advanced, and the reason is what a UX pass hit.**
            A gear with no schema still offered a bare `Add key`, so the obvious
            thing to do with it was type something -- and the only answer was
            "could not resolve the product with this gear added". A control that
            is available invites use; the ones the gear actually exposes are
            above, and this is the escape hatch for a curated `exposes` that is
            narrower than the struct.
            *
            `<details>`, open when it already holds something, because a key
            somebody set is not advanced any more -- it is the state of this
            proposal. The same idiom the undeclared-features row uses. */}
        <details className="gbx-advanced" open={this.config.length > 0} data-add-gear-advanced>
          <summary>Other keys</summary>
          <p className="gbx-add-gear-note">
            Anything the schema does not cover, including nested values, as text. A key the gear
            does not read is written and reported rather than refused, because a curated
            <code> exposes</code> is narrower than the struct it came from.
          </p>
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
        </details>
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
            Nothing else changes: no new gears, applications or bindings.
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

            {(impact.applicationsAdded.length > 0 ||
              impact.applicationsRemoved.length > 0 ||
              impact.moved.length > 0) && (
              <div className="gbx-impact-group" data-add-gear-impact-applications>
                <div className="gbx-impact-title">Processes</div>
                {impact.applicationsAdded.map((name) => (
                  <div className="gbx-kv" key={`+${name}`} data-impact-application-added={name}>
                    <span>new</span>
                    <span className="gbx-id">{name}</span>
                  </div>
                ))}
                {impact.applicationsRemoved.map((name) => (
                  <div className="gbx-kv" key={`-${name}`} data-impact-application-removed={name}>
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

  /**
   * What this proposal would introduce, in the same rows the Conflicts screen uses.
   *
   * These were key-value lines carrying code, message and help, which is three of
   * the six fields a diagnostic has -- so a `location` pointing at the line that
   * causes the problem, and the `related` places it also touches, were dropped
   * exactly where a person is deciding whether to accept them. One renderer, so
   * the panel a diagnostic appears in cannot decide whether its remedy is
   * visible.
   *
   * No `onExplain`: the subject of one of these is a node in a resolution that
   * does not exist yet, so there is nothing for the Inspector to be pointed at.
   * The control is omitted rather than rendered dead.
   */
  protected renderImpactDiagnostics(diagnostics: readonly Diagnostic[]): React.ReactNode {
    return (
      <div className="gbx-impact-group" data-add-gear-impact-diagnostics>
        <div className="gbx-impact-title">
          {diagnostics.length === 1 ? "1 new diagnostic" : `${diagnostics.length} new diagnostics`}
        </div>
        <DiagnosticsList
          diagnostics={diagnostics}
          density="compact"
          onReveal={(location) => void this.reveals.revealLocation(location)}
        />
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
