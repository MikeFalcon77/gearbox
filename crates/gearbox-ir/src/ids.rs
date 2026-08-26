//! Stable identifiers.
//!
//! Every identifier in the model is a newtype whose constructor is the single
//! validation point. Construction is fallible; once constructed, an id is known
//! well-formed and may be compared, ordered, and serialized freely.
//!
//! Ordering matters: the resolver iterates and sorts by these types to guarantee
//! byte-identical output (`cpt-gearbox-nfr-determinism`), so `Ord` must be the
//! plain lexicographic order of the underlying string.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Why an identifier was rejected.
///
/// Carries the offending text so a diagnostic can quote it back.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IdError {
    #[error("{kind} must not be empty")]
    Empty { kind: &'static str },

    #[error("{kind} `{value}` is too long ({len} > {max})")]
    TooLong {
        kind: &'static str,
        value: String,
        len: usize,
        max: usize,
    },

    #[error(
        "{kind} `{value}` is not kebab-case (lowercase letters, digits and single hyphens; must start with a letter and must not end with one)"
    )]
    NotKebab { kind: &'static str, value: String },

    #[error("{kind} `{value}` is malformed: expected {expected}")]
    Malformed {
        kind: &'static str,
        value: String,
        expected: &'static str,
    },
}

/// The exact rule enforced by `toolkit_macros::validate_kebab_case` in
/// `gears-rust`: lowercase ASCII letters, digits, and single interior hyphens;
/// must start with a letter; must not end with a hyphen; no `_`; no `--`.
///
/// Gearbox must not accept a gear name the `#[toolkit::gear]` macro would
/// reject, or `gearbox validate` would pass a product that cannot compile.
fn validate_kebab(kind: &'static str, value: &str) -> Result<(), IdError> {
    if value.is_empty() {
        return Err(IdError::Empty { kind });
    }

    let err = || IdError::NotKebab {
        kind,
        value: value.to_owned(),
    };

    let bytes = value.as_bytes();

    if !bytes[0].is_ascii_lowercase() {
        return Err(err());
    }
    if bytes[bytes.len() - 1] == b'-' {
        return Err(err());
    }

    let mut prev_hyphen = false;
    for &b in bytes {
        match b {
            b'a'..=b'z' | b'0'..=b'9' => prev_hyphen = false,
            b'-' if !prev_hyphen => prev_hyphen = true,
            _ => return Err(err()),
        }
    }

    Ok(())
}

/// Declares a newtype over `String` that validates on construction.
///
/// Generates `new`, `as_str`, `into_inner`, `Display`, `FromStr`, `TryFrom<&str>`,
/// `TryFrom<String>`, and a `Deserialize` impl that runs the same validation, so
/// an id read from a `product.lock` is checked exactly as one built in memory.
macro_rules! id_newtype {
    (
        $(#[$meta:meta])*
        $name:ident, kind = $kind:literal, validate = $validate:expr
    ) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
        #[ts(type = "string")]
        pub struct $name(String);

        impl $name {
            /// The human-readable kind, used in error messages.
            pub const KIND: &'static str = $kind;

            /// Validate and construct.
            ///
            /// # Errors
            /// Returns [`IdError`] when `value` does not match this id's format.
            pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
                let value = value.into();
                let validate: fn(&'static str, &str) -> Result<(), IdError> = $validate;
                validate(Self::KIND, &value)?;
                Ok(Self(value))
            }

            #[must_use]
            pub fn as_str(&self) -> &str {
                &self.0
            }

            #[must_use]
            pub fn into_inner(self) -> String {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({:?})", stringify!($name), self.0)
            }
        }

        impl FromStr for $name {
            type Err = IdError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Self::new(s)
            }
        }

        impl TryFrom<&str> for $name {
            type Error = IdError;
            fn try_from(s: &str) -> Result<Self, Self::Error> {
                Self::new(s)
            }
        }

        impl TryFrom<String> for $name {
            type Error = IdError;
            fn try_from(s: String) -> Result<Self, Self::Error> {
                Self::new(s)
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let raw = String::deserialize(d)?;
                Self::new(raw).map_err(serde::de::Error::custom)
            }
        }

        impl schemars::JsonSchema for $name {
            fn schema_name() -> std::borrow::Cow<'static, str> {
                std::borrow::Cow::Borrowed(stringify!($name))
            }

            fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
                schemars::json_schema!({
                    "type": "string",
                    "description": $kind,
                })
            }
        }
    };
}

id_newtype! {
    /// A gear's stable machine identity, distinct from its display name.
    ///
    /// Kebab-case, matching `#[toolkit::gear(name = "...")]` exactly. Used by
    /// co-location dependencies, contract ownership, process anchors, lock
    /// entries, and cross-repository references, so display text can change
    /// without breaking anything.
    GearId, kind = "gear id", validate = validate_kebab
}

id_newtype! {
    /// A deployment profile declared in `product.gdl`.
    ///
    /// A Gearbox concept, not a runtime type: the runtime has no
    /// `DeploymentProfile`, only per-gear `RuntimeKind`.
    ProfileId, kind = "profile id", validate = validate_kebab
}

