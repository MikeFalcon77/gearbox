/**
 * Config and features for one gear the product asks for directly.
 *
 * **Extracted from the Inspector so two surfaces can render it.** The
 * Composition pane shows these controls beside the tree and the Inspector shows
 * them in the right panel; before this they were a method on `InspectorWidget`,
 * which meant the Product widget had to hold an instance of that widget and call
 * its `renderContent()` to get them. Two surfaces then shared one widget's
 * half-typed new-key boxes, so typing a key in one changed the other.
 *
 * The scratch boxes are local state here, so each surface keeps its own. They
 * are reset by remounting: the caller keys this component on the draft epoch,
 * which is what a Discard or an Apply changes -- the same idiom the feature and
 * config lists already used for their own controls.
 *
 * Pulled-in gears are not edited here. Their facts live in another `use_gear`
 * entry or in the closure, and the caller decides that by only rendering this
 * for a gear the intent names.
 */

import React from "@theia/core/shared/react";

import { configKeyProblem, unknownConfigKeyNote } from "../../common/config-keys";
import type { ConfigValue } from "../../common/generated/ConfigValue";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
import type { GearSelection } from "../../common/generated/GearSelection";
import { ConfigFields } from "../add-gear/config-fields";
import { type ConfigSources, provenanceOf } from "../inspector/effective-config";
import type { ProductEditService } from "../product-edit-service";

export interface GearSettingsProps {
  readonly descriptor: GearDescriptor;
  /** The `use_gear` entry this gear was asked for by. */
  readonly picked: GearSelection;
  readonly edits: ProductEditService;
  /** Where an effective value came from, for the provenance marks. */
  readonly sources: ConfigSources;
  /**
   * The deployment kind being shown, when a resolution has said.
   *
   * Only the curated feature list needs it: `kinds` on a `CargoFeature` says
   * which deployments a feature belongs to, and an integrator on an embedded
   * profile should be told `k8s-auth` exists and is not for here rather than be
   * shown a list it is silently missing from.
   */
  readonly profileKind?: string;
}

/**
 * Which features to offer, and which of those belong to another deployment.
 *
 * `cargo_features` is the curated half, and when a gear has one it *replaces*
 * the projected table rather than filtering it: curation is a judgement about
 * what an integrator should see, and showing the rest beside it would undo the
 * judgement. A gear nobody has curated falls back to the projected list, which
 * is why both fields exist.
 *
 * `null`/absent is "nobody curated this"; an empty list is a curation that
 * offers nothing. Only the first falls back, and the two say different things --
 * "this crate declares no Cargo features" against "this gear offers none of
 * them" -- which is the distinction this returns `curated` for.
 */
export function featureChoices(gear: GearDescriptor, profileKind?: string): {
  offered: string[];
  elsewhere: { name: string; kinds: string[] }[];
  curated: boolean;
} {
  const curated = gear.cargo_features;
  if (curated === undefined || curated === null) {
    return { offered: [...(gear.available_features ?? [])], elsewhere: [], curated: false };
  }
  const offered: string[] = [];
  const elsewhere: { name: string; kinds: string[] }[] = [];
  for (const feature of curated) {
    const kinds = feature.kinds ?? [];
    // An empty `kinds` is "every kind", and an unresolved profile is not a
    // reason to hide anything: offering it and letting the engine answer beats
    // a form that silently shrinks while a resolution is in flight.
    if (kinds.length === 0 || profileKind === undefined || kinds.includes(profileKind)) {
      offered.push(feature.name);
    } else {
      elsewhere.push({ name: feature.name, kinds: [...kinds] });
    }
  }
  return { offered, elsewhere, curated: true };
}

