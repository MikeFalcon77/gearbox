//! Checking declared crate identity against the crate's own `Cargo.toml` (GBX0209).
//!
//! `crate_name` and `lib` are the two facts a description declares about a crate
//! that ADR-0002 does *not* project, for a reason worth restating: no Rust
//! attribute states them. They come from a manifest, and a manifest is not
//! source the gear macro can see. So they are declared -- and a declared fact
//! with a single external authority is exactly the shape a cross-check is for.
//!
//! The failure this catches is quiet and late. A wrong `lib` produces a
//! generated `use <ident> as _;` line that does not compile, and the error
//! surfaces in `cargo build` output about a crate the reader did not write, long
//! after the description that caused it. A wrong `crate_name` produces a
//! `[dependencies]` entry that cannot resolve.
//!
//! Every `cargo(...)` in a description is checked, not just `package`. The `sdk`
//! records matter as much: their `lib_ident` is what attributes a GTS type to
//! its owning crate and what names an extension point's home, so a wrong one
//! there misfiles facts rather than failing to link.

use std::path::Path;

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_gdl::records::CargoRecord;
use gearbox_ir::{Diagnostic, DiagnosticCode, Diagnostics, Location};

use crate::scans::CrateScans;
use crate::source::SourceRoot;

/// One `cargo(...)` in a description, with the field it came from.
///
/// The label is not decoration: a description may hold five of these, and
/// "declared `lib` does not match" is unactionable without saying which one.
struct DeclaredCrate<'a> {
    field: String,
    record: &'a CargoRecord,
}

/// Every `cargo(...)` a gear description contains.
///
/// Collected in one place rather than checked where each is used, so a field
/// added later has one obvious spot to be added to.
fn declared_crates(decl: &GearDecl) -> Vec<DeclaredCrate<'_>> {
    let mut out = Vec::new();
    if let Some(package) = decl.package.as_ref() {
        out.push(DeclaredCrate {
            field: "package".to_owned(),
            record: package,
        });
    }
    if let Some(sdk) = decl.sdk.as_ref() {
        out.push(DeclaredCrate {
            field: "sdk".to_owned(),
            record: sdk,
        });
    }
    for provide in &decl.provides {
        out.push(DeclaredCrate {
            field: format!("provide(contract = \"{}\").sdk", provide.contract),
            record: &provide.sdk,
        });
    }
    for consume in &decl.consumes {
        out.push(DeclaredCrate {
            field: format!("consume(contract = \"{}\").sdk", consume.contract),
            record: &consume.sdk,
        });
    }
    for plugin in &decl.cluster_plugins {
        out.push(DeclaredCrate {
            field: "cluster_plugin.package".to_owned(),
            record: &plugin.package,
        });
    }
    for point in &decl.extension_points {
        if let Some(sdk) = point.sdk.as_ref() {
            out.push(DeclaredCrate {
                field: format!("extension_point(\"{}\").sdk", point.spec),
                record: sdk,
            });
        }
    }
    out
}

/// Report GBX0209 for every declared crate whose manifest disagrees.
///
/// A crate whose *source* cannot be read is not reported here: that failure is
/// already reported where the crate is scanned, with the advice about `path`
/// that belongs to it, and saying it twice would make one mistake look like two.
///
/// A crate whose source reads fine and whose `Cargo.toml` does not is a
/// different case, and it used to be skipped in silence -- so a crate with a
/// missing or malformed manifest passed validation with its identity check
/// quietly not run. Nobody else reports that one, so it is reported here.
pub fn check(
    root: &SourceRoot,
    identity: &FileIdentity,
    decl: &GearDecl,
    scans: &mut CrateScans,
    diagnostics: &mut Diagnostics,
) {
    for declared in declared_crates(decl) {
        let dir = match crate::merge::crate_dir(
            root,
            &identity.gdl_path,
            &declared.record.path,
            &declared.record.crate_name,
        ) {
            Ok(dir) => dir,
            Err(e) => {
                diagnostics.push(crate::merge::bad_crate_path(
                    &identity.uri,
                    &declared.field,
                    &declared.record.path,
                    &e,
                    declared.record.declared_at.as_ref(),
                ));
                continue;
            }
        };

        let manifest = match scans.manifest(&dir) {
            Ok(manifest) => manifest,
            Err(e) => {
                if scans.get(&dir).is_ok() {
                    diagnostics.push(
                        Diagnostic::error(
                            DiagnosticCode::ValidateLibIdentMismatch,
                            format!(
                                "`{}` points at a crate whose `Cargo.toml` cannot be read, so \
                                 its declared identity could not be checked: {e}",
                                declared.field
                            ),
                            "cargo reads the same manifest; a crate whose source is present \
                             and whose manifest is not will fail the build rather than the \
                             description",
                        )
                        .at(Location::or_file(
                            declared.record.declared_at.as_ref(),
                            &identity.uri,
                        ))
                        .with_evidence(evidence(&dir)),
                    );
                }
                continue;
            }
        };

        if declared.record.crate_name != manifest.package_name {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ValidateLibIdentMismatch,
                    format!(
                        "`{}` declares `crate_name = \"{}\"`, but that crate's manifest says \
                         `name = \"{}\"`",
                        declared.field, declared.record.crate_name, manifest.package_name
                    ),
                    format!(
                        "set `crate_name = \"{}\"`; a generated `[dependencies]` entry spells \
                         the package name, and the declared one cannot resolve",
                        manifest.package_name
                    ),
                )
                .at(Location::or_file(
                    declared.record.declared_at.as_ref(),
                    &identity.uri,
                ))
                .with_evidence(evidence(&dir)),
            );
        }

        if declared.record.lib_ident != manifest.lib_ident {
            diagnostics.push(
                Diagnostic::error(
                    DiagnosticCode::ValidateLibIdentMismatch,
                    format!(
                        "`{}` declares `lib = \"{}\"`, but that crate links as `{}`",
                        declared.field, declared.record.lib_ident, manifest.lib_ident
                    ),
                    help_for_lib(&manifest),
                )
                .at(Location::or_file(
                    declared.record.declared_at.as_ref(),
                    &identity.uri,
                ))
                .with_evidence(evidence(&dir)),
            );
        }
    }
}

/// The advice differs by *why* the identifier is what it is.
///
/// With an explicit `[lib] name` the description simply copied the wrong string.
/// Without one, the identifier comes from the package name -- and the mistake is
/// almost always deriving it from the directory instead, which is the trap
/// `cf-api-contracts` sits in: it links as `cf_api_contracts`, not
/// `api_contracts`.
fn help_for_lib(manifest: &gearbox_project::CrateManifest) -> String {
    if manifest.lib_is_explicit {
        format!(
            "set `lib = \"{}\"` to match the crate's `[lib] name`",
            manifest.lib_ident
        )
    } else {
        format!(
            "set `lib = \"{}\"`; the crate has no `[lib]` section, so Cargo derives the \
             identifier from the package name `{}` and the directory name has no say in it",
            manifest.lib_ident, manifest.package_name
        )
    }
}

fn evidence(dir: &Path) -> String {
    format!("{}/Cargo.toml", dir.display())
}
