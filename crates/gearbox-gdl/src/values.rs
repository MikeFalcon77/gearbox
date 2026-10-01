//! GDL host values: the frozen namespaces and the opaque records the
//! vocabulary's functions exchange.
//!
//! Two shapes carry the whole design.
//!
//! [`GdlEnum`] is a closed-set member -- `cap.rest_host`, `transport.rest`,
//! `contract_kind.api`. It is an opaque value rather than a string on purpose:
//! a string would let `runtime_caps = ["rest_hsot"]` through to be discovered
//! at resolve time (or never), whereas a `GdlEnum` carries its namespace, so
//! passing `transport.rest` where a capability belongs is caught the moment
//! the host function unpacks it.
//!
//! [`GdlNamespace`] is the frozen table those members come from. A typo like
//! `cap.nope` misses `get_attr`, and the interpreter raises an attribute error
//! with a source span -- exactly the diagnostic we want, produced for free.

// `starlark::any::ProvidesStaticType` is a `pub unsafe trait`, so its derive
// implements an unsafe trait. This is the workspace's single unsafe waiver; see
// the note on `unsafe_code` in the root Cargo.toml. No `unsafe` block is
// written by hand anywhere in this crate -- the allow exists solely to admit
// derives from starlark.
#![allow(
    unsafe_code,
    reason = "starlark's ProvidesStaticType is an unsafe trait and its derive is \
              required on every host value"
)]

use std::fmt;

use allocative::Allocative;
use starlark::any::ProvidesStaticType;
use starlark::starlark_simple_value;
use starlark::values::{
    Heap, NoSerialize, StarlarkPagablePanic, StarlarkValue, Value, starlark_value,
};

/// One member of a closed set, tagged with the namespace it came from.
// `StarlarkPagablePanic` rather than `StarlarkPagable`: these values exist only
// for the duration of one evaluation and have no meaningful persisted form, so
// the panicking stubs state that honestly instead of paying for a capability
// nothing uses. (It also keeps the fields `&'static str`, which they genuinely
// are -- `StarlarkPagable` would require owned `String`s.)
#[derive(
    Debug, Clone, PartialEq, Eq, ProvidesStaticType, NoSerialize, StarlarkPagablePanic, Allocative,
)]
pub struct GdlEnum {
    /// The namespace name, e.g. `cap`. Used to reject a member of the wrong set.
    pub namespace: &'static str,
    /// The member name as written, e.g. `rest_host`.
    pub variant: &'static str,
}

starlark_simple_value!(GdlEnum);

impl fmt::Display for GdlEnum {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.namespace, self.variant)
    }
}

// The lifetime cannot be elided: `#[starlark_value]` requires a named lifetime
// parameter on the impl and fails to expand against `'_`.
#[expect(
    clippy::elidable_lifetime_names,
    reason = "#[starlark_value] requires a named lifetime parameter"
)]
#[starlark_value(type = "gdl_enum")]
impl<'v> StarlarkValue<'v> for GdlEnum {}

impl GdlEnum {
    /// The member name, if this value belongs to `namespace`.
    ///
    /// Returning `None` for the wrong namespace is what makes
    /// `runtime_caps = [transport.rest]` an error rather than a silent
    /// mis-selection.
    #[must_use]
    pub fn variant_in(&self, namespace: &str) -> Option<&'static str> {
        (self.namespace == namespace).then_some(self.variant)
    }
}

/// A frozen table of [`GdlEnum`] members, exposed as attributes.
// Copy: both fields are `&'static`, so registering a namespace into the globals
// is a pointer copy rather than a clone.
#[derive(Debug, Clone, Copy, ProvidesStaticType, NoSerialize, StarlarkPagablePanic, Allocative)]
pub struct GdlNamespace {
    name: &'static str,
    variants: &'static [&'static str],
}

starlark_simple_value!(GdlNamespace);

impl fmt::Display for GdlNamespace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.name)
    }
}

impl GdlNamespace {
    #[must_use]
    pub const fn new(name: &'static str, variants: &'static [&'static str]) -> Self {
        Self { name, variants }
    }
}

#[starlark_value(type = "gdl_namespace")]
impl<'v> StarlarkValue<'v> for GdlNamespace {
    fn get_attr(&self, attribute: &str, heap: Heap<'v>) -> Option<Value<'v>> {
        // Returning None is the whole error mechanism: the interpreter turns it
        // into an attribute error carrying the access's span.
        let variant = self.variants.iter().find(|v| **v == attribute)?;
        Some(heap.alloc(GdlEnum {
            namespace: self.name,
            variant,
        }))
    }

    fn has_attr(&self, attribute: &str, _heap: Heap<'v>) -> bool {
        self.variants.contains(&attribute)
    }

    fn dir_attr(&self) -> Vec<String> {
        // Sorted so `dir(cap)` is stable; the declaration order of a closed set
        // is not meaningful to a reader.
        let mut names: Vec<String> = self.variants.iter().map(|v| (*v).to_owned()).collect();
        names.sort();
        names
    }
}
