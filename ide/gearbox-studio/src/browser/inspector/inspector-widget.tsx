// What is selected, and why it is in the product.
//
// One panel, and it used to be two. `Gearbox Gear` rendered a `GearDescriptor`
// from a catalogue row; `Gearbox Explain` rendered the resolver's `because`
// sentences from a product focus. They sat side by side in the bottom bar and
// answered about two different selections, so the ordinary case -- click a gear
// in the product tree -- filled one and left the other saying "select a gear in
// the catalogue". Two panels, one of them always apologising.
//
// Merged, on one selection (`SelectionService`), the ordinary case finally works:
// choosing `api-gateway` anywhere says both what it is and why it is here. That
// pairing is the point of the panel and it was not previously reachable at all.
//
// The two sections keep their old class names, `gbx-detail` and `gbx-explain`.
// Not laziness: they *are* the detail and the explanation, now sections of one
// panel rather than two widgets, and every claim written against their markup
// keeps testing the same thing.
//
// Neither section composes anything. The facts are projected by the macro
// (ADR `cpt-gearbox-adr-macro-projected-catalogue`) and every step is a sentence
// the resolver wrote when it created the edge, while it still knew the specifics
// (`cpt-gearbox-fr-explain`). This walks and prints.

import { codicon, ReactWidget } from "@theia/core/lib/browser";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import type { ExplanationGraph } from "../../common/generated/ExplanationGraph";
import type { ExplanationNode } from "../../common/generated/ExplanationNode";
import type { ConfigValue } from "../../common/generated/ConfigValue";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { Location } from "../../common/generated/Location";
import type { ProvenanceEdge } from "../../common/generated/ProvenanceEdge";
import type { ResolvedProduct } from "../../common/generated/ResolvedProduct";
import type { Row } from "../../common/protocol";
import { configKeyProblem, unknownConfigKeyNote } from "../../common/config-keys";
import { CatalogueStore } from "../catalogue-store";
import { Focus, ProductStore } from "../product-store";
import { ProductEditService } from "../product-edit-service";
import { ConfigFields } from "../add-gear/config-fields";
import {
  describeFocus,
  nodeIdOf,
  provenanceOf,
  type ConfigSources,
} from "./effective-config";
import { RevealLink } from "../reveal-link";
import { RevealService } from "../reveal-service";
import { Selection, SelectionService } from "../shell/selection-service";

/** One rendered step: an edge, with both of its nodes resolved. */
interface Step {
  readonly edge: ProvenanceEdge;
  readonly from: ExplanationNode | undefined;
  readonly to: ExplanationNode | undefined;
  /** How many edges from the focus. Used only to indent. */
  readonly depth: number;
}


/**
 * Every reason reachable from `start`, nearest first.
 *
 * Breadth-first, and the direction matters: an edge runs *from* the thing being
 * explained *to* what explains it, so `gear:x -> profile:prod` reads "x is
 * selected-by prod". Following `from === current` therefore walks towards the
 * reasons; following the other way would walk towards the consequences, which
 * answers a different question.
 *
 * Nodes are visited once. The graph is a DAG by construction, but a repeated node
 * would still produce a repeated subtree, and "because api-gateway declares it"
 * printed four times is noise that hides the one line that matters.
 */
function reasonsFrom(graph: ExplanationGraph, start: string): Step[] {
  const steps: Step[] = [];
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; frontier.length > 0 && depth < 12; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of graph.edges) {
        if (edge.from !== current) continue;
        steps.push({
          edge,
          from: graph.nodes[edge.from],
          to: graph.nodes[edge.to],
          depth,
        });
        if (!seen.has(edge.to)) {
          seen.add(edge.to);
          next.push(edge.to);
        }
      }
    }
    frontier = next;
  }
  return steps;
}

/** Whether the resolution on screen contains the thing being explained. */
function isInResolution(product: ResolvedProduct, focus: Focus): boolean {
  switch (focus.kind) {
    case "gear":
      return Object.prototype.hasOwnProperty.call(product.gears, focus.id);
    case "application":
      return product.applications.some((application) => application.name === focus.id);
    case "binding":
      return (product.bindings ?? []).some(
        (binding) => binding.consumer === focus.consumer && binding.contract === focus.contract,
      );
  }
}

