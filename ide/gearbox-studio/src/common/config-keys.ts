// What a configuration key may be, checked before it is queued.
//
// A key written into `config = {...}` is a **quoted dict key** in the
// description (`edit_call::set_dict_key_on_call`), so the span surgeon accepts
// any string at all -- `bad key = "secret-looking"` writes cleanly and reads
// back cleanly. What it cannot do is deserialize: the key is matched against a
// serde field name, and no field in the corpus has a space in it.
//
// **The engine already refuses it, and that is not enough.** `GBX0115` names an
// undeclared key at resolve time, which is one round trip and one panel away
// from the row the person typed into -- and it fires for a key that is merely
// unknown as loudly as for one that could never be a field. So the shape is
// checked here, where the caret is, and the schema is *reported* here rather
// than enforced: a curated `exposes` list is deliberately narrower than the
// struct (ADR `cpt-gearbox-adr-macro-projected-catalogue`), so a key outside it
// may still be one the gear reads.

import type { ConfigSchema } from "./generated/ConfigSchema";

/**
 * Why this key cannot be written, or `undefined` if it can.
 *
 * A refusal, not a warning: these are keys that no gear could ever read.
 */
export function configKeyProblem(key: string): string | undefined {
  if (key.trim() === "") {
    return "a configuration key cannot be empty";
  }
  if (key !== key.trim()) {
    return "a configuration key cannot start or end with a space";
  }
  if (/\s/.test(key)) {
    return "a configuration key cannot contain spaces: it has to match a field name in the gear's configuration struct";
  }
  if (/["\\\n\r]/.test(key)) {
    return "a configuration key cannot contain quotes, backslashes or line breaks";
  }
  return undefined;
}

/**
 * What is worth saying about a key the schema does not declare.
 *
 * `undefined` when there is nothing to say -- no schema to check against, or a
 * key the schema declares. Deliberately phrased as what the resolver will do,
 * naming its code, so the sentence here and the diagnostic there are recognisably
 * the same complaint.
 */
export function unknownConfigKeyNote(
  key: string,
  schema: ConfigSchema | null | undefined,
): string | undefined {
  if (schema === null || schema === undefined) return undefined;
  if (configKeyProblem(key) !== undefined) return undefined;
  const fields = schema.fields ?? [];
  if (fields.length === 0) return undefined;
  if (fields.some((field) => field.name === key)) return undefined;
  return `\`${key}\` is not one of the fields \`${schema.rust}\` exposes, so resolving will report GBX0115.`;
}