id_newtype! {
    /// A gear source declared in `product.gdl`.
    SourceId, kind = "source id", validate = validate_kebab
}

id_newtype! {
    /// A resolved process.
    ///
    /// Derived from the anchor gear's id, suffixed `-2`, `-3`, ... on collision.
    ProcessId, kind = "process id", validate = validate_kebab
}

id_newtype! {
    /// A contract family member: `{gear}/{BaseTraitName}@v{major}`.
    ///
    /// The Rust trait's trailing major is stripped from the base name
    /// (`PaymentApiV2` -> `PaymentApi`), so `v1` and `v2` are two versions of
    /// one family rather than two unrelated contracts.
    ContractId, kind = "contract id", validate = validate_contract_id
}

id_newtype! {
    /// A cluster provider binding: `{primitive}:{provider}`, e.g. `cache:postgres`.
    ProviderId, kind = "provider id", validate = validate_two_part_colon
}

id_newtype! {
    /// A requirement instance: `{gear}#{namespace}[{ordinal}]`.
    ///
    /// The ordinal disambiguates repeated requirements of the same kind by one
    /// gear, in declaration order.
    RequirementId, kind = "requirement id", validate = validate_requirement_id
}

id_newtype! {
    /// A capability a satisfier either has or lacks: `{namespace}.{name}`,
    /// e.g. `cluster.cache.linearizable` or `runtime.rest`.
    CapabilityId, kind = "capability id", validate = validate_dotted
}

id_newtype! {
    /// A node in the explanation graph: `{kind}:{payload}`.
    ///
    /// Content-derived, never a counter -- otherwise the graph would not be
    /// byte-stable across runs (`cpt-gearbox-nfr-determinism`).
    NodeId, kind = "node id", validate = validate_two_part_colon
}

/// `{gear}/{BaseName}@v{major}`.
fn validate_contract_id(kind: &'static str, value: &str) -> Result<(), IdError> {
    const EXPECTED: &str = "{gear}/{BaseTraitName}@v{major}, e.g. api-contracts/PaymentApi@v1";
    let malformed = || IdError::Malformed {
        kind,
        value: value.to_owned(),
        expected: EXPECTED,
    };

    let (gear, rest) = value.split_once('/').ok_or_else(malformed)?;
    validate_kebab(kind, gear).map_err(|_| malformed())?;

    let (base, major) = rest.split_once("@v").ok_or_else(malformed)?;

    // Base is a Rust trait name: PascalCase, ASCII alphanumeric, starts upper.
    if base.is_empty()
        || !base.starts_with(|c: char| c.is_ascii_uppercase())
        || !base.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(malformed());
    }

    // Major is a bare decimal with no leading zero.
    if major.is_empty()
        || !major.bytes().all(|b| b.is_ascii_digit())
        || (major.len() > 1 && major.starts_with('0'))
    {
        return Err(malformed());
    }

    Ok(())
}

/// `{gear}#{namespace}[{ordinal}]`.
fn validate_requirement_id(kind: &'static str, value: &str) -> Result<(), IdError> {
    const EXPECTED: &str = "{gear}#{namespace}[{ordinal}], e.g. payments-audit#cluster.cache[0]";
    let malformed = || IdError::Malformed {
        kind,
        value: value.to_owned(),
        expected: EXPECTED,
    };

    let (gear, rest) = value.split_once('#').ok_or_else(malformed)?;
    validate_kebab(kind, gear).map_err(|_| malformed())?;

    let rest = rest.strip_suffix(']').ok_or_else(malformed)?;
    let (namespace, ordinal) = rest.split_once('[').ok_or_else(malformed)?;

    validate_dotted(kind, namespace).map_err(|_| malformed())?;

    if ordinal.is_empty()
        || !ordinal.bytes().all(|b| b.is_ascii_digit())
        || (ordinal.len() > 1 && ordinal.starts_with('0'))
    {
        return Err(malformed());
    }

    Ok(())
}

/// `{a}.{b}[.{c}...]` where each segment is kebab-case.
fn validate_dotted(kind: &'static str, value: &str) -> Result<(), IdError> {
    const EXPECTED: &str = "dot-separated kebab segments, e.g. cluster.cache.linearizable";
    if value.split('.').count() < 2 {
        return Err(IdError::Malformed {
            kind,
            value: value.to_owned(),
            expected: EXPECTED,
        });
    }
    for segment in value.split('.') {
        validate_kebab(kind, segment).map_err(|_| IdError::Malformed {
            kind,
            value: value.to_owned(),
            expected: EXPECTED,
        })?;
    }
    Ok(())
}

/// `{a}:{b}` where `a` is kebab-case and `b` is a non-empty opaque payload.
///
/// The payload is deliberately unconstrained: explanation node ids embed
/// contract ids and arrows (`binding:payments-audit->api-contracts/PaymentApi@v1`),
/// which are not themselves kebab-case.
fn validate_two_part_colon(kind: &'static str, value: &str) -> Result<(), IdError> {
    const EXPECTED: &str = "{kind}:{payload}, e.g. cache:postgres";
    let malformed = || IdError::Malformed {
        kind,
        value: value.to_owned(),
        expected: EXPECTED,
    };

    let (head, payload) = value.split_once(':').ok_or_else(malformed)?;
    validate_kebab(kind, head).map_err(|_| malformed())?;
    if payload.is_empty() {
        return Err(malformed());
    }
    Ok(())
}

