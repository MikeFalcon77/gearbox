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

export interface ConfigFieldsProps {
  readonly fields: readonly ConfigFieldDecl[];
  /** Current value per key, for the keys that have one. */
  readonly values: ReadonlyMap<string, ConfigValue>;
  readonly onChange: (key: string, value: ConfigValue | undefined) => void;
}

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
  const { field, values, onChange } = props;
  const value = values.get(field.name);
  const blocked = refusal(field);

  return (
    <label
      className="gbx-config-field"
      data-config-field={field.name}
      data-config-field-kind={field.type.kind}
    >
      <span className="gbx-config-field-name">
        {field.name}
        {field.required && <span className="gbx-config-required" title="required" />}
      </span>

      {blocked === undefined ? (
        <Control field={field} value={value} onChange={onChange} />
      ) : (
        <span className="gbx-config-blocked">{blocked}</span>
      )}

      {field.doc !== null && field.doc !== undefined && (
        <span className="gbx-config-field-doc">{field.doc}</span>
      )}
    </label>
  );
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
