//! Assembling plugin extension points from the SDK crate a description locates.
//!
//! Thin, like `cluster.rs`: `gearbox-project` answers questions about a parsed
//! crate, and this decides which crates to parse. The one declared input is
//! `sdk = cargo(...)` -- nothing in a gear's own crate says where its SDK lives,
//! and the SDK is what declares the plugin-API traits.
//!
//! A gear's role follows from what it implements, not from what it is called:
//!
//! - implements one of its SDK's plugin traits -> it is a **plugin**, and that
//!   point is what it fills;
//! - implements none -> it is a **host**, and those points are what it expects.
//!
//! Both sides name the same SDK crate, which is what lets a host and its plugins
//! join on a trait ident rather than on a naming convention.

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{
    Diagnostic, DiagnosticCode, Diagnostics, ExtensionPointDecl, Location, PluginFill,
};
use gearbox_project::{PluginImplError, RustFile};

/// The plugin half of one gear's projection.
#[derive(Debug, Default)]
pub struct PluginProjection {
    /// Points this gear expects an implementation for.
    pub extension_points: Vec<ExtensionPointDecl>,
    /// The point this gear fills, if it is a plugin.
    pub fills: Option<PluginFill>,
    /// The vendor string this gear's config selects by. Hosts only.
    pub vendor_selector: Option<String>,
}

/// Project the plugin facts for one gear.
///
/// `files` is the gear's own crate, already scanned for the gear attribute, so
/// the role check and the vendor default cost no extra I/O. The SDK costs one
/// scan, and only for gears that declare `sdk` -- which is opt-in.
pub fn project(
    identity: &FileIdentity,
    decl: &GearDecl,
    files: &[RustFile],
    sdk_files: &[RustFile],
    diagnostics: &mut Diagnostics,
) -> PluginProjection {
    let uri = identity.uri.as_str();
    let Some(sdk) = decl.sdk.as_ref() else {
        return PluginProjection::default();
    };

    let points: Vec<ExtensionPointDecl> = gearbox_project::project_extension_points(sdk_files)
        .into_iter()
        .map(|p| ExtensionPointDecl {
            trait_ident: p.trait_ident,
            sdk_lib: sdk.lib_ident.clone(),
        })
        .collect();

    // Which point, if any, this gear implements. The escape hatch is consulted
    // only when reading fails, so a description cannot override what the code
    // plainly says.
    let filled = match gearbox_project::project_plugin_impl(files, &to_project_points(&points)) {
        Ok(found) => found,
        Err(PluginImplError::Ambiguous { points: many }) => {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::PluginPointUndetermined,
                    format!(
                        "this crate implements more than one plugin interface ({}), so which \
                         extension point it fills has no single answer",
                        many.join(", ")
                    ),
                    "split the implementations into separate plugin crates, or narrow with \
                     `plugin_interface = \"...\"`",
                )
                .at(Location::file(uri.to_owned())),
            );
            declared_interface(decl, &points, uri, diagnostics)
        }
        Err(PluginImplError::NotFound { .. }) => {
            declared_interface(decl, &points, uri, diagnostics)
        }
    };

    // A declared interface that reading did not confirm is still checked against
    // the SDK, so a typo cannot invent a point.
    let filled = filled.or_else(|| {
        decl.plugin_interface
            .as_ref()
            .and_then(|_| declared_interface(decl, &points, uri, diagnostics))
    });

    let own_default = gearbox_project::project_vendor_default(files);

    let Some(trait_ident) = filled else {
        // A host: it expects these points rather than filling one. Only a gear
        // that actually has points has a selector; otherwise a stray `vendor`
        // field would look like one.
        let vendor_selector = (!points.is_empty()).then_some(own_default.vendor).flatten();
        return PluginProjection {
            extension_points: points,
            fills: None,
            vendor_selector,
        };
    };

    let point = points
        .iter()
        .find(|p| p.trait_ident == trait_ident)
        .cloned()
        .unwrap_or(ExtensionPointDecl {
            trait_ident,
            sdk_lib: sdk.lib_ident.clone(),
        });

    PluginProjection {
        // A plugin does not expect the point it fills.
        extension_points: points.into_iter().filter(|p| *p != point).collect(),
        fills: Some(PluginFill {
            point,
            default_vendor: own_default.vendor,
            default_priority: own_default.priority,
        }),
        vendor_selector: None,
    }
}

/// Resolve `plugin_interface = "..."` against the points the SDK declares.
///
/// Declared, but never trusted: a name no `pub trait` backs is refused with the
/// candidates listed, which is what stops the declaration becoming a second
/// source of truth.
fn declared_interface(
    decl: &GearDecl,
    points: &[ExtensionPointDecl],
    uri: &str,
    diagnostics: &mut Diagnostics,
) -> Option<String> {
    let declared = decl.plugin_interface.as_ref()?;
    // Accept either the bare ident or a qualified path ending in it.
    let ident = declared.rsplit("::").next().unwrap_or(declared);

    if points.iter().any(|p| p.trait_ident == ident) {
        return Some(ident.to_owned());
    }

    let known = if points.is_empty() {
        "the sdk crate declares no plugin interface at all".to_owned()
    } else {
        format!(
            "the sdk crate declares: {}",
            points
                .iter()
                .map(|p| p.trait_ident.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    diagnostics.push(
        Diagnostic::error(
            DiagnosticCode::PluginPointUndetermined,
            format!("`plugin_interface = \"{declared}\"` names no trait in the sdk; {known}"),
            "name a plugin interface the sdk crate actually declares, or drop the field and \
             let the `impl` be read",
        )
        .at(Location::file(uri.to_owned())),
    );
    None
}

fn to_project_points(points: &[ExtensionPointDecl]) -> Vec<gearbox_project::ExtensionPoint> {
    points
        .iter()
        .map(|p| gearbox_project::ExtensionPoint {
            trait_ident: p.trait_ident.clone(),
            relative: std::path::PathBuf::new(),
            line: 1,
        })
        .collect()
}
