//! Merging a gear's declared configuration curation with its projected fields.
//!
//! The two halves are deliberately unequal. Rust states what the fields *are* --
//! name, type, whether required, what they default to -- and ADR
//! `cpt-gearbox-adr-macro-projected-catalogue` gives Rust every fact Rust
//! already expresses. The description contributes the one judgement Rust has no
//! way to hold: which of those fields is worth putting in front of an
//! integrator, and in what order. `ApiGatewayConfig` declares fourteen fields
//! and the configuration files in the tree set five.
//!
//! **`exposes` is checked, not trusted.** It names Rust facts, so it can drift
//! from them, and a list that silently stopped matching would show controls for
//! keys the gear no longer reads. Naming a field the struct does not declare is
//! `GBX0212`. That check is the whole reason a curated list is not a second copy
//! of the struct.

use gearbox_gdl::GearDecl;
use gearbox_gdl::engine::FileIdentity;
use gearbox_ir::{
    ConfigFieldDecl, ConfigSchema, Diagnostic, DiagnosticCode, Diagnostics, Location,
};
use gearbox_project::{ConfigRootError, RustFile};

/// Build the configuration surface for one gear, or `None` if it declares none.
///
/// `files` is the gear's own crate, already scanned for the gear attribute, so
/// this costs no extra I/O and no second `syn` parse -- one more walk of an AST
/// that is already in memory.
pub fn project(
    identity: &FileIdentity,
    decl: &GearDecl,
    files: &[RustFile],
    diagnostics: &mut Diagnostics,
) -> Option<ConfigSchema> {
    let declared = decl.config_schema.as_ref()?;
    let uri = identity.uri.as_str();

    let root = match declared.rust.clone() {
        Some(named) => named,
        // Not declared, so find it: the single `ctx.config*()` call in
        // `impl Gear::init` is the only machine-readable link between a gear and
        // its config type -- the `Gear` trait has no associated `Config`.
        None => match gearbox_project::project_config_root(files) {
            Ok(Some(found)) => found,
            Ok(None) => {
                report(
                    diagnostics,
                    uri,
                    "`config_schema` is declared but this crate deserializes no configuration"
                        .to_owned(),
                    "drop `config_schema`, or name the struct with `config(rust = \"...\")` if \
                     the gear reads it somewhere this cannot see",
                );
                return None;
            }
            Err(ConfigRootError::Ambiguous { roots }) => {
                report(
                    diagnostics,
                    uri,
                    format!(
                        "this crate deserializes {} different types as its configuration: {}",
                        roots.len(),
                        roots.join(", ")
                    ),
                    "name the one this gear uses with `config(rust = \"...\")`",
                );
                return None;
            }
        },
    };

    let projected = gearbox_project::project_config_fields(files, &root);
    if projected.is_empty() {
        report(
            diagnostics,
            uri,
            format!("`{root}` declares no configuration fields, or this crate does not declare it"),
            "check the struct name against the crate; `config_schema` is a locator, not a path",
        );
        return None;
    }

    // The declared order, because `exposes` is an ordering as much as a filter:
    // an operator reads `bind_addr` before `prefix_path` because the description
    // said so, not because the struct happens to list it first.
    let fields = declared
        .exposes
        .iter()
        .filter_map(|name| {
            let Some(field) = projected.iter().find(|f| &f.name == name) else {
                diagnostics.push(
                    Diagnostic::error(
                        DiagnosticCode::ValidateConfigFieldUnknown,
                        format!("`{root}` declares no configuration field `{name}`"),
                        format!(
                            "the fields it declares are: {}",
                            projected
                                .iter()
                                .map(|f| f.name.as_str())
                                .collect::<Vec<_>>()
                                .join(", ")
                        ),
                    )
                    .at(Location::file(uri.to_owned())),
                );
                return None;
            };
            Some(ConfigFieldDecl {
                name: field.name.clone(),
                ty: field.ty.clone(),
                required: field.required,
                default: field.default.clone(),
                doc: field.doc.clone(),
                secret: field.secret,
            })
        })
        .collect();

    Some(ConfigSchema { rust: root, fields })
}

fn report(diagnostics: &mut Diagnostics, uri: &str, message: String, help: &str) {
    diagnostics.push(
        Diagnostic::error(DiagnosticCode::GdlConfigStructNotFound, message, help)
            .at(Location::file(uri.to_owned())),
    );
}
