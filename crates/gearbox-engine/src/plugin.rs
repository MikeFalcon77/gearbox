//! Plugin extension points and fills: declared in the description, checked here.
//!
//! **The role is declared, not read.** A host writes
//! `extension_points = [extension_point("<spec>", trait = "...")]`; a plugin
//! writes `fills = "<spec>"`. The key is the GTS spec every plugin family
//! registers instances under and the host selects by, so two points over one
//! trait stay two points (the ledger's rate provider and bss-rate-provider's
//! sources both implement `bss_ledger_sdk::RateProviderV1`).
//!
//! This used to be inferred -- a point was a `pub trait` with `Plugin` in its
//! name, a plugin a crate implementing one -- and the corpus broke that five
//! ways: proxies and built-ins implementing their host's own trait, a trait with
//! no `Plugin` in it, one crate with three gears, two points over one trait,
//! mocks in test support. So the code now only *checks* a declaration:
//!
//! - a point's spec must be a `PluginV1`-derived GTS type the gear's SDK
//!   declares, and its trait a `pub trait` in the SDK the point names
//!   (GBX0516 otherwise);
//! - a plugin's fill is joined to its host once every gear is known, in
//!   `catalogue.rs` (GBX0519 when no described gear declares the spec);
//! - the traits a plugin's crate implements are carried as evidence for a
//!   warning, never as the answer (GBX0526).
//!
//! What stays projected is what was never wrong: the `vendor`/`priority`
//! defaults each side compiles in.

use std::collections::BTreeSet;

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{
    Diagnostic, DiagnosticCode, Diagnostics, ExtensionPointDecl, GtsTypeDecl, Location, PluginFill,
};
use gearbox_project::RustFile;

/// The GTS base every plugin spec derives from.
///
/// A description writes only a spec's own segment; the catalogue stores the
/// full chain, which is also what makes the declaration a check that the type
/// really is a plugin spec rather than any GTS type the SDK happens to declare.
pub const PLUGIN_BASE: &str = "cf.toolkit.plugins.plugin.v1~";

/// The plugin half of one gear's projection.
#[derive(Debug, Default)]
pub struct PluginProjection {
    /// Points this gear lets plugins fill, each checked against its SDK.
    pub extension_points: Vec<ExtensionPointDecl>,
    /// The point this gear fills, if it is a plugin. `point` is `None` here and
    /// set by the catalogue once the host is known.
    pub fills: Option<PluginFill>,
    /// The vendor string this gear's config selects by. Hosts only.
    pub vendor_selector: Option<String>,
    /// The traits this gear's own files implement outside tests; evidence for
    /// the GBX0526 check, never the source of the role.
    pub implemented: BTreeSet<String>,
}

/// Where a point's trait is looked for: the crate, already scanned.
pub struct TraitSdk<'a> {
    pub record: &'a gearbox_gdl::records::CargoRecord,
    pub files: &'a [RustFile],
}

/// Project the plugin facts for one gear.
///
/// `files` is the gear's own crate, narrowed to what this gear owns when the
/// crate declares several; `gts_types` are those its own SDK declares.
/// `trait_sdks` is aligned with `decl.extension_points`: where each point's
/// trait lives -- the point's own `sdk` when it names one, the gear's otherwise
/// -- or `None` when that crate could not be read, which the caller has
/// already reported.
pub fn project(
    identity: &FileIdentity,
    decl: &GearDecl,
    files: &[RustFile],
    gts_types: &[GtsTypeDecl],
    trait_sdks: &[Option<TraitSdk<'_>>],
    diagnostics: &mut Diagnostics,
) -> PluginProjection {
    let uri = identity.uri.as_str();
    let own_default = gearbox_project::project_vendor_default(files);

    let mut extension_points = Vec::new();
    for (index, point) in decl.extension_points.iter().enumerate() {
        let at = Location::or_file(point.declared_at.as_ref(), uri);
        let spec = format!("{PLUGIN_BASE}{}", point.spec);

        if decl.sdk.is_none() {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::PluginPointUndetermined,
                    format!(
                        "`extension_point(\"{}\")` needs `sdk = cargo(...)` on this gear: the \
                         spec is checked against the GTS types that SDK declares",
                        point.spec
                    ),
                    "add the gear's own `sdk = cargo(...)` locator",
                )
                .at(at),
            );
            continue;
        }
        if !gts_types.iter().any(|t| t.type_id == spec) {
            let known: Vec<&str> = gts_types
                .iter()
                .filter_map(|t| t.type_id.strip_prefix(PLUGIN_BASE))
                .collect();
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::PluginPointUndetermined,
                    format!(
                        "`extension_point(\"{}\")` names no plugin spec this gear's sdk declares; \
                         {}",
                        point.spec,
                        if known.is_empty() {
                            "it declares none derived from `PluginV1`".to_owned()
                        } else {
                            format!("it declares: {}", known.join(", "))
                        }
                    ),
                    "write the segment of a `#[gts_type_schema(base = PluginV1, ...)]` type in \
                     the gear's sdk",
                )
                .at(at),
            );
            continue;
        }

        let Some(sdk) = trait_sdks.get(index).and_then(Option::as_ref) else {
            continue;
        };
        let traits = gearbox_project::public_traits(sdk.files);
        let ident = point
            .trait_ident
            .rsplit("::")
            .next()
            .unwrap_or(&point.trait_ident);
        if !traits.contains(ident) {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::PluginPointUndetermined,
                    format!(
                        "`extension_point(\"{}\", trait = \"{}\")` names no `pub trait` in `{}`",
                        point.spec, point.trait_ident, sdk.record.crate_name
                    ),
                    if point.sdk.is_some() {
                        "check the trait's spelling, or the point's `sdk = cargo(...)`".to_owned()
                    } else {
                        "check the trait's spelling; a trait in another crate needs `sdk = \
                         cargo(...)` on the extension_point"
                            .to_owned()
                    },
                )
                .at(at),
            );
            continue;
        }

        // `path` as written is relative to the description; the catalogue
        // records it relative to the source root, like every other locator.
        let sdk_ref = crate::merge::cargo_ref(
            sdk.record,
            &identity.gdl_path.parent(),
            "extension_point.sdk",
            uri,
            diagnostics,
        );
        extension_points.push(ExtensionPointDecl {
            spec,
            trait_ident: ident.to_owned(),
            sdk_lib: sdk.record.lib_ident.clone(),
            sdk: sdk_ref,
        });
    }

    let fill = decl.fills.as_ref().map(|segment| PluginFill {
        spec: format!("{PLUGIN_BASE}{segment}"),
        point: None,
        default_vendor: own_default.vendor.clone(),
        default_priority: own_default.priority,
    });

    // A selector only on a gear that is purely a host. A gear that is both --
    // bss-rate-provider -- has one config and two vendors in it, one it
    // registers under and one it selects by, and nothing in the declaration yet
    // says which field is which. Reporting the wrong one as the selector would
    // make the vendor-match check wrong, so it reports none.
    let vendor_selector = (!extension_points.is_empty() && fill.is_none())
        .then(|| own_default.vendor.clone())
        .flatten();

    PluginProjection {
        extension_points,
        fills: fill,
        vendor_selector,
        implemented: gearbox_project::implemented_traits(files),
    }
}
