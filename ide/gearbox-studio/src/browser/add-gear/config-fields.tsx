// Typed controls for a gear's projected configuration fields.
//
// One module because two panels render them -- Add Gear and the Inspector -- and
// a control that disagreed with itself between the two would be worse than no
// control. The rules live here; each panel supplies the values and a callback.
//
// **The type comes from Rust, so the control does too.** A bool gets a checkbox,
// an enum a select over the variants the projector read, a number a numeric
// input. Nothing here knows which enums exist: the variants arrive as data, so a
// gear author adding one needs no change to this file
// (`cpt-gearbox-adr-macro-projected-catalogue`).
//
// **A field is written only if it was touched.** `touched` is the set of keys
// the operator actually changed, and a panel sends `set_config` for those alone.
// Sending every row would rewrite values nobody edited, and the surgical
// editor's textual idempotence does not save the spellings a person may have
// chosen -- `0x1F`, `8_087`, `1e10` and single quotes all normalise on a
// rewrite, so an operator's hex would silently disappear.

import React from "@theia/core/shared/react";

import type { ConfigFieldDecl } from "../../common/generated/ConfigFieldDecl";
import type { ConfigValue } from "../../common/generated/ConfigValue";
import { isSecretConfigKey } from "../product-edit-service";

/**
 * Where a field's current value came from.
 *
 * Three states a person can act on differently, and all three are derivable
 * today without a new wire field:
 *
 *   - `explicit`  the description sets this key, so it can be reset;
 *   - `derived`   the *resolution* set it and the description did not -- a port,
 *                 a consumer's wiring, a cluster binding. Setting one of these
 *                 by hand describes a product that was not resolved, which is
 *                 what GBX0114 warns about;
 *   - `default`   nothing sets it, and the struct's own default is what runs.
 *                 That value is already the control's placeholder.
 *
 * Undefined provenance means "not asked": the Add Gear panel is staging a gear
 * the description does not name yet, so every field there is a value being
 * chosen rather than one with a history.
 */
export type ConfigProvenance = "explicit" | "derived" | "default";

export interface ConfigFieldsProps {
  readonly fields: readonly ConfigFieldDecl[];
  /** Current value per key, for the keys that have one. */
  readonly values: ReadonlyMap<string, ConfigValue>;
  readonly onChange: (key: string, value: ConfigValue | undefined) => void;
  /** Where each value came from, when the caller knows. */
  readonly provenanceOf?: (key: string) => ConfigProvenance;
  /**
   * Whether this key has an unapplied draft edit.
   *
   * The Inspector marks untyped rows, features and profile fields with
   * `data-field-modified`; typed schema fields need the same cue or Apply /
   * Discard in the toolbar looks like it applies to nothing on these controls.
   */
  readonly isDrafted?: (key: string) => boolean;
  /**
   * Drop the description's value for this key, falling back to what the gear
   * decides on its own.
   *
   * Offered only for `explicit` fields, because that is the only state with
   * something to remove. It queues an edit like any other -- nothing is written
   * until Apply -- so "reset" is as reversible as typing was.
   */
  readonly onReset?: (key: string) => void;
}

/** How each provenance reads in the panel. */
const PROVENANCE_LABEL: Record<ConfigProvenance, string> = {
  explicit: "set by this product",
  derived: "derived by the resolver",
  default: "the gear's default",
};

/** The placeholder a control shows when the operator has set nothing. */
function placeholder(field: ConfigFieldDecl): string {
  if (field.default !== null && field.default !== undefined) return String(field.default);
  return field.required ? "required" : "";
}

/**
 * Why a field cannot be typed into, or `undefined` when it can.
 *
 * A string under a credential-looking key is refused by the engine
 * (`cpt-gearbox-fr-no-secrets-in-values`), so the control says so up front
 * rather than letting someone fill a box that Apply will reject.
 */
function refusal(field: ConfigFieldDecl): string | undefined {
  if (field.type.kind === "complex") {
    return "not a scalar — edit this one in the description";
  }
  if (field.secret || (field.type.kind === "str" && isSecretConfigKey(field.name))) {
    return "a credential — reference an external secret from the description";
  }
  return undefined;
}

