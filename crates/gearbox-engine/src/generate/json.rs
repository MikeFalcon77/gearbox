//! Handing a `serde_json` tree to a YAML serializer without losing its numbers.
//!
//! `serde_json::Number` does not serialize as a number. It serializes through a
//! private newtype token that only `serde_json`'s own serializer recognises and
//! unwraps; every other backend writes the token out verbatim. That is how
//! `pool_max_size = 10` reached a generated configuration as
//! `{"$serde_json::private::Number": "10"}` and made the cluster gear fail to
//! start, and it is how `runAsUser` would have reached `values.yaml` as
//! `{"$serde_json::private::Number": "65532"}` if [`super::helm`] had not typed
//! that struct instead.
//!
//! **Two boundaries, one rule.** The fix that reached only the first of them was
//! `#[serde(serialize_with = ...)]` on the one field known to carry a number,
//! which leaves every other `serde_json::Value` field in the generator on the
//! broken path and gives the next such field no way to notice. So the wrapper
//! lives here, applies at both boundaries, and the helpers cover the three
//! shapes the generator actually holds -- a bare value, an optional one, and a
//! map of them. Every other value shape passes through unchanged; only numbers
//! were ever wrong, and they were wrong everywhere a `Value` is written as YAML.

use std::collections::BTreeMap;

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

/// A `serde_json` value that serializes as itself into any backend.
pub(super) struct Json<'a>(pub(super) &'a Value);

impl Serialize for Json<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(b) => serializer.serialize_bool(*b),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    serializer.serialize_i64(i)
                } else if let Some(u) = n.as_u64() {
                    serializer.serialize_u64(u)
                } else if let Some(f) = n.as_f64() {
                    serializer.serialize_f64(f)
                } else {
                    // Unreachable on `serde_json`'s default features, where a
                    // `Number` is exactly one of the three above. It becomes
                    // reachable if anything in the dependency graph turns on
                    // `arbitrary_precision`, which is a *unified* cargo feature
                    // -- no edit here, no review, and suddenly a 40-digit
                    // integer is representable.
                    //
                    // Failing is the point. Writing the digits as a string would
                    // produce a quoted scalar the gear's `u32` field refuses at
                    // startup: the same silent, run-it-to-find-it failure this
                    // module exists to remove, reintroduced by the one branch
                    // nobody tests.
                    Err(serde::ser::Error::custom(format!(
                        "the number `{n}` fits neither i64, u64 nor f64, so it cannot be written \
                         as YAML; `serde_json/arbitrary_precision` is enabled somewhere in this \
                         build's dependency graph"
                    )))
                }
            }
            Value::String(v) => serializer.serialize_str(v),
            Value::Array(items) => serializer.collect_seq(items.iter().map(Json)),
            // `Map` is a `BTreeMap` on default features, so this is key-sorted
            // and byte-stable -- the ordering the generated tree is compared for
            // equality on. `collect_map` emits in iterator order and adds
            // nothing of its own.
            Value::Object(map) => serializer.collect_map(map.iter().map(|(k, v)| (k, Json(v)))),
        }
    }
}

/// `#[serde(serialize_with)]` for a `serde_json::Map` field.
pub(super) fn map<S: Serializer>(
    map: &Map<String, Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(map.iter().map(|(k, v)| (k, Json(v))))
}

/// `#[serde(serialize_with)]` for an `Option<serde_json::Value>` field.
///
/// Pair it with `skip_serializing_if = "Option::is_none"` as the field already
/// does; this still handles `None` so the two attributes stay independent.
#[expect(
    clippy::ref_option,
    reason = "serde's `serialize_with` is handed `&FieldType`, so the signature is not ours to \
              choose; taking `Option<&Value>` would not typecheck as a field attribute"
)]
pub(super) fn option<S: Serializer>(
    value: &Option<Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => serializer.serialize_some(&Json(value)),
        None => serializer.serialize_none(),
    }
}

/// `#[serde(serialize_with)]` for a `BTreeMap<String, serde_json::Value>` field.
pub(super) fn btree_map<S: Serializer>(
    map: &BTreeMap<String, Value>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_map(map.iter().map(|(k, v)| (k, Json(v))))
}