@injectable()
export class InspectorWidget extends ReactWidget {
  static readonly ID = "gearbox.inspector";
  static readonly LABEL = "Gearbox Inspector";

  @inject(SelectionService) protected readonly selection!: SelectionService;
  @inject(CatalogueStore) protected readonly catalogue!: CatalogueStore;
  @inject(ProductStore) protected readonly products!: ProductStore;
  @inject(RevealService) protected readonly reveals!: RevealService;
  @inject(ProductEditService) protected readonly edits!: ProductEditService;

  protected newConfigKey = "";
  protected newConfigValue = "";
  protected newFeature = "";

  @postConstruct()
  protected init(): void {
    this.id = InspectorWidget.ID;
    this.title.label = InspectorWidget.LABEL;
    this.title.iconClass = codicon("info");
    this.title.caption = InspectorWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-inspector");
    // Both stores, not the selection service alone. The selection can stay the
    // same while what is known about it changes -- a pending row projecting, a
    // re-resolve producing a different explanation -- and both of those change
    // what this panel should say.
    this.toDispose.push(this.selection.onDidChange(() => this.update()));
    this.toDispose.push(this.catalogue.onChanged(() => this.update()));
    this.toDispose.push(this.products.onChanged(() => this.update()));
    this.toDispose.push(
      this.edits.onDraftChanged(() => {
        // A draft dropped from the header leaves this panel's half-typed new-key
        // boxes behind, and they are not part of the draft, so nothing else can
        // clear them.
        if (!this.edits.hasDraft()) {
          this.clearScratch();
        }
        this.update();
      }),
    );
    this.update();
  }

  protected render(): React.ReactNode {
    const selection = this.selection.current;
    if (selection === undefined) {
      return (
        <div className="gbx-inspector gbx-empty">
          Select a gear in the catalogue, or a gear, application or binding in the Product view.
        </div>
      );
    }

    return (
      <div className="gbx-inspector" data-inspecting={keyOf(selection)}>
        {this.renderWhat(selection)}
        {this.renderWhy()}
      </div>
    );
  }

  /** The row a selection points at, whichever way it was made. */
  protected rowFor(selection: Selection): Row | undefined {
    if (selection.kind === "catalogue-row") return this.catalogue.row(selection.key);
    if (selection.kind !== "gear") return undefined;
    return this.catalogue.selectedRow;
  }

  // ---- what it is --------------------------------------------------------

  protected renderWhat(selection: Selection): React.ReactNode {
    const row = this.rowFor(selection);
    if (row === undefined) {
      // An application and a binding are not catalogue entries -- they are things the
      // resolver *made*, out of gears. So there is no descriptor to show, and
      // saying that is better than an empty box which reads as a load that
      // failed. What such a selection has instead is the section below.
      const noun = selection.kind === "catalogue-row" ? "row" : selection.kind;
      return (
        <div className="gbx-detail gbx-empty" data-no-descriptor={noun}>
          {selection.kind === "catalogue-row"
            ? "This row is no longer in the catalogue."
            : `A ${selection.kind} is not a catalogue entry: the resolver derives it from gears. ` +
              `What it is made of is in the Product view; why it exists is below.`}
        </div>
      );
    }

    if (row.kind === "pending") {
      // A pending row is not an error state, so it does not read like one. Its
      // description and path are known from S0/S1; the rest is genuinely not
      // known yet, and saying which is which is the whole point of the stage.
      return (
        <div className="gbx-detail">
          <div className="gbx-detail-title">
            {row.gear.display_name ?? row.gear.gdl_path}
            <span className="gbx-waiting">parsing…</span>
          </div>
          <div className="gbx-kv">
            <span>description</span>
            <span>{row.gear.description ?? "—"}</span>
          </div>
          <div className="gbx-kv">
            <span>category</span>
            <span>{row.gear.category ?? "—"}</span>
          </div>
          {this.renderPath(row.gear.source, row.gear.gdl_path)}
          <div className="gbx-empty">
            Capabilities, co-location, contracts and GTS types come from this gear's Rust
            attributes, which have not been read yet.
          </div>
        </div>
      );
    }

    return (
      <>
        {this.renderProjected(row.gear)}
        {this.renderProductGearEdit(selection, row.gear)}
      </>
    );
  }