export function ConfigFields(props: ConfigFieldsProps): React.ReactElement {
  return (
    <div className="gbx-config-fields">
      {props.fields.map((field) => (
        <ConfigField key={field.name} field={field} {...props} />
      ))}
    </div>
  );
}

function ConfigField(
  props: ConfigFieldsProps & { readonly field: ConfigFieldDecl },
): React.ReactElement {
  const { field, values, onChange, provenanceOf, isDrafted, onReset } = props;
  const value = values.get(field.name);
  const blocked = refusal(field);
  const provenance = provenanceOf?.(field.name);
  const drafted = isDrafted?.(field.name) === true;
  const problem = blocked === undefined ? valueProblem(field, value) : undefined;
  const missing = blocked === undefined && problem === undefined && valueMissing(field, value);

  return (
    <label
      className="gbx-config-field"
      data-config-field={field.name}
      data-config-field-kind={field.type.kind}
      data-config-provenance={provenance}
      data-field-modified={drafted ? "true" : undefined}
      data-config-invalid={problem === undefined ? undefined : "true"}
      aria-invalid={problem === undefined ? undefined : true}
    >
      <span className="gbx-config-field-name">
        {field.name}
        {/* **Required *and* without a default**, which is what the stylesheet's
            rule for this class has always claimed and the condition did not: it
            was `field.required` alone, so a field the gear gives a default
            carried an asterisk saying a value must be supplied when one already
            is. The two halves are now the same test `valueMissing` applies, and
            the same one `GBX0120` applies engine-side.

            The word, not only the mark: an empty `<span>` with a `title` gives a
            screen reader nothing, and this panel's own rule two lines down is to
            say things "in words rather than by a colour". The visible glyph
            comes from CSS; the text is for anyone not reading pixels. */}
        {mustBeSupplied(field) && (
          <span className="gbx-config-required" data-config-field-required={field.name}>
            <span className="gbx-sr-only">required</span>
          </span>
        )}
        {/* Which of the three states this value is in, said in words rather than
            by a colour: a person deciding whether to touch a field needs to know
            whether they would be overriding the resolver, and "inherited" and
            "set here" look identical in a form otherwise. */}
        {provenance !== undefined && (
          <span
            className={`gbx-provenance gbx-provenance-${provenance}`}
            data-config-provenance-label={provenance}
          >
            {PROVENANCE_LABEL[provenance]}
          </span>
        )}
        {provenance === "explicit" && onReset !== undefined && (
          <button
            type="button"
            className="gbx-config-reset"
            data-config-reset={field.name}
            aria-label={`Reset ${field.name} to the gear's default`}
            title={`Reset ${field.name} to the gear's default`}
            onClick={(event) => {
              event.preventDefault();
              onReset(field.name);
            }}
          >
            reset
          </button>
        )}
      </span>

      {blocked === undefined ? (
        <Control field={field} value={value} onChange={onChange} />
      ) : (
        <span className="gbx-config-blocked">{blocked}</span>
      )}

      {/* At the field, and before the engine is asked. The engine stays the
          boundary -- it refuses the same things -- but its refusal arrived on the
          other side of the screen 400 ms later, with no indication of which
          field it was about. */}
      {problem !== undefined && (
        <span className="gbx-inline-error" role="alert" data-config-field-error={field.name}>
          {problem}
        </span>
      )}
      {/* A note, not an error: nothing is wrong yet, and the resolver may have a
          value this declaration does not carry. */}
      {missing && (
        <span className="gbx-inline-note" data-config-field-missing={field.name}>
          required, and the gear declares no default
        </span>
      )}

      {field.doc !== null && field.doc !== undefined && (
        <span className="gbx-config-field-doc">{field.doc}</span>
      )}
    </label>
  );
}