export function GearSettings({
  descriptor,
  picked,
  edits,
  sources,
  profileKind,
}: GearSettingsProps): React.ReactElement {
  const [newConfigKey, setNewConfigKey] = React.useState("");
  const [newConfigValue, setNewConfigValue] = React.useState("");
  const [newFeature, setNewFeature] = React.useState("");

  const gearId = descriptor.id;
  const savedConfig = picked.config ?? {};
  const config = edits.draftConfig(gearId, savedConfig);
  // Fields the schema covers get typed controls; the text rows keep everything
  // else, so a key outside a curated `exposes` is still editable.
  const fields = descriptor.config_schema?.fields ?? [];
  const typedKeys = new Set(fields.map((f) => f.name));
  const untyped = Object.fromEntries(
    Object.entries(config).filter(([key]) => !typedKeys.has(key)),
  );
  const features = edits.draftFeatures(gearId, picked.features ?? []);
  const { offered: available, elsewhere, curated } = featureChoices(descriptor, profileKind);
  const chosenFeatures = new Set(features);
  const extraFeatures = features.filter((feature) => !available.includes(feature));
  const keyProblem = configKeyProblem(newConfigKey);
  const keyNote =
    newConfigKey === ""
      ? undefined
      : unknownConfigKeyNote(newConfigKey.trim(), descriptor.config_schema);

  const queueConfig = (key: string, value: ConfigValue | undefined): boolean =>
    edits.queueDraft({ kind: "set_config", gear: gearId, key, value: value ?? null });

  const queueFeatures = (next: readonly string[]): void => {
    edits.queueDraft({ kind: "set_features", gear: gearId, features: [...next] });
  };

  const queueNewConfig = (): void => {
    const key = newConfigKey.trim();
    // The same rule the button is disabled by, restated at the act: a keyboard
    // Enter, a test, or a future caller does not go through the button.
    if (key === "" || configKeyProblem(key) !== undefined) return;
    if (!queueConfig(key, newConfigValue === "" ? undefined : newConfigValue)) return;
    setNewConfigKey("");
    setNewConfigValue("");
  };

  const queueNewFeature = (): void => {
    const feature = newFeature.trim();
    if (feature === "" || features.includes(feature)) return;
    setNewFeature("");
    queueFeatures([...features, feature]);
  };

  return (
    <div className="gbx-product-edit" data-gear-config={gearId}>
      <div className="gbx-detail-title">in this product</div>
      {fields.length > 0 && (
        <ConfigFields
          fields={fields}
          values={edits.draftConfigValues(gearId, savedConfig)}
          onChange={(key, value) => queueConfig(key, value)}
          provenanceOf={(key) => provenanceOf(sources, gearId, key, savedConfig)}
          isDrafted={(key) => edits.isDraftedConfig(gearId, key)}
          // A reset is a `set_config` with no value, which is how the wire
          // spells "remove this key" -- so it queues into the same draft and
          // waits for the same Apply as typing does.
          onReset={(key) => queueConfig(key, undefined)}
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
        <span className="gbx-config-list">
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
                data-field-modified={edits.isDraftedConfig(gearId, key) ? "true" : undefined}
                onChange={(e) => queueConfig(key, e.target.value)}
              />
              <button
                type="button"
                className="gbx-choice"
                data-config-remove={key}
                onClick={() => queueConfig(key, undefined)}
              >
                Remove
              </button>
            </label>
          ))}
          <button
            type="button"
            className="gbx-choice"
            data-add-config={gearId}
            disabled={newConfigKey === "" || keyProblem !== undefined}
            onClick={queueNewConfig}
          >
            Add key
          </button>
          {keyProblem !== undefined && newConfigKey !== "" && (
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
              aria-invalid={keyProblem !== undefined && newConfigKey !== "" ? true : undefined}
              value={newConfigKey}
              onChange={(e) => setNewConfigKey(e.target.value)}
            />
            <span className="gbx-sr-only">new config value</span>
            <input
              data-config-new-value
              placeholder="value"
              aria-label="new config value"
              value={newConfigValue}
              onChange={(e) => setNewConfigValue(e.target.value)}
            />
          </label>
        </span>
      </details>
      <div className="gbx-kv">
        <span>features</span>
        {/* The crate's own `[features]` table, as checkboxes. One renderer's
            worth of duplication with the Add Gear dialog is deliberate for now:
            the two carry different state (a draft here, a staged proposal
            there), and a control that disagreed with itself between them would
            be worse than two that agree by construction. */}
        <span className="gbx-features-list">
          {/* **Three answers, not one.** "No features yet" could not be told
              from "this gear has none", and the box beside it took any string,
              so a typo became a Cargo feature that does not exist and a build
              failure two steps later. The projected table answered that, and
              `cargo_features` is the curation on top of it. */}
          {available.length === 0 && elsewhere.length === 0 && (
            <span className="gbx-empty" data-features-none>
              {curated
                ? "This gear offers no Cargo features."
                : "This crate declares no Cargo features."}
            </span>
          )}
          {available.length > 0 && (
            <span className="gbx-feature-choices">
              {available.map((feature) => (
                <label
                  className="gbx-feature-choice"
                  key={feature}
                  data-feature-option={feature}
                  data-field-modified={edits.isDraftedFeatures(gearId) ? "true" : undefined}
                >
                  <input
                    type="checkbox"
                    checked={chosenFeatures.has(feature)}
                    aria-label={feature}
                    onChange={(e) =>
                      queueFeatures(
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
          {/* Named, not hidden. Someone looking for `k8s-auth` on a local
              profile needs to be told it exists and why it is not here; a list
              that silently omits it reads as a missing feature. */}
          {elsewhere.length > 0 && (
            <span className="gbx-add-gear-note" data-features-elsewhere>
              Not for this deployment:{" "}
              {elsewhere.map((feature, index) => (
                <span key={feature.name} data-feature-elsewhere={feature.name}>
                  {index > 0 && ", "}
                  <code>{feature.name}</code> ({feature.kinds.join(", ")})
                </span>
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
                onClick={() => queueFeatures(features.filter((f) => f !== feature))}
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
                value={newFeature}
                onChange={(e) => setNewFeature(e.target.value)}
              />
              <button
                type="button"
                className="gbx-choice"
                data-add-feature={gearId}
                disabled={newFeature.trim() === ""}
                onClick={queueNewFeature}
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