/// A repository-relative, forward-slash, UTF-8 path.
///
/// A newtype rather than `PathBuf` for three reasons: the lock must serialize
/// identically on every platform, paths in the lock are always relative to a
/// declared source root, and escaping that root must be rejectable at
/// construction rather than at generation time.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord, Hash, TS)]
#[ts(type = "string")]
pub struct RelPath(String);

impl RelPath {
    pub const KIND: &'static str = "relative path";

    /// Validate and construct. Rejects absolute paths, `..` segments and
    /// backslashes; normalizes away redundant separators and `.` segments.
    ///
    /// # Errors
    /// Returns [`IdError`] when `value` is empty, absolute, contains a backslash,
    /// or contains a `..` segment (which would escape its source root).
    pub fn new(value: impl Into<String>) -> Result<Self, IdError> {
        let raw = value.into();
        let malformed = |expected: &'static str| IdError::Malformed {
            kind: Self::KIND,
            value: raw.clone(),
            expected,
        };

        if raw.is_empty() {
            return Err(IdError::Empty { kind: Self::KIND });
        }
        if raw.contains('\\') {
            return Err(malformed("forward slashes only"));
        }
        if raw.starts_with('/') {
            return Err(malformed("a relative path"));
        }

        let mut segments = Vec::new();
        for segment in raw.split('/') {
            match segment {
                // Redundant separators and `.` carry no meaning; drop them so
                // two spellings of one path hash identically.
                "" | "." => {}
                ".." => {
                    return Err(malformed(
                        "no `..` segments (must stay inside its source root)",
                    ));
                }
                other => segments.push(other),
            }
        }

        // A path made only of `.` and separators is the current directory, which
        // `gear.gdl` spells `path = "."` for the common case of a gear whose
        // crate root is the directory holding the description.
        if segments.is_empty() {
            return Ok(Self::here());
        }

        Ok(Self(segments.join("/")))
    }

    /// The current directory, spelled `.`.
    ///
    /// `gear.gdl` uses `path = "."` for a gear whose crate root is the directory
    /// holding the description, which is the common case.
    #[must_use]
    pub fn here() -> Self {
        Self(".".to_owned())
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_here(&self) -> bool {
        self.0 == "."
    }

    /// Join a relative path onto this one, re-validating the result.
    ///
    /// # Errors
    /// Returns [`IdError`] when the joined path fails validation.
    pub fn join(&self, other: &Self) -> Result<Self, IdError> {
        if other.is_here() {
            return Ok(self.clone());
        }
        if self.is_here() {
            return Ok(other.clone());
        }
        Self::new(format!("{}/{}", self.0, other.0))
    }

    /// Resolve a possibly-upward path against this one, keeping the result
    /// relative and rejecting an escape above the root.
    ///
    /// `gear.gdl` legitimately points at a sibling crate (`../payments-audit-sdk`),
    /// so upward traversal must be supported at the point of resolution even
    /// though it is forbidden in a stored `RelPath`.
    ///
    /// # Errors
    /// Returns [`IdError`] when `relative` is absolute, contains a backslash, or
    /// walks above the source root.
    pub fn resolve(&self, relative: &str) -> Result<Self, IdError> {
        let malformed = |expected: &'static str| IdError::Malformed {
            kind: Self::KIND,
            value: relative.to_owned(),
            expected,
        };
        if relative.contains('\\') {
            return Err(malformed("forward slashes only"));
        }
        if relative.starts_with('/') {
            return Err(malformed("a relative path"));
        }

        let mut segments: Vec<&str> = if self.is_here() {
            Vec::new()
        } else {
            self.0.split('/').collect()
        };

        for segment in relative.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    if segments.pop().is_none() {
                        return Err(malformed("a path that stays inside its source root"));
                    }
                }
                other => segments.push(other),
            }
        }

        if segments.is_empty() {
            return Ok(Self::here());
        }
        Ok(Self(segments.join("/")))
    }

    /// Drop the final segment.
    #[must_use]
    pub fn parent(&self) -> Self {
        match self.0.rsplit_once('/') {
            Some((head, _)) => Self(head.to_owned()),
            None => Self::here(),
        }
    }
}

impl fmt::Display for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for RelPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RelPath({:?})", self.0)
    }
}

impl FromStr for RelPath {
    type Err = IdError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::new(s)
    }
}

impl Serialize for RelPath {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for RelPath {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::new(raw).map_err(serde::de::Error::custom)
    }
}

impl schemars::JsonSchema for RelPath {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        std::borrow::Cow::Borrowed("RelPath")
    }

    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({
            "type": "string",
            "description": "repository-relative, forward-slash, UTF-8 path",
        })
    }
}