/**
 * What is wrong with a value *before* the engine is asked, or `undefined`.
 *
 * **Narrow on purpose, and the boundary is the point.** `ConfigFieldDecl` carries
 * `name`, `type`, `required`, `default`, `doc` and `secret` -- no pattern, no
 * bounds, no format -- so the only things checkable here are the ones the
 * declaration actually states. A `pattern` this repository does not have,
 * enforced against a gear that accepts the value, is worse than no check: that
 * is the mistake the `prefix_path` finding records, where the doc comment
 * promised a leading slash and `normalize_prefix_path` prepends one.
 *
 * **A value that is absent is not a problem here, and that distinction cost a
 * suite run.** `required` with nothing set is the state every configurator opens
 * in -- the panel has just been told which gear, and nothing has been typed --
 * and the resolver may supply the value from a profile or a default the
 * declaration does not carry. Reporting it as invalid blocked the dry run on
 * every proposal, which is a panel that refuses to preview anything.
 *
 * So what this answers is narrower and honest: is the value *present and wrong*.
 * A missing required value is worth *mentioning*, which [`valueMissing`] does,
 * and is not worth blocking on.
 */
export function valueProblem(
  field: ConfigFieldDecl,
  value: ConfigValue | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (field.type.kind === "enum" && typeof value === "string") {
    // The variants are the engine's own list, so this is reading the
    // declaration rather than inventing a rule.
    return field.type.variants.includes(value)
      ? undefined
      : `${value} is not one of ${field.type.variants.join(", ")}`;
  }
  if (field.type.kind === "int" && typeof value === "number" && !Number.isInteger(value)) {
    return `${field.name} is an integer`;
  }
  return undefined;
}

/**
 * Whether a required field has nothing to fall back on.
 *
 * Said, not enforced: the resolver can supply a value the declaration does not
 * carry, and a configurator that refused to preview until every required field
 * was typed would refuse on the first frame. What it buys is that "required" is
 * visible before a GBX code explains it from the other side of the screen.
 */
export function valueMissing(field: ConfigFieldDecl, value: ConfigValue | undefined): boolean {
  return value === undefined && mustBeSupplied(field);
}

/**
 * Whether this field needs a value from somebody.
 *
 * Required *and* without a compiled-in default. Both halves matter and the
 * marker used to test only the first, so a field the gear defaults still wore
 * an asterisk -- a mark saying "you must supply this" over a value that is
 * already supplied.
 *
 * The same test the engine applies in `config_check::report_unset_required`,
 * which is what `GBX0120` reports. One rule, stated in two places because one
 * of them is a form and the other is a resolution, and they must not disagree
 * about which fields it is about.
 */
export function mustBeSupplied(field: ConfigFieldDecl): boolean {
  return field.required && (field.default === undefined || field.default === null);
}

function Control(props: {
  readonly field: ConfigFieldDecl;
  readonly value: ConfigValue | undefined;
  readonly onChange: (key: string, value: ConfigValue | undefined) => void;
}): React.ReactElement {
  const { field, value, onChange } = props;
  const name = field.name;

  switch (field.type.kind) {
    case "bool":
      return (
        <input
          type="checkbox"
          aria-label={name}
          checked={value === true}
          onChange={(e) => onChange(name, e.target.checked)}
        />
      );

    case "enum":
      return (
        <select
          aria-label={name}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(name, e.target.value === "" ? undefined : e.target.value)}
        >
          {/* Distinguishes "left alone" from "set to the first variant". */}
          <option value="">{placeholder(field) || "unset"}</option>
          {field.type.variants.map((variant) => (
            <option key={variant} value={variant}>
              {variant}
            </option>
          ))}
        </select>
      );

    case "int":
    case "float":
      return (
        <input
          type="number"
          aria-label={name}
          // Integers step by one; a float may be anything.
          step={field.type.kind === "int" ? 1 : "any"}
          placeholder={placeholder(field)}
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => {
            const text = e.target.value;
            if (text === "") return onChange(name, undefined);
            const parsed = Number(text);
            // A half-typed "-" or "1e" is not a number yet; leaving the previous
            // value alone beats writing NaN into the description.
            if (!Number.isFinite(parsed)) return;
            onChange(name, parsed);
          }}
        />
      );

    default:
      return (
        <input
          type="text"
          aria-label={name}
          placeholder={placeholder(field)}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(name, e.target.value === "" ? undefined : e.target.value)}
        />
      );
  }
}