  /**
   * Config and features for a gear the product asks for directly.
   *
   * Only when the gear is `selected` in the intent — pulled-in gears are not
   * edited here; their facts live in another `use_gear` entry or in the closure.
   */
  protected renderProductGearEdit(
    selection: Selection,
    descriptor: GearDescriptor,
  ): React.ReactNode {
    const gearId = descriptor.id;
    if (selection.kind !== "gear") return undefined;
    const intent = this.products.current.intent;
    if (intent === undefined) return undefined;
    const picked = intent.selected_gears.find((entry) => entry.gear === gearId);
    if (picked === undefined) return undefined;

    const config = this.edits.draftConfig(gearId, picked.config ?? {});
    // Fields the schema covers get typed controls; the text rows keep everything
    // else, so a key outside a curated `exposes` is still editable.
    const fields = descriptor.config_schema?.fields ?? [];
    const typedKeys = new Set(fields.map((f) => f.name));
    const untyped = Object.fromEntries(
      Object.entries(config).filter(([key]) => !typedKeys.has(key)),
    );
    const features = this.edits.draftFeatures(gearId, picked.features ?? []);
    // The curated list when the gear has one, the projected table otherwise --
    // the same fallback the Add Gear panel makes, and for the same reason: a
    // gear nobody has curated still has features worth offering.
    const curatedFeatures = descriptor.cargo_features;
    const available =
      curatedFeatures === undefined || curatedFeatures === null
        ? (descriptor.available_features ?? [])
        : curatedFeatures.map((feature) => feature.name);
    const chosenFeatures = new Set(features);
    const extraFeatures = features.filter((feature) => !available.includes(feature));
    const keyProblem = configKeyProblem(this.newConfigKey);
    const keyNote =
      this.newConfigKey === ""
        ? undefined
        : unknownConfigKeyNote(this.newConfigKey.trim(), descriptor.config_schema);

    return (
      <div className="gbx-product-edit" data-gear-config={gearId}>
        <div className="gbx-detail-title">in this product</div>
        {fields.length > 0 && (
          <ConfigFields
            fields={fields}
            values={this.edits.draftConfigValues(gearId, picked.config ?? {})}
            onChange={(key, value) => this.queueConfig(gearId, key, value)}
            provenanceOf={(key) =>
              provenanceOf(this.configSources(), gearId, key, picked.config ?? {})
            }
            isDrafted={(key) => this.edits.isDraftedConfig(gearId, key)}
            // A reset is a `set_config` with no value, which is how the wire
            // spells "remove this key" -- so it queues into the same draft and
            // waits for the same Apply as typing does.
            onReset={(key) => this.queueConfig(gearId, key, undefined)}
          />
        )}
        {/* **The free keys, under Advanced.** The typed controls above are what
            this gear exposes; this is the escape hatch for a curated `exposes`
            that is narrower than the struct it came from. Open when it already
            holds something, because a key somebody set is not advanced any more
            -- it is part of this product's description. */}
        <details
          className="gbx-advanced"
          open={Object.keys(untyped).length > 0}
          data-inspector-advanced
        >
          <summary>Other keys</summary>
          <span className="gbx-config-list" key={`cfg-${gearId}-${this.edits.epoch}`}>
            {Object.keys(untyped).length === 0 && (
              <span className="gbx-add-gear-note">
                Nothing outside the schema. A key the gear does not read is written and reported
                (GBX0115) rather than refused.
              </span>
            )}
            {Object.entries(untyped).map(([key, value]) => (
              <label key={key} className="gbx-config-row" data-config-key={key}>
                <code>{key}</code>
                <input
                  value={value}
                  aria-label={key}
                  data-config-edit={key}
                  data-field-modified={
                    this.edits.isDraftedConfig(gearId, key) ? "true" : undefined
                  }
                  onChange={(e) => this.queueConfig(gearId, key, e.target.value)}
                />
                <button
                  type="button"
                  className="gbx-choice"
                  data-config-remove={key}
                  onClick={() => this.queueConfig(gearId, key, undefined)}
                >
                  Remove
                </button>
              </label>
            ))}
            <button
              type="button"
              className="gbx-choice"
              data-add-config={gearId}
              disabled={this.newConfigKey === "" || keyProblem !== undefined}
              onClick={() => this.queueNewConfig(gearId)}
            >
              Add key
            </button>
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
                data-config-new-key
                placeholder="key"
                aria-label="new config key"
                aria-invalid={
                  keyProblem !== undefined && this.newConfigKey !== "" ? true : undefined
                }
                value={this.newConfigKey}
                onChange={(e) => {
                  this.newConfigKey = e.target.value;
                  this.update();
                }}
              />
              <span className="gbx-sr-only">new config value</span>
              <input
                data-config-new-value
                placeholder="value"
                aria-label="new config value"
                value={this.newConfigValue}
                onChange={(e) => {
                  this.newConfigValue = e.target.value;
                  this.update();
                }}
              />
            </label>
          </span>
        </details>
        <div className="gbx-kv">
          <span>features</span>
          {/* The crate's own `[features]` table, as checkboxes. One renderer's
              worth of duplication with the Add Gear panel is deliberate for now:
              the two carry different state (a draft here, a staged proposal
              there), and a control that disagreed with itself between them would
              be worse than two that agree by construction. */}
          <span className="gbx-features-list" key={`features-${gearId}-${this.edits.epoch}`}>
            {available.length === 0 && (
              <span className="gbx-empty" data-features-none>
                this crate declares no Cargo features
              </span>
            )}
            {available.length > 0 && (
              <span className="gbx-feature-choices">
                {available.map((feature) => (
                  <label
                    className="gbx-feature-choice"
                    key={feature}
                    data-feature-option={feature}
                    data-field-modified={
                      this.edits.isDraftedFeatures(gearId) ? "true" : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={chosenFeatures.has(feature)}
                      aria-label={feature}
                      onChange={(e) =>
                        this.queueFeatures(
                          gearId,
                          e.target.checked
                            ? [...features, feature]
                            : features.filter((f) => f !== feature),
                        )
                      }
                    />
                    <code>{feature}</code>
                  </label>
                ))}
              </span>
            )}
            {extraFeatures.map((feature) => (
              <span className="gbx-badge gbx-downgraded" key={feature} data-feature={feature}>
                {feature}
                <button
                  type="button"
                  className="gbx-feature-remove"
                  aria-label={`Remove ${feature}`}
                  onClick={() =>
                    this.queueFeatures(
                      gearId,
                      features.filter((f) => f !== feature),
                    )
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <details className="gbx-advanced">
              <summary>Advanced: a feature name not in the table</summary>
              <label className="gbx-config-row" data-feature-new>
                <span className="gbx-sr-only">new feature</span>
                <input
                  placeholder="feature"
                  aria-label="new feature"
                  value={this.newFeature}
                  onChange={(e) => {
                    this.newFeature = e.target.value;
                    this.update();
                  }}
                />
                <button
                  type="button"
                  className="gbx-choice"
                  data-add-feature={gearId}
                  disabled={this.newFeature.trim() === ""}
                  onClick={() => this.queueNewFeature(gearId, features)}
                >
                  Add feature
                </button>
              </label>
            </details>
          </span>
        </div>
      </div>
    );
  }

  /**
   * The two services a config answer is derived from, as one value.
   *
   * The Inspector and the chat's tools ask `effective-config` the same
   * questions, so the module takes its inputs rather than reaching for a
   * widget's fields. This is the widget's side of that bargain.
   */
  protected configSources(): ConfigSources {
    return { edits: this.edits, products: this.products };
  }

  protected queueNewConfig(gear: string): void {
    const key = this.newConfigKey.trim();
    // The same rule the button is disabled by, restated at the act: a keyboard
    // Enter, a test, or a future caller does not go through the button.
    if (key === "" || configKeyProblem(key) !== undefined) return;
    const value = this.newConfigValue;
    if (!this.queueConfig(gear, key, value === "" ? undefined : value)) return;
    this.newConfigKey = "";
    this.newConfigValue = "";
    this.update();
  }

  protected queueConfig(gear: string, key: string, value: ConfigValue | undefined): boolean {
    return this.edits.queueDraft({
      kind: "set_config",
      gear,
      key,
      value: value ?? null,
    });
  }

  protected queueFeatures(gear: string, features: readonly string[]): void {
    this.edits.queueDraft({
      kind: "set_features",
      gear,
      features: [...features],
    });
  }

  protected queueNewFeature(gear: string, current: readonly string[]): void {
    const feature = this.newFeature.trim();
    if (feature === "" || current.includes(feature)) return;
    this.newFeature = "";
    this.queueFeatures(gear, [...current, feature]);
  }

  /**
   * The scratch boxes this panel owns, cleared when the draft goes.
   *
   * The draft itself is dropped from the header now, so this reacts to
   * `onDraftChanged` rather than being the thing that discards: a half-typed new
   * key is this widget's state and nobody else can clear it, but it should not
   * survive a Discard the person asked for somewhere else.
   */
  protected clearScratch(): void {
    this.newConfigKey = "";
    this.newConfigValue = "";
    this.newFeature = "";
  }

  protected renderProjected(gear: GearDescriptor): React.ReactNode {
    const capabilities = this.catalogue.engineCapabilities;
    return (
      <div className="gbx-detail">
        <div className="gbx-detail-title">
          {gear.display_name} <span className="gbx-id">{gear.id}</span>
        </div>

        <div className="gbx-kv">
          <span>description</span>
          <span>{gear.description ?? "—"}</span>
        </div>
        <div className="gbx-kv">
          <span>capabilities</span>
          <span>
            {(gear.runtime_caps ?? []).map((cap) => (
              <span className="gbx-badge" key={cap}>
                {cap}
              </span>
            ))}
            {(gear.runtime_caps ?? []).length === 0 && "—"}
          </span>
        </div>
        <div className="gbx-kv">
          {/* Named "co-located with", not "depends on": these edges are link-time
              and the resolver can never sever them. */}
          <span>co-located with</span>
          <span>{(gear.colocated_deps ?? []).join(", ") || "—"}</span>
        </div>

        {(gear.extension_points ?? []).length > 0 && (
          <div className="gbx-kv">
            <span>extension points</span>
            <span>
              {(gear.extension_points ?? []).map((point) => (
                <div key={`${point.sdk_lib}::${point.trait_ident}`}>
                  <code>
                    {point.sdk_lib}::{point.trait_ident}
                  </code>
                  {gear.vendor_selector !== null && gear.vendor_selector !== undefined && (
                    <>
                      {" "}
                      selects vendor <code>{gear.vendor_selector}</code>
                    </>
                  )}
                </div>
              ))}
            </span>
          </div>
        )}

        {gear.fills && (
          <div className="gbx-kv">
            <span>fills</span>
            <span>
              <code>{gear.fills.point.trait_ident}</code>
              {gear.fills.default_vendor !== null && gear.fills.default_vendor !== undefined && (
                <>
                  {" "}
                  as vendor <code>{gear.fills.default_vendor}</code>
                </>
              )}
              {gear.fills.default_priority !== null && gear.fills.default_priority !== undefined && (
                <>, priority {gear.fills.default_priority}</>
              )}
            </span>
          </div>
        )}

        {(gear.provides ?? []).length > 0 && (
          <div className="gbx-kv">
            {/* The transports here are what this provider wires up, which is not
                the same as what the contract could support: api-contracts has a
                gRPC projection but leaves it behind an opt-in Cargo feature. */}
            <span>provides</span>
            <span>
              {(gear.provides ?? []).map((provide) => (
                <div key={provide.contract}>
                  <code>{provide.contract}</code> over{" "}
                  {provide.transports.map((t) => (
                    <span className="gbx-badge" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              ))}
            </span>
          </div>
        )}

        {(gear.gts_types ?? []).length > 0 && (
          <div className="gbx-kv">
            <span>GTS types</span>
            <span>
              {(gear.gts_types ?? []).map((type) => (
                <div key={type.type_id}>
                  <code>{type.type_id}</code>
                </div>
              ))}
            </span>
          </div>
        )}

        {gear.docs && (
          <div className="gbx-kv">
            <span>docs</span>
            <span className="gbx-links">
              {this.renderDocLink(gear.source, "PRD", gear.docs.prd)}
              {this.renderDocLink(gear.source, "DESIGN", gear.docs.design)}
              {(gear.docs.adr ?? []).map((adr) => this.renderDocLink(gear.source, adrLabel(adr), adr))}
              {!gear.docs.prd && !gear.docs.design && (gear.docs.adr ?? []).length === 0 && "—"}
            </span>
          </div>
        )}

        {this.renderPath(gear.source, gear.gdl_path)}

        {gear.config_schema !== null && gear.config_schema !== undefined && (
          <div className="gbx-kv">
            <span>config</span>
            <span>
              {(gear.config_schema.fields ?? []).length} setting
              {(gear.config_schema.fields ?? []).length === 1 ? "" : "s"} from{" "}
              <code>{gear.config_schema.rust}</code>
            </span>
          </div>
        )}

        {capabilities && !capabilities.resolve && (
          // Honest about the gap rather than showing an empty panel that reads as
          // a bug: the engine says it cannot resolve yet, so the UI says so too.
          <div className="gbx-gap">
            Bindings, applications and the lock need the resolver (M4). The engine reports{" "}
            <code>resolve: false</code>, so those panels are disabled rather than empty.
          </div>
        )}
      </div>
    );
  }

  protected renderPath(source: string, gdlPath: string): React.ReactNode {
    return (
      <div className="gbx-kv">
        <span>description file</span>
        <span className="gbx-links">{this.renderLink(source, gdlPath, gdlPath)}</span>
      </div>
    );
  }

  protected renderDocLink(
    source: string,
    label: string,
    target: string | null | undefined,
  ): React.ReactNode {
    if (target === null || target === undefined) {
      return undefined;
    }
    return this.renderLink(source, target, label);
  }

  /**
   * One link, opened through the opener rather than by the browser.
   *
   * Shared with the Product view. The reasoning for a real `href` rather than a
   * div with an `onClick` lives with the component.
   */
  protected renderLink(source: string, target: string, label: string): React.ReactNode {
    return (
      <RevealLink key={target} reveals={this.reveals} source={source} target={target} label={label} />
    );
  }

  // ---- why it is here ---------------------------------------------------

  protected renderWhy(): React.ReactNode {
    const focus = this.products.focus;
    const graph = this.products.current.resolution?.explanation ?? undefined;

    if (graph === undefined) {
      return (
        <div className="gbx-explain gbx-empty">
          Resolve a product to ask why. The explanation arrives with the resolution.
        </div>
      );
    }
    if (focus === undefined) {
      // Reachable with something selected: a pending catalogue row has no
      // `GearId`, and the graph is keyed by id.
      return (
        <div className="gbx-explain gbx-empty">
          This row has not been parsed yet, so there is no id to ask about. The explanation is
          keyed by gear id.
        </div>
      );
    }

    const id = nodeIdOf(focus);
    const node = graph.nodes[id];
    if (node === undefined) {
      // Three different situations used to share one alarming message, and the
      // ordinary one is by far the most common: a selection survives a profile
      // switch, and `oidc-authn-plugin` simply is not in the dev resolution. That
      // is not a fault, and reading like one trains people to ignore the message
      // that does matter.
      const product = this.products.current.resolution?.product ?? undefined;
      const profile = product?.product.profile ?? this.products.current.profile ?? "this profile";
      if (product !== undefined && !isInResolution(product, focus)) {
        return (
          <div className="gbx-explain gbx-empty" data-not-in-profile={id}>
            {describeFocus(focus)} is not part of the <code>{profile}</code> resolution. Select
            something in this profile, or switch back.
          </div>
        );
      }
      // In the resolution and still absent from the graph: either the resolver
      // recorded no provenance for it, or the `{kind}:{payload}` convention --
      // which the client writes down a second time -- has drifted. Worth an
      // alarm, because both are defects.
      return (
        <div className="gbx-explain">
          <div className="gbx-error" role="alert">
            <code>{id}</code> is in the {profile} resolution but has no node in its explanation
            graph, which has {Object.keys(graph.nodes).length}. Either no provenance was recorded
            for it or the node-id convention has changed.
          </div>
        </div>
      );
    }

    const steps = reasonsFrom(graph, id);
    return (
      <div className="gbx-explain" data-explaining={id}>
        <div className="gbx-detail-title">
          why {describeFocus(focus)} <span className="gbx-id">{node.kind}</span>
        </div>
        {steps.length === 0 ? (
          <div className="gbx-empty">
            Nothing follows from this node: it is a root of the explanation.
          </div>
        ) : (
          <ol className="gbx-narrative">{steps.map((step, index) => this.renderStep(step, index))}</ol>
        )}
      </div>
    );
  }

  protected renderStep(step: Step, index: number): React.ReactNode {
    const { edge, from, to, depth } = step;
    const downgrade = edge.kind === "downgraded-by";
    return (
      <li
        className={`gbx-step ${downgrade ? "gbx-step-downgrade" : ""}`}
        key={`${edge.from}->${edge.to}-${edge.kind}-${index}`}
        style={{ marginLeft: `${depth * 14}px` }}
        data-step-kind={edge.kind}
        data-step-to={edge.to}
      >
        {/* The sentence first and the machinery second. The `because` string is
            the answer; the kind and the target are how to check it. */}
        <div className="gbx-step-because">{edge.because}</div>
        <div className="gbx-step-meta">
          <span className="gbx-badge">{edge.kind}</span>
          <span className="gbx-id">{to?.label ?? edge.to}</span>
          {this.renderOrigin(from?.origin ?? undefined)}
        </div>
      </li>
    );
  }

  /**
   * A link to the file the fact was declared in.
   *
   * An `<a>` with a real `href`, not a div with an onClick: the href is what gives
   * keyboard activation, a focus ring, a status-bar target and something for a
   * screen reader to announce. `preventDefault` keeps the navigation inside Theia.
   */
  protected renderOrigin(origin: Location | undefined): React.ReactNode {
    if (origin === undefined || origin === null) return undefined;
    const line = origin.range.start.line + 1;
    const name = origin.uri.split("/").pop() ?? origin.uri;
    return (
      <a
        className="gbx-step-origin"
        href={origin.uri}
        onClick={(event) => {
          event.preventDefault();
          void this.reveals.revealLocation(origin);
        }}
      >
        {name}:{line}
      </a>
    );
  }
}

/** A stable attribute value for whatever is selected, for tests and for debugging. */
function keyOf(selection: Selection): string {
  switch (selection.kind) {
    case "gear":
    case "application":
      return `${selection.kind}:${selection.id}`;
    case "binding":
      return `binding:${selection.consumer}|${selection.contract}`;
    case "catalogue-row":
      return `row:${selection.key}`;
  }
}

/**
 * `ADR 001` rather than `001-provider-compatibility-and-performance.md`.
 *
 * `cluster` has nine ADRs and `types-registry` fifteen, with names long enough
 * that the full filenames wrapped to three lines and read as a paragraph rather
 * than as a list. The number is the part anyone actually cites; the filename stays
 * in the link's tooltip.
 */
function adrLabel(target: string): string {
  const file = basename(target);
  const numbered = /^(\d+)/.exec(file);
  return numbered ? `ADR ${numbered[1]}` : file.replace(/\.md$/, "");
}

function basename(target: string): string {
  const parts = target.split("/");
  return parts[parts.length - 1] ?? target;
}
