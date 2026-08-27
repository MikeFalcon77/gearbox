//! Where a host function puts its result.
//!
//! `starlark`'s `Module::with_temp_heap` hands out a `Module` under a
//! higher-ranked lifetime, so no `Value<'v>` can escape the closure. Results
//! therefore leave through a [`GdlSink`] the caller owns *outside* the closure
//! and installs as `Evaluator::extra`; the host functions write owned Rust data
//! into it, and the caller reads it after evaluation returns. This is the
//! pattern starlark's own documentation uses.
//!
//! The sink is also where the "exactly one declaration per file" rule lives:
//! `gear()` and `product()` write once, and a second call is an error rather
//! than a silent overwrite.

// See the note on `unsafe_code` in the root Cargo.toml.
#![allow(
    unsafe_code,
    reason = "starlark's ProvidesStaticType is an unsafe trait and its derive is \
              required to install this type as Evaluator::extra"
)]

use std::cell::RefCell;

use gearbox_ir::{Diagnostic, Diagnostics, ProductIntent};
use starlark::any::ProvidesStaticType;

use crate::records::{ConsumeRecord, ProvideRecord, RoleRecord};

/// The raw, still-untyped result of one `gear(...)` call.
///
/// Host functions cannot build a [`GearDescriptor`] directly: converting needs
/// the source identity and the description's own path, which only the caller
/// knows. So `gear()` records what the file said, and
/// [`crate::engine`] converts.
#[derive(Debug, Clone, Default)]
pub struct GearDecl {
    pub name: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub visibility: Option<String>,
    pub package: Option<crate::records::CargoRecord>,
    pub provides: Vec<ProvideRecord>,
    pub consumes: Vec<ConsumeRecord>,
    pub requires: Vec<crate::records::ClusterRequireRecord>,
    pub serves: Vec<crate::records::EndpointRecord>,
    /// Where the cluster backend plugin crates live, so their `PROVIDER_NAME`
    /// consts and capability declarations can be projected.
    ///
    /// Declared rather than projected for the same reason `sdk` is: telling the
    /// scanner where to look is not restating the fact it will find.
    pub cluster_plugins: Vec<crate::records::ClusterPluginRecord>,
    pub declared_roles: Vec<RoleRecord>,
    pub config_schema: Option<String>,
}

/// Collects one file's declaration and any diagnostics raised while evaluating it.
#[derive(Debug, Default, ProvidesStaticType)]
pub struct GdlSink {
    gear: RefCell<Option<GearDecl>>,
    product: RefCell<Option<ProductIntent>>,
    diagnostics: RefCell<Diagnostics>,
    /// Set when a second `gear()`/`product()` call is seen, so the engine can
    /// report GBX0105 without the host function needing to fail the evaluation.
    duplicate: RefCell<bool>,
}

impl GdlSink {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the file's `gear(...)` declaration.
    ///
    /// A second call marks the file as duplicated rather than overwriting: the
    /// first declaration is the one a reader would expect to win, and the
    /// engine turns the flag into GBX0105.
    pub fn set_gear(&self, decl: GearDecl) {
        let mut slot = self.gear.borrow_mut();
        if slot.is_some() {
            *self.duplicate.borrow_mut() = true;
        } else {
            *slot = Some(decl);
        }
    }

    /// Record the file's `product(...)` declaration. Same write-once rule.
    pub fn set_product(&self, intent: ProductIntent) {
        let mut slot = self.product.borrow_mut();
        if slot.is_some() {
            *self.duplicate.borrow_mut() = true;
        } else {
            *slot = Some(intent);
        }
    }

    pub fn push_diagnostic(&self, diagnostic: Diagnostic) {
        self.diagnostics.borrow_mut().push(diagnostic);
    }

    #[must_use]
    pub fn saw_duplicate(&self) -> bool {
        *self.duplicate.borrow()
    }

    /// Take the recorded gear declaration, leaving the sink empty.
    #[must_use]
    pub fn take_gear(&self) -> Option<GearDecl> {
        self.gear.borrow_mut().take()
    }

    /// Take the recorded product intent, leaving the sink empty.
    #[must_use]
    pub fn take_product(&self) -> Option<ProductIntent> {
        self.product.borrow_mut().take()
    }

    /// Take the collected diagnostics, leaving the sink empty.
    #[must_use]
    pub fn take_diagnostics(&self) -> Diagnostics {
        std::mem::take(&mut self.diagnostics.borrow_mut())
    }
}
